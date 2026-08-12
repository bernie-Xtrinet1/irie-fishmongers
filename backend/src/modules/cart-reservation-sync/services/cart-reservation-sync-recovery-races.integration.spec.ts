import { randomUUID } from 'crypto';

import { reservationHashKey } from '../../inventory/constants/inventory.constants';
import {
  RecoveryFixture,
  createProduct,
  installDelayedReleaseSpy,
  installDelayedReserveSpy,
  setUpRecoveryFixture,
  tearDownRecoveryFixture,
} from './cart-reservation-sync-recovery-test-helpers';

// Phase 16A.0-DA, Unit DA.1B (see the DA.1B claim-fencing review, Sections
// 7-8). CartItem-mid-repair races: a customer mutation lands WHILE a
// recovery worker's own Redis write is in flight. The worker's write may
// still physically corrupt Redis (reserve/release are unconditioned), but
// it must never be credited as convergence for the newer generation - the
// row must remain recoverable, protected entirely by the marker's own
// persistent generation (never CartItem.mutationVersion).
describe('CartReservationSyncRecoveryService mid-repair races (real Postgres, real Redis)', () => {
  let fixture: RecoveryFixture;

  beforeAll(async () => {
    fixture = await setUpRecoveryFixture('recovery-races');
  });

  afterAll(async () => {
    await tearDownRecoveryFixture(fixture);
  });

  it(
    'CartItem quantity changes mid-repair: the worker\'s stale write is not credited as resolved, and the row remains recoverable',
    async () => {
      const { cartService, cartRepository, syncStateRepository, redisClient, inventoryReservations, customerId } = fixture;
      const product = await createProduct(fixture, 'Races Quantity Change');
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);

      await cartService.addItem(customerId, { productId: product.id, quantity: 4 }, randomUUID());
      const item = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      const markerBefore = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      await syncStateRepository.markUnresolved(cart.id, product.id); // simulate a pending recovery need

      const { staleCallStarted, releaseStaleCall } = installDelayedReserveSpy(inventoryReservations);

      // Worker: claims, reads CartItem (quantity=4), then blocks on its
      // own reserve() call.
      const reconcilePromise = fixture.recoveryService.reconcileOne(markerBefore!.id, new Date());
      await staleCallStarted;

      // Customer mutation lands while the worker is blocked: quantity -> 7,
      // its own (unblocked, second) reserve() call converges cleanly.
      await cartService.updateItemQuantity(customerId, item!.id, { quantity: 7 });

      // Release the worker's stale reserve(4) - it physically overwrites Redis.
      releaseStaleCall();
      const outcome = await reconcilePromise;

      expect(outcome.outcome).not.toBe('RESOLVED_CONVERGED');
      expect(outcome).toEqual({ outcome: 'REQUEUED_SUPERSEDED', markerId: markerBefore!.id });

      const raw = await redisClient.hget(reservationHashKey(product.id), cart.id);
      expect((JSON.parse(raw!) as { quantity: number }).quantity).toBe(4); // the worker's stale write did land

      const markerAfter = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      expect(markerAfter?.resolvedAt).toBeNull(); // remains recoverable, never falsely resolved

      // A later recovery attempt converges to the real, current truth.
      const secondAttempt = await fixture.recoveryService.reconcileOne(markerAfter!.id, new Date());
      expect(secondAttempt).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: markerAfter!.id });
      const rawAfter = await redisClient.hget(reservationHashKey(product.id), cart.id);
      expect((JSON.parse(rawAfter!) as { quantity: number }).quantity).toBe(7);
    },
    15_000,
  );

  it(
    'CartItem deleted mid-repair: the worker\'s stale write is not credited as resolved, and the row remains recoverable',
    async () => {
      const { cartService, cartRepository, syncStateRepository, redisClient, inventoryReservations, customerId } = fixture;
      const product = await createProduct(fixture, 'Races Delete');
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);

      await cartService.addItem(customerId, { productId: product.id, quantity: 4 }, randomUUID());
      const item = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      const markerBefore = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      await syncStateRepository.markUnresolved(cart.id, product.id);

      const { staleCallStarted, releaseStaleCall } = installDelayedReserveSpy(inventoryReservations);

      const reconcilePromise = fixture.recoveryService.reconcileOne(markerBefore!.id, new Date());
      await staleCallStarted;

      // Customer removes the item entirely while the worker is blocked.
      await cartService.removeItem(customerId, item!.id);

      releaseStaleCall();
      const outcome = await reconcilePromise;

      expect(outcome).toEqual({ outcome: 'REQUEUED_SUPERSEDED', markerId: markerBefore!.id });
      const raw = await redisClient.hget(reservationHashKey(product.id), cart.id);
      expect(raw).not.toBeNull(); // the worker's stale reserve() wrongly landed after the item was deleted

      const markerAfter = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      expect(markerAfter?.resolvedAt).toBeNull();

      const secondAttempt = await fixture.recoveryService.reconcileOne(markerAfter!.id, new Date());
      expect(secondAttempt).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: markerAfter!.id });
      const rawAfter = await redisClient.hget(reservationHashKey(product.id), cart.id);
      expect(rawAfter).toBeNull(); // now correctly absent
    },
    15_000,
  );

  it(
    'delete then recreate mid-repair: persistent marker generation - not CartItem.mutationVersion - protects the newer recreated state',
    async () => {
      const { cartService, cartRepository, syncStateRepository, redisClient, inventoryReservations, customerId } = fixture;
      const product = await createProduct(fixture, 'Races Delete Recreate');
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);

      await cartService.addItem(customerId, { productId: product.id, quantity: 5 }, randomUUID());
      const item = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      await cartService.removeItem(customerId, item!.id);
      const markerBefore = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      await syncStateRepository.markUnresolved(cart.id, product.id); // simulate a pending release recovery

      const { staleCallStarted, releaseStaleCall } = installDelayedReleaseSpy(inventoryReservations);

      // Worker: reads CartItem (absent), then blocks on its own release() call.
      const reconcilePromise = fixture.recoveryService.reconcileOne(markerBefore!.id, new Date());
      await staleCallStarted;

      // Customer re-adds the same product while the worker is blocked -
      // fresh CartItem (mutationVersion resets to 0), a genuinely NEWER
      // marker generation, its own reserve() converges cleanly.
      await cartService.addItem(customerId, { productId: product.id, quantity: 9 }, randomUUID());

      // Release the worker's stale release() - it wrongly deletes the
      // freshly re-added reservation.
      releaseStaleCall();
      const outcome = await reconcilePromise;

      expect(outcome).toEqual({ outcome: 'REQUEUED_SUPERSEDED', markerId: markerBefore!.id });
      const raw = await redisClient.hget(reservationHashKey(product.id), cart.id);
      expect(raw).toBeNull(); // the worker's stale HDEL wiped the recreated reservation

      const markerAfter = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      expect(markerAfter?.expectedQuantity).toBe(9); // the recreated mutation's own desired state
      expect(markerAfter?.resolvedAt).toBeNull(); // never falsely resolved by the stale delete-path worker

      const secondAttempt = await fixture.recoveryService.reconcileOne(markerAfter!.id, new Date());
      expect(secondAttempt).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: markerAfter!.id });
      const rawAfter = await redisClient.hget(reservationHashKey(product.id), cart.id);
      expect((JSON.parse(rawAfter!) as { quantity: number }).quantity).toBe(9);
    },
    15_000,
  );
});
