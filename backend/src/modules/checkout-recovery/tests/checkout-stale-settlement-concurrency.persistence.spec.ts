import { openOrdinarySchema, staleFixture } from './checkout-stale-settlement-test-helpers';
import { CheckoutRecoverySettlementRepository } from '../repositories/checkout-recovery-settlement.repository';
import { CheckoutSettlementRepository } from '../../reservation-fence/repositories/checkout-settlement.repository';
import { ReservationFenceRepository } from '../../reservation-fence/repositories/reservation-fence.repository';

describe('Stale settlement concurrency (PostgreSQL only)', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>>;
  beforeAll(async () => { schema = await openOrdinarySchema(); });
  afterAll(async () => { if (schema) await schema.close(); });

  it('independent workers allocate one terminal replay and rediscover it after process loss', async () => {
    const f = await staleFixture(schema.db), other = schema.fresh();
    try {
      const fences = new ReservationFenceRepository(other), manifests = new CheckoutSettlementRepository(other, fences);
      const fresh = new CheckoutRecoverySettlementRepository(other, fences, manifests, f.evidence);
      const results = await Promise.all([f.repository.authorizeStaleRecoverySettlement(f.candidate), fresh.authorizeStaleRecoverySettlement(f.candidate)]);
      expect(results).toEqual([{ code: 'AUTHORIZED', manifestId: f.manifest.id }, { code: 'AUTHORIZED', manifestId: f.manifest.id }]);
      const before = await manifests.find(f.manifest.id);
      expect(await fresh.findPendingStaleSettlementsPage({ afterManifestId: null, limit: 100 })).toContainEqual({ id: f.manifest.id });
      expect(await fresh.authorizeStaleRecoverySettlement(f.candidate)).toEqual(results[0]);
      expect((await manifests.find(f.manifest.id))!.settlementReplayId).toBe(before!.settlementReplayId);
      expect(await other.checkoutReservationSettlement.count({ where: { attemptId: f.attempt.id } })).toBe(1);
    } finally { await other.$disconnect(); }
  });
  it('order commit wins the fence lock: recovery preserves committed order/payment and W6', async () => {
    const f = await staleFixture(schema.db);
    await f.fences.locked(async tx => {
      const order = await tx.order.create({ data: { customerId: f.customerId, deliveryAddressLine1: 'Fixture',
        deliveryParish: 'KINGSTON', deliveryPhone: 'fixture' } });
      await tx.payment.create({ data: { orderId: order.id, provider: 'CASH_ON_DELIVERY', status: 'PAID', amount: 42 } });
      await tx.checkoutAttempt.update({ where: { id: f.attempt.id }, data: { status: 'COMMITTED', orderId: order.id } });
      await f.manifests.markFinalizePending(tx, f.manifest.id);
    });
    const before = await f.manifests.find(f.manifest.id);
    expect(await f.repository.authorizeStaleRecoverySettlement(f.candidate)).toEqual({ code: 'FINALIZATION_REQUIRED' });
    expect(await f.manifests.find(f.manifest.id)).toEqual(before);
    expect(await schema.db.payment.findUnique({ where: { orderId: before!.attempt.orderId! } })).toMatchObject({ status: 'PAID' });
  });
  it('heartbeat committed after discovery invalidates H0 even if it remains stale', async () => {
    const f = await staleFixture(schema.db), other = schema.fresh();
    try {
      await other.checkoutAttempt.update({ where: { id: f.attempt.id },
        data: { lastHeartbeatAt: new Date(f.candidate.observedHeartbeatAt.getTime() + 1) } });
      expect(await f.repository.authorizeStaleRecoverySettlement(f.candidate)).toEqual({ code: 'DEFERRED' });
      expect((await f.manifests.find(f.manifest.id))!.state).toBe('ACQUIRED');
    } finally { await other.$disconnect(); }
  });
});
