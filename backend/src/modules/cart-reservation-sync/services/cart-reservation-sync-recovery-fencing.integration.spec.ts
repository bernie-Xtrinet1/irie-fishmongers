import { randomUUID } from 'crypto';

import { reservationHashKey } from '../../inventory/constants/inventory.constants';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import {
  RecoveryFixture,
  createProduct,
  installDelayedReserveSpy,
  setUpRecoveryFixture,
  tearDownRecoveryFixture,
} from './cart-reservation-sync-recovery-test-helpers';

// Phase 16A.0-DA, Unit DA.1B (see the DA.1B claim-fencing review, Section
// 6). Claim-level fencing: two workers racing the SAME marker, one of
// which is stale (its PROCESSING claim aged past the reclaim timeout).
// attemptCount is the fencing token - a stale worker's captured
// (generation, attemptCount) pair can never match again once reclaimed,
// so it can neither resolve nor release the newer worker's claim, and the
// newer worker's row metadata is left completely intact.
describe('CartReservationSyncRecoveryService claim fencing (real Postgres, real Redis)', () => {
  let fixture: RecoveryFixture;

  beforeAll(async () => {
    fixture = await setUpRecoveryFixture('recovery-fencing');
  });

  afterAll(async () => {
    await tearDownRecoveryFixture(fixture);
  });

  it(
    'a reclaimed stale worker (A) cannot resolve worker B\'s newer claim, and B\'s claim metadata is left completely intact',
    async () => {
      const { cartService, cartRepository, syncStateRepository, inventoryReservations, customerId } = fixture;
      const product = await createProduct(fixture, 'Fencing Resolve');
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);

      await cartService.addItem(customerId, { productId: product.id, quantity: 5 }, randomUUID());
      const marker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      await syncStateRepository.markUnresolved(cart.id, product.id);

      const { staleCallStarted, releaseStaleCall } = installDelayedReserveSpy(inventoryReservations);

      // Worker A claims with a stale "now" (6 minutes ago) - its
      // processingStartedAt lands squarely in the reclaimable past - then
      // blocks on its own reserve() call.
      const staleNow = new Date(Date.now() - 6 * 60 * 1000);
      const workerAPromise = fixture.recoveryService.reconcileOne(marker!.id, staleNow);
      await staleCallStarted;

      // Worker B reclaims the same row (A's PROCESSING claim looks stale
      // relative to B's real "now") and completes fully - its own reserve()
      // call is the SECOND global call, so it is not blocked.
      const workerBOutcome = await fixture.recoveryService.reconcileOne(marker!.id, new Date());
      expect(workerBOutcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: marker!.id });
      const afterB = await syncStateRepository.findById(marker!.id);
      const bAttemptCount = afterB!.attemptCount;
      const bResolvedAt = afterB!.resolvedAt!.getTime();

      // Release A's stale, delayed reserve() call - it "succeeds" from A's
      // own point of view.
      releaseStaleCall();
      const workerAOutcome = await workerAPromise;

      expect(workerAOutcome).toEqual({ outcome: 'STALE_CLAIM', markerId: marker!.id });
      const finalRow = await syncStateRepository.findById(marker!.id);
      // B's claim is untouched by A: same attemptCount, still resolved at
      // the exact same timestamp B itself set - not reset, not re-resolved.
      expect(finalRow?.attemptCount).toBe(bAttemptCount);
      expect(finalRow?.status).toBe('PENDING'); // B's own resting shape
      expect(finalRow?.resolvedAt?.getTime()).toBe(bResolvedAt);
    },
    15_000,
  );

  it(
    'a reclaimed stale worker (A) whose Redis call throws cannot release worker B\'s newer claim',
    async () => {
      const { cartService, cartRepository, syncStateRepository, inventoryReservations, customerId } = fixture;
      const product = await createProduct(fixture, 'Fencing Release');
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);

      await cartService.addItem(customerId, { productId: product.id, quantity: 5 }, randomUUID());
      const marker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      await syncStateRepository.markUnresolved(cart.id, product.id);

      // Bound from the prototype, not the instance - see
      // installDelayedReserveSpy's own comment for why: this file's other
      // tests already spied this same shared instance, and jest.spyOn
      // shadows via an own property, never touching the prototype.
      const realReserve = InventoryReservationsService.prototype.reserve.bind(inventoryReservations);
      let callCount = 0;
      let resolveStaleStarted!: () => void;
      const staleCallStarted = new Promise<void>((resolve) => {
        resolveStaleStarted = resolve;
      });
      let releaseStale!: () => void;
      jest.spyOn(inventoryReservations, 'reserve').mockImplementation(async (productId, cartId, quantity) => {
        callCount += 1;
        if (callCount === 1) {
          resolveStaleStarted();
          await new Promise<void>((resolve) => {
            releaseStale = resolve;
          });
          throw new Error('stale worker redis timeout'); // A's write ultimately fails
        }
        return realReserve(productId, cartId, quantity);
      });

      const staleNow = new Date(Date.now() - 6 * 60 * 1000);
      const workerAPromise = fixture.recoveryService.reconcileOne(marker!.id, staleNow);
      await staleCallStarted;

      const workerBOutcome = await fixture.recoveryService.reconcileOne(marker!.id, new Date());
      expect(workerBOutcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: marker!.id });
      const afterB = await syncStateRepository.findById(marker!.id);
      const bAttemptCount = afterB!.attemptCount;
      const bResolvedAt = afterB!.resolvedAt!.getTime();

      releaseStale();
      const workerAOutcome = await workerAPromise;

      expect(workerAOutcome).toEqual({ outcome: 'STALE_CLAIM', markerId: marker!.id });
      const finalRow = await syncStateRepository.findById(marker!.id);
      // A's stale release attempt did NOT reset B's claim back to PENDING
      // with A's own error - B's already-resolved state is fully intact.
      expect(finalRow?.attemptCount).toBe(bAttemptCount);
      expect(finalRow?.resolvedAt?.getTime()).toBe(bResolvedAt);
      expect(finalRow?.lastError).not.toBe('stale worker redis timeout');
    },
    15_000,
  );

  it('a worker recovering a false-PENDING marker (Redis already correct) safely re-verifies and resolves - not treated as corruption', async () => {
    const { cartService, cartRepository, syncStateRepository, redisClient, customerId } = fixture;
    const product = await createProduct(fixture, 'Fencing False Pending');
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    await cartService.addItem(customerId, { productId: product.id, quantity: 6 }, randomUUID());
    const marker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
    // Simulate DA.1A's own conservative false-PENDING flag even though
    // Redis is ALREADY correct (the accepted trade-off from DA.1A Review #3,
    // Section 7 - false PENDING is safe, never corruption).
    await syncStateRepository.markUnresolved(cart.id, product.id);

    const before = await redisClient.hget(reservationHashKey(product.id), cart.id);
    expect((JSON.parse(before!) as { quantity: number }).quantity).toBe(6); // already correct

    const outcome = await fixture.recoveryService.reconcileOne(marker!.id, new Date());

    expect(outcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: marker!.id });
    const after = await redisClient.hget(reservationHashKey(product.id), cart.id);
    expect((JSON.parse(after!) as { quantity: number }).quantity).toBe(6); // idempotent re-write, harmless
    const finalMarker = await syncStateRepository.findById(marker!.id);
    expect(finalMarker?.resolvedAt).not.toBeNull();
  });
});
