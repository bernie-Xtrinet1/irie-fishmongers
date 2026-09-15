import { randomUUID } from 'crypto';
import { RedisService } from '../../../common/redis/redis.service';
import { openAcquisitionSchema } from '../../checkout/services/checkout-acquisition-test-helpers';
import { seedCartAndProduct, setUpCompensationFixture } from '../../mirror-compensation/repositories/compensation-repository-test-helpers';
import { withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { connectRealRedis, cleanupKeys, trackKeysFor } from './inventory-reservations.redis-test-helpers';
import { OrdinaryReservationService } from './ordinary-reservation.service';
import { ordinaryHoldInstanceId } from '../../reservation-fence/ordinary-hold-instance-id';
import { MUTATION_HISTORY_KEY, resourceGuardKey, executionGateKey } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { ReservationFenceRepository, transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';
import { reservationKey, productTotalKey, cartIndexKey, productIndexKey } from '../constants/inventory.constants';
import { checkoutPinKey } from '../../reservation-fence/lua/checkout-settlement.lua';
import { WRITE_ORDINARY_RESERVATION } from '../lua/ordinary-reservation-lua';
import { CheckoutSettlementRepository } from '../../reservation-fence/repositories/checkout-settlement.repository';
import { CheckoutAcquisitionService } from '../../checkout/services/checkout-acquisition.service';
import { CheckoutSettlementAuthorityService } from '../../reservation-fence/services/checkout-settlement-authority.service';
import { ReservationMutationAuthorityService } from '../../reservation-fence/services/reservation-mutation-authority.service';

describe('W1 canonical creation and exact predecessor convergence', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openAcquisitionSchema>>;
  let redis: Awaited<ReturnType<typeof connectRealRedis>>;
  let fixtures: Awaited<ReturnType<typeof setUpCompensationFixture>>;
  let adapter: RedisService, service: OrdinaryReservationService;
  let tuple: ReturnType<typeof transitionTuple>;
  const keys = new Set<string>();
  beforeAll(async () => {
    schema = await openAcquisitionSchema(); redis = await connectRealRedis();
    adapter = new RedisService(redis); service = new OrdinaryReservationService(schema.prisma, adapter);
    fixtures = await setUpCompensationFixture(schema.prisma);
    const mode = await schema.prisma.reservationEngineModeConfig.create({ data: { mode: 'CART_SCOPED', updatedById: fixtures.userIds[0]! } });
    const row = await schema.prisma.reservationFenceTransition.create({ data: { incarnation: randomUUID(), epoch: 1,
      revision: 1, phase: 'OPEN', protocol: 1, status: 'ACKNOWLEDGED', acknowledgedAt: new Date(),
      mode: 'CART_SCOPED', modeRevision: mode.revision, reason: 'OPEN', actorId: randomUUID() } });
    tuple = transitionTuple(row);
    keys.add(RESERVATION_FENCE_KEY); keys.add(MUTATION_HISTORY_KEY);
    await redis.set(RESERVATION_FENCE_KEY, JSON.stringify(tuple));
    await redis.hset(MUTATION_HISTORY_KEY, 'incarnation', tuple.incarnation);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => withCleanup(async () => {}, [async () => { if (redis) await cleanupKeys(redis, keys); },
    async () => { if (redis) await redis.quit(); }, async () => { if (schema) await schema.close(); }]));
  async function fixture() {
    const ids = await seedCartAndProduct(fixtures);
    const marker = await schema.prisma.cartReservationSyncState.create({ data: { cartId: ids.cartId, productId: ids.productId,
      generation: 0, expectedQuantity: 2, expectedMutationVersion: 1 } });
    trackKeysFor(keys, ids.cartId, ids.productId); keys.add(resourceGuardKey(marker.id)); keys.add(checkoutPinKey(marker.id));
    const execute = (quantity = 2) => service.reserve(ids.cartId, ids.productId, ids.customerId, quantity);
    const entry = async () => JSON.parse((await redis.get(reservationKey(ids.cartId, ids.productId)))!) as Record<string, unknown>;
    const snapshot = () => Promise.all([reservationKey(ids.cartId, ids.productId), resourceGuardKey(marker.id),
      checkoutPinKey(marker.id), productTotalKey(ids.productId), cartIndexKey(ids.cartId), productIndexKey(ids.productId)]
      .map(async key => await redis.type(key) === 'set' ? (await redis.smembers(key)).sort() : redis.get(key)));
    return { ...ids, marker, execute, entry, snapshot };
  }
  it('creates canonical ownership, retries and renews without changing identity, then W4 accepts real W1 output', async () => {
    const f = await fixture();
    expect(await f.execute()).toMatchObject({ code: 'ACCEPTED' });
    expect(await f.entry()).toMatchObject({ status: 'ACTIVE', generation: 0, markerId: f.marker.id,
      holdInstanceId: ordinaryHoldInstanceId(f.marker.id, 0), reservationExecutionEpoch: 1 });
    expect(await f.execute()).toMatchObject({ code: 'ACCEPTED' });
    const fences = new ReservationFenceRepository(schema.prisma), manifests = new CheckoutSettlementRepository(schema.prisma, fences);
    const op = await schema.prisma.checkoutOperation.create({ data: { customerId: f.customerId, cartId: f.cartId,
      operationKey: randomUUID(), retryKeyHash: randomUUID(), selectedPath: 'CART_SCOPED', reservationExecutionEpoch: 1, reservationCapabilityState: 'ACTIVE' } });
    await schema.prisma.checkoutAttempt.create({ data: { customerId: f.customerId, cartId: f.cartId,
      idempotencyKey: op.operationKey, selectedPath: 'CART_SCOPED', reservationExecutionEpoch: 1 } });
    keys.add(executionGateKey(op.id));
    const acquire = new CheckoutAcquisitionService(schema.prisma, adapter, manifests, fences,
      new CheckoutSettlementAuthorityService(manifests, fences, adapter), new ReservationMutationAuthorityService(fences, adapter));
    expect(await acquire.acquire(f.customerId, op.id)).toMatchObject({ ok: true });
    const manifest = await schema.prisma.checkoutReservationSettlement.findFirstOrThrow({ where: { operationId: op.id } });
    keys.add(`reservation:fence:settlement-acquisition:${manifest.id}`);
  });
  it('quantity changes preserve same-generation identity and immediate advancement changes identity atomically', async () => {
    const f = await fixture(); expect(await f.execute()).toMatchObject({ code: 'ACCEPTED' });
    await schema.prisma.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { expectedQuantity: 3 } });
    expect(await f.execute(3)).toMatchObject({ code: 'ACCEPTED' });
    expect((await f.entry()).holdInstanceId).toBe(ordinaryHoldInstanceId(f.marker.id, 0));
    await schema.prisma.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 1, expectedQuantity: 4 } });
    expect(await f.execute(4)).toMatchObject({ code: 'ACCEPTED' });
    expect(await f.entry()).toMatchObject({ quantity: 4, generation: 1, holdInstanceId: ordinaryHoldInstanceId(f.marker.id, 1) });
    expect(await redis.get(productTotalKey(f.productId))).toBe('4');
  });
  it.each(['gap', 'newer', 'hold', 'marker', 'customer', 'cart', 'epoch', 'pin', 'operation', 'attempt', 'checkout-key', 'mixed'] as const)(
    '%s rejects atomically without adopting physical ownership', async fault => {
      const f = await fixture(); expect(await f.execute()).toMatchObject({ code: 'ACCEPTED' });
      const entry = await f.entry();
      if (fault === 'gap') await schema.prisma.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 2 } });
      if (fault === 'newer') {
        entry.generation = 2; entry.holdInstanceId = ordinaryHoldInstanceId(f.marker.id, 2);
        const guard = JSON.parse((await redis.get(resourceGuardKey(f.marker.id)))!) as {
          resource: { generation: number; holdInstanceId: string } };
        guard.resource.generation = 2; guard.resource.holdInstanceId = ordinaryHoldInstanceId(f.marker.id, 2);
        await redis.set(resourceGuardKey(f.marker.id), JSON.stringify(guard));
      }
      if (fault === 'hold') entry.holdInstanceId = randomUUID();
      if (fault === 'marker') entry.markerId = randomUUID();
      if (fault === 'customer') entry.customerId = randomUUID();
      if (fault === 'cart') entry.cartId = randomUUID();
      if (fault === 'epoch') entry.reservationExecutionEpoch = 2;
      if (fault === 'operation') entry.checkoutOperationId = randomUUID();
      if (fault === 'attempt') entry.checkoutAttemptId = randomUUID();
      if (fault === 'checkout-key') entry.checkoutIdempotencyKey = randomUUID();
      if (fault === 'mixed') entry.generation = 1;
      if (fault === 'pin') await redis.set(checkoutPinKey(f.marker.id), 'existing-owner');
      await redis.set(reservationKey(f.cartId, f.productId), JSON.stringify(entry));
      const before = await f.snapshot(); expect(await f.execute()).toMatchObject({ code: 'FENCE_REJECTED' });
      expect(await f.snapshot()).toEqual(before);
    });
  it.each(['DRAINING', 'FROZEN', 'RETIRED'] as const)('%s rejects positive mutation', async phase => {
    const f = await fixture();
    await redis.set(RESERVATION_FENCE_KEY, JSON.stringify({ ...tuple, phase }));
    try { const before = await f.snapshot(); expect(await f.execute()).toMatchObject({ code: 'FENCE_REJECTED' }); expect(await f.snapshot()).toEqual(before); }
    finally { await redis.set(RESERVATION_FENCE_KEY, JSON.stringify(tuple)); }
  });
  it('lost successful predecessor transition is accepted only by exact final observation', async () => {
    const f = await fixture(); expect(await f.execute()).toMatchObject({ code: 'ACCEPTED' });
    await schema.prisma.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 1, expectedQuantity: 4 } });
    const original = adapter.eval.bind(adapter);
    jest.spyOn(adapter, 'eval').mockImplementation(async (...args) => {
      const result = await original(...args); if (args[0] === WRITE_ORDINARY_RESERVATION) throw new Error('Lost response'); return result;
    });
    expect(await f.execute(4)).toMatchObject({ code: 'ACCEPTED' });
    expect(await f.entry()).toMatchObject({ generation: 1, holdInstanceId: ordinaryHoldInstanceId(f.marker.id, 1), quantity: 4 });
    expect((await schema.prisma.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } })).generation).toBe(1);
  });
  it('concurrent creates establish one owner and account quantity once', async () => {
    const f = await fixture();
    const outcomes = await Promise.all([f.execute(), f.execute()]);
    expect(outcomes.map(result => result.code)).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect(await redis.get(productTotalKey(f.productId))).toBe('2');
    expect((await f.entry()).holdInstanceId).toBe(ordinaryHoldInstanceId(f.marker.id, 0));
  });
  it.each(['accounting', 'index', 'expiry'] as const)('uncertain completion rejects contradictory %s without repair', async fault => {
    const f = await fixture();
    const original = adapter.eval.bind(adapter);
    let afterEffect: Awaited<ReturnType<typeof f.snapshot>>;
    let replay: unknown;
    jest.spyOn(adapter, 'eval').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0] !== WRITE_ORDINARY_RESERVATION) return result;
      if (fault === 'accounting') await redis.set(productTotalKey(f.productId), '0');
      if (fault === 'index') await redis.srem(cartIndexKey(f.cartId), f.productId);
      if (fault === 'expiry') {
        const entry = await f.entry(); entry.expiresAt = 1;
        await redis.set(reservationKey(f.cartId, f.productId), JSON.stringify(entry));
      }
      afterEffect = await f.snapshot();
      replay = JSON.parse(await original(...args) as string);
      throw new Error('Lost response');
    });
    expect(await f.execute()).toEqual({ code: 'INFRASTRUCTURE_FAILURE', outcome: 'UNCERTAIN' });
    expect(replay).toMatchObject({ code: 'FENCE_REJECTED' });
    expect(await f.snapshot()).toEqual(afterEffect!);
  });
  it('uncertainty before execution preserves the predecessor and retries the same durable target', async () => {
    const f = await fixture(); expect(await f.execute()).toMatchObject({ code: 'ACCEPTED' });
    await schema.prisma.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 1, expectedQuantity: 4 } });
    const original = adapter.eval.bind(adapter), before = await f.snapshot();
    const spy = jest.spyOn(adapter, 'eval').mockImplementation(async (...args) => {
      if (args[0] === WRITE_ORDINARY_RESERVATION) throw new Error('Not sent'); return original(...args);
    });
    expect(await f.execute(4)).toEqual({ code: 'INFRASTRUCTURE_FAILURE', outcome: 'UNCERTAIN' });
    expect(await f.snapshot()).toEqual(before); spy.mockRestore();
    expect(await f.execute(4)).toMatchObject({ code: 'ACCEPTED' });
    expect((await f.entry()).holdInstanceId).toBe(ordinaryHoldInstanceId(f.marker.id, 1));
    expect((await schema.prisma.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } })).generation).toBe(1);
  });
  it.each(['incarnation', 'epoch', 'productId', 'holdInstanceId'] as const)('wrong guard %s fails with zero writes', async field => {
    const f = await fixture(); expect(await f.execute()).toMatchObject({ code: 'ACCEPTED' });
    const guard = JSON.parse((await redis.get(resourceGuardKey(f.marker.id)))!) as {
      incarnation: string; epoch: number; resource: { productId: string; holdInstanceId: string } };
    if (field === 'incarnation') guard.incarnation = randomUUID();
    else if (field === 'epoch') guard.epoch = 2;
    else guard.resource[field] = randomUUID();
    await redis.set(resourceGuardKey(f.marker.id), JSON.stringify(guard));
    const before = await f.snapshot(); expect(await f.execute()).toMatchObject({ code: 'FENCE_REJECTED' });
    expect(await f.snapshot()).toEqual(before);
  });
});
