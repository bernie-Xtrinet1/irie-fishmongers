import { randomUUID } from 'crypto';

import {
  cartIndexKey,
  productIndexKey,
  productSuspectKey,
  productTotalKey,
  reservationHashKey,
  reservationKey,
} from '../../inventory/constants/inventory.constants';
import { CheckoutReservationStateService } from '../../inventory/services/checkout-reservation-state.service';
import { RedisService } from '../../../common/redis/redis.service';
import {
  RecoveryFixture,
  ensureMode,
  forceLegacyMode,
  setUpRecoveryFixture,
  tearDownRecoveryFixture,
  unresolvedReleaseMarker,
  unresolvedReserveMarker,
} from './cart-reservation-sync-recovery-test-helpers';

// Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen plan). Real Postgres +
// real Redis proof of the frozen four-mode matrix: negative-authority
// proofs (each mode's recovery touches ONLY its own system), the
// PRODUCT_SUSPECT observation with continued blocking under CART_SCOPED, a
// genuine CHECKOUT_IN_PROGRESS retry, and the DRAINING reserve/release
// policy. Mode-transition races (REQUEUED_MODE_CHANGED, legal ABA) live in
// the sibling cart-reservation-sync-recovery-mode-race.postgres.integration.spec.ts.
// ensureMode/forceLegacyMode (shared - see the test-helpers file's own
// comment) guarantee this file can never leak a non-LEGACY mode into any
// other test file sharing the same --runInBand process.
jest.setTimeout(30_000);

