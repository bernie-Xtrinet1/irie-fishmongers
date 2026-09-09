import { randomUUID } from 'crypto';
import { RecoveryFixture, setUpRecoveryFixture, tearDownRecoveryFixture, ensureMode,
  unresolvedReserveMarker } from '../../cart-reservation-sync/services/cart-reservation-sync-recovery-test-helpers';
import { cartIndexKey, productTotalKey, reservationKey, productSuspectKey } from '../../inventory/constants/inventory.constants';
import { CheckoutReservationStateService } from '../../inventory/services/checkout-reservation-state.service';
import { RedisService } from '../../../common/redis/redis.service';
import { assertDisposableEnvironment, collectRollbackEvidence, latch, withCleanup } from './rollback-evidence-test-helpers';

jest.setTimeout(30000);
describe('G.4a drain characterization (real PostgreSQL/Redis)', () => {
  let f: RecoveryFixture;
  beforeEach(async () => {
    assertDisposableEnvironment();
    f = await setUpRecoveryFixture('g4a-drain');
    await ensureMode(f, 'CART_SCOPED');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    // Existing fixture teardown owns DB8 and UUID rows. No shared DB reset.
    if (!f) return;
    let completed = false;
    await withCleanup(async () => { await tearDownRecoveryFixture(f); completed = true; }, [
      () => f.prisma.$disconnect(),
      async () => { if (!completed && f.redisClient.status !== 'end') await f.redisClient.quit(); },
    ]);
  });
  const transition = (targetMode: 'DRAINING' | 'LEGACY') => f.modeService.setMode({ targetMode, updatedById: f.adminUserId });
  const snapshot = (cartId: string, productId: string) => collectRollbackEvidence(f.prisma, f.redisClient, {
    customerIds: [f.customerId], holds: [{ cartId, productId }],
  });
  it('M28 direct rollback is refused; DRAINING blocks reserves and permits release-shaped convergence', async () => {
    expect(await transition('LEGACY')).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    expect((await transition('DRAINING')).ok).toBe(true);
    const { cartId, productId } = await unresolvedReserveMarker(f, 2);
    const write = jest.spyOn(f.inventoryReservations, 'reserveOrRenew');
    expect(await f.recoveryTarget.converge({ cartId, productId, customerId: f.customerId, desiredQuantity: 2 })).toMatchObject({ outcome: 'BLOCKED', blockReason: 'MODE_NOT_ADMITTING' });
    expect(write).not.toHaveBeenCalled();
    expect(await f.recoveryTarget.converge({ cartId, productId, customerId: null, desiredQuantity: null })).toMatchObject({ outcome: 'CONVERGED' });
  });
  it.each(['ACTIVE', 'CHECKOUT_PENDING'])('M28/M29 %s blocks rollback; known-owner release and empty observation allow it', async status => {
    const { cartId, productId } = await unresolvedReserveMarker(f, 2);
    await f.inventoryReservations.reserveOrRenew(cartId, productId, f.customerId, 2);
    if (status === 'CHECKOUT_PENDING') expect(await new CheckoutReservationStateService(new RedisService(f.redisClient)).checkoutMark(
      cartId, f.customerId, randomUUID(), [{ productId, expectedQuantity: 2 }], Date.now(), 180)).toMatchObject({ ok: true });
    await transition('DRAINING');
    expect(await transition('LEGACY')).toMatchObject({ ok: false, code: 'ROLLBACK_BLOCKED' });
    expect((await snapshot(cartId, productId)).holds[0]!.status).toBe(status);
    // This fixture has no CheckoutAttempt/executor. Deliberate fixture release,
    // not an endorsement of releasing an unfenced production pending attempt.
    await f.inventoryReservations.releaseReservation(cartId, productId);
    expect((await transition('LEGACY')).ok).toBe(true);
  });
  it('M31 one missing structure blocks transition; Redis failure prevents a revision append', async () => {
    const { cartId, productId } = await unresolvedReserveMarker(f, 2);
    await f.inventoryReservations.reserveOrRenew(cartId, productId, f.customerId, 2);
    await transition('DRAINING');
    await f.redisClient.del(productTotalKey(productId)); // Fault in UUID-owned fixture only.
    expect(await transition('LEGACY')).toMatchObject({ ok: false, code: 'ROLLBACK_STRUCTURE_DRIFT' });
    const before = await f.modeService.getCurrentModeSnapshot();
    jest.spyOn(f.redisClient, 'scan').mockRejectedValueOnce(new Error('G4A Redis unavailable'));
    await expect(transition('LEGACY')).rejects.toThrow('G4A Redis unavailable');
    expect(await f.modeService.getCurrentModeSnapshot()).toEqual(before);
  });
  it('M31 BLOCKER-5 missing BOTH indexes/totals hides an extant reservation from the guard', async () => {
    const { cartId, productId } = await unresolvedReserveMarker(f, 2);
    await f.inventoryReservations.reserveOrRenew(cartId, productId, f.customerId, 2);
    await transition('DRAINING');
    await f.redisClient.del(cartIndexKey(cartId), productTotalKey(productId));
    expect((await transition('LEGACY')).ok).toBe(true);
    const e = await snapshot(cartId, productId);
    expect(e.mode?.mode).toBe('LEGACY'); expect(e.holds[0]).toMatchObject({ status: 'ACTIVE', indexed: 0, total: null });
    expect(e.attempts).toHaveLength(0); expect(e.orders).toHaveLength(0); expect(e.payments).toHaveLength(0);
  });
  it('M31 BLOCKER-5 malformed reservation with zero total is flagged but guard still reports clear', async () => {
    const { cartId, productId } = await unresolvedReserveMarker(f, 2);
    await f.inventoryReservations.reserveOrRenew(cartId, productId, f.customerId, 2);
    await f.redisClient.set(reservationKey(cartId, productId), '{bad-json');
    await f.redisClient.set(productTotalKey(productId), '0');
    await transition('DRAINING');
    expect((await transition('LEGACY')).ok).toBe(true);
    expect(await f.redisClient.get(productSuspectKey(productId))).not.toBeNull();
    expect((await snapshot(cartId, productId)).holds[0]!.status).toBe('MALFORMED');
  });
  it('M30 BLOCKER-1 old-mode writer completes AFTER the real guarded LEGACY commit', async () => {
    const { cartId, productId, markerId } = await unresolvedReserveMarker(f, 2);
    const entered = latch(), resume = latch();
    const reserve = f.inventoryReservations.reserveOrRenew.bind(f.inventoryReservations);
    jest.spyOn(f.inventoryReservations, 'reserveOrRenew').mockImplementationOnce(async (...args) => {
      entered.release(); await resume.promise; return reserve(...args);
    });
    const writer = f.recoveryService.reconcileOne(markerId, new Date());
    await withCleanup(async () => {
      await Promise.race([entered.promise, writer.then(() => { throw new Error('Writer finished before gate'); })]); // mode was read, external write has NOT happened.
      expect((await transition('DRAINING')).ok).toBe(true);
      expect((await snapshot(cartId, productId)).holds[0]!.status).toBe('ABSENT');
      expect((await transition('LEGACY')).ok).toBe(true);
    }, [async () => { resume.release(); await writer; }]);
    expect(await writer).toEqual({ outcome: 'REQUEUED_MODE_CHANGED', markerId });
    const e = await snapshot(cartId, productId);
    expect(e.mode?.mode).toBe('LEGACY'); expect(e.holds[0]).toMatchObject({ status: 'ACTIVE', total: '2', indexed: 1 });
    expect(await f.syncStateRepository.findById(markerId)).toMatchObject({ status: 'PENDING', resolvedAt: null });
    expect(e.attempts).toHaveLength(0); expect(e.orders).toHaveLength(0); expect(e.payments).toHaveLength(0);
  });
  it('M32 external write remains after mode revision changes; marker is requeued, not falsely resolved', async () => {
    const { cartId, productId, markerId } = await unresolvedReserveMarker(f, 2);
    const entered = latch(), resume = latch();
    const reserve = f.inventoryReservations.reserveOrRenew.bind(f.inventoryReservations);
    jest.spyOn(f.inventoryReservations, 'reserveOrRenew').mockImplementationOnce(async (...args) => {
      const result = await reserve(...args); entered.release(); await resume.promise; return result;
    });
    const writer = f.recoveryService.reconcileOne(markerId, new Date());
    await withCleanup(async () => {
      await Promise.race([entered.promise, writer.then(() => { throw new Error('Writer finished before gate'); })]);
      expect((await transition('DRAINING')).ok).toBe(true);
    }, [async () => { resume.release(); await writer; }]);
    expect(await writer).toEqual({ outcome: 'REQUEUED_MODE_CHANGED', markerId });
    expect((await snapshot(cartId, productId)).holds[0]).toMatchObject({ status: 'ACTIVE', total: '2' });
    expect(await f.syncStateRepository.findById(markerId)).toMatchObject({ resolvedAt: null });
    expect(await f.recoveryService.reconcileOne(markerId, new Date())).toEqual({ outcome: 'BLOCKED_MODE_NOT_ADMITTING', markerId });
  });
});