describe('CartReservationSyncRecoveryService CART_SCOPED/LEGACY/MIRROR/DRAINING (real Postgres + Redis)', () => {
  let fixture: RecoveryFixture;

  beforeAll(async () => {
    fixture = await setUpRecoveryFixture('recovery-cart-scoped');
    await forceLegacyMode(fixture);
  });

  afterAll(async () => {
    await forceLegacyMode(fixture);
    await tearDownRecoveryFixture(fixture);
  });

  it('1. CART_SCOPED reserve recovery changes only the cart-scoped total - the legacy hash is never touched', async () => {
    await ensureMode(fixture, 'CART_SCOPED');
    const { cartId, productId, markerId } = await unresolvedReserveMarker(fixture, 5);

    const outcome = await fixture.recoveryService.reconcileOne(markerId, new Date());

    expect(outcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId });
    expect(await fixture.redisClient.get(productTotalKey(productId))).toBe('5');
    expect(await fixture.redisClient.hget(reservationHashKey(productId), cartId)).toBeNull();
  });

  it('2. CART_SCOPED release recovery changes only the cart-scoped total - the legacy hash is never touched', async () => {
    await ensureMode(fixture, 'CART_SCOPED');
    const { cartId, productId, markerId } = await unresolvedReleaseMarker(fixture, 4);
    // Seed a genuine cart-scoped hold first, matching the marker's
    // "release" desired state against a real prior reservation.
    await fixture.inventoryReservations.reserveOrRenew(cartId, productId, fixture.customerId, 4);

    const outcome = await fixture.recoveryService.reconcileOne(markerId, new Date());

    expect(outcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId });
    expect(await fixture.redisClient.get(productTotalKey(productId))).toBe('0');
    expect(await fixture.redisClient.hget(reservationHashKey(productId), cartId)).toBeNull();
  });

  it('3. LEGACY recovery changes only the legacy hash - the cart-scoped engine is never touched', async () => {
    await ensureMode(fixture, 'LEGACY');
    const { cartId, productId, markerId } = await unresolvedReserveMarker(fixture, 3);

    const outcome = await fixture.recoveryService.reconcileOne(markerId, new Date());

    expect(outcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId });
    const raw = await fixture.redisClient.hget(reservationHashKey(productId), cartId);
    expect(raw).not.toBeNull();
    expect((JSON.parse(raw!) as { quantity: number }).quantity).toBe(3);
    expect(await fixture.redisClient.get(productTotalKey(productId))).toBeNull();
  });

  it('4. MIRROR recovery repairs only the authoritative legacy side - reconcileOne itself never calls the cart-scoped primitives', async () => {
    await ensureMode(fixture, 'MIRROR');
    const { cartId, productId, markerId } = await unresolvedReserveMarker(fixture, 6);

    const reserveOrRenewSpy = jest.spyOn(fixture.inventoryReservations, 'reserveOrRenew');
    const releaseReservationSpy = jest.spyOn(fixture.inventoryReservations, 'releaseReservation');

    const outcome = await fixture.recoveryService.reconcileOne(markerId, new Date());

    expect(outcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId });
    const raw = await fixture.redisClient.hget(reservationHashKey(productId), cartId);
    expect((JSON.parse(raw!) as { quantity: number }).quantity).toBe(6);
    // DA.1B's own recovery write never touches the cart-scoped engine in
    // MIRROR - that is C4 compensation's exclusive responsibility.
    expect(reserveOrRenewSpy).not.toHaveBeenCalled();
    expect(releaseReservationSpy).not.toHaveBeenCalled();
    reserveOrRenewSpy.mockRestore();
    releaseReservationSpy.mockRestore();
  });

  it('5. PRODUCT_SUSPECT observation preserves physical state and remains blocked', async () => {
    await ensureMode(fixture, 'CART_SCOPED');
    const { cartId, productId, markerId } = await unresolvedReserveMarker(fixture, 4);
    await fixture.redisClient.set(productSuspectKey(productId), '1');

    const blocked = await fixture.recoveryService.reconcileOne(markerId, new Date());
    expect(blocked).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', markerId });
    const blockedRow = await fixture.syncStateRepository.findById(markerId);
    expect(blockedRow?.status).toBe('BLOCKED');
    expect(blockedRow?.blockReason).toBe('PRODUCT_SUSPECT');
    expect(blockedRow?.nextAttemptAt).not.toBeNull();

    Object.assign(fixture.inventoryReservations, { observationPrisma: fixture.prisma });
    const originalObserve = fixture.inventoryReservations.observeProductReservations.bind(fixture.inventoryReservations);
    let observation: ReturnType<typeof originalObserve> | undefined;
    const observe = jest.spyOn(fixture.inventoryReservations, 'observeProductReservations').mockImplementation((...args) => {
      observation = originalObserve(...args);
      return observation;
    });
    const snapshot = async () => ({
      entry: await fixture.redisClient.get(reservationKey(cartId, productId)),
      total: await fixture.redisClient.get(productTotalKey(productId)),
      suspect: await fixture.redisClient.get(productSuspectKey(productId)),
      products: (await fixture.redisClient.smembers(cartIndexKey(cartId))).sort(),
      carts: (await fixture.redisClient.smembers(productIndexKey(productId))).sort(),
    });
    const before = await snapshot();
    const now = new Date();
    const result = await fixture.blockedRecheckService.recheckBlocked(markerId, now);
    expect(result).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', markerId });
    expect(observe).toHaveBeenCalledWith(productId, [cartId]);
    expect(observation).toBeDefined();
    await expect(observation).resolves.toMatchObject({
      authority: 'NONE',
      physicalConvergenceProven: false,
    });
    expect(await snapshot()).toEqual(before);
    const after = await fixture.syncStateRepository.findById(markerId);
    expect(after?.status).toBe('BLOCKED');
    expect(after?.blockReason).toBe('PRODUCT_SUSPECT');
    expect(after?.attemptCount).toBe(blockedRow?.attemptCount);
    expect(after?.nextAttemptAt?.getTime()).toBeGreaterThan(now.getTime());
    expect(after?.resolvedAt).toBeNull();
    observe.mockRestore();
  });

  it('6. a genuine RESERVATION_CHECKOUT_IN_PROGRESS is retried, not blocked, and succeeds once checkout clears', async () => {
    await ensureMode(fixture, 'CART_SCOPED');
    const { cartId, productId, markerId } = await unresolvedReserveMarker(fixture, 7);
    const customerId = fixture.customerId;
    // checkoutMark validates its plan against an already-ACTIVE cart-scoped
    // reservation - it never creates one itself.
    await fixture.inventoryReservations.reserveOrRenew(cartId, productId, customerId, 7);

    const redisService = new RedisService(fixture.redisClient);
    const checkoutState = new CheckoutReservationStateService(redisService);
    const marked = await checkoutState.checkoutMark(
      cartId,
      customerId,
      randomUUID(),
      [{ productId, expectedQuantity: 7 }],
      Date.now(),
      900,
    );
    expect(marked.ok).toBe(true);

    const retried = await fixture.recoveryService.reconcileOne(markerId, new Date());
    expect(retried).toEqual({ outcome: 'REQUEUED_RETRYABLE_FAILURE', markerId });
    const rowAfterRetry = await fixture.syncStateRepository.findById(markerId);
    expect(rowAfterRetry?.status).toBe('PENDING'); // never BLOCKED for this reason

    // A genuinely active checkout is authoritative right now - recovery
    // must not force-overwrite it. Directly clearing the checkout-pending
    // hold here (never finalized) simulates it ending; the very next
    // attempt then converges.
    await fixture.redisClient.del(reservationKey(cartId, productId));
    await fixture.redisClient.srem(cartIndexKey(cartId), productId);
    await fixture.redisClient.srem(productIndexKey(productId), cartId);
    await fixture.redisClient.set(productTotalKey(productId), '0');

    const converged = await fixture.recoveryService.reconcileOne(markerId, new Date());
    expect(converged).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId });
  });

  describe('DRAINING policy', () => {
    it('7. release-shaped recovery is always allowed while DRAINING', async () => {
      await ensureMode(fixture, 'CART_SCOPED');
      const { cartId, productId, markerId } = await unresolvedReleaseMarker(fixture, 2);
      await fixture.inventoryReservations.reserveOrRenew(cartId, productId, fixture.customerId, 2);

      await fixture.modeService.setMode({ targetMode: 'DRAINING', updatedById: fixture.adminUserId });

      const outcome = await fixture.recoveryService.reconcileOne(markerId, new Date());

      expect(outcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId });
      expect(await fixture.redisClient.get(productTotalKey(productId))).toBe('0');
    });

    it('8. reserve-shaped recovery is BLOCKED(MODE_NOT_ADMITTING) while DRAINING, with zero writes attempted', async () => {
      // The marker must already exist BEFORE DRAINING starts - CartService's
      // own admission gate makes it structurally impossible to create a new
      // positive-desiredQuantity marker while DRAINING is already active
      // (see the DA.4B frozen plan's DRAINING policy rationale).
      await ensureMode(fixture, 'CART_SCOPED');
      const { productId, markerId } = await unresolvedReserveMarker(fixture, 5);
      await fixture.modeService.setMode({ targetMode: 'DRAINING', updatedById: fixture.adminUserId });

      const outcome = await fixture.recoveryService.reconcileOne(markerId, new Date());

      expect(outcome).toEqual({ outcome: 'BLOCKED_MODE_NOT_ADMITTING', markerId });
      expect(await fixture.redisClient.get(productTotalKey(productId))).toBeNull();
    });
  });
});
