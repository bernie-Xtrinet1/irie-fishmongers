import { reservationHashKey } from '../../inventory/constants/inventory.constants';
import {
  ConcurrencyFixture,
  installDelayedReserveSpy,
  setUpConcurrencyFixture,
  tearDownConcurrencyFixture,
} from './cart-service-concurrency-test-helpers';

// Phase 16A.0-DA, Unit DA.1A (see the DA.1 architecture review, including
// the concurrency-proof correction / Review #2). Proves the exact race
// Review #2 required: a slow, stale Redis reserve() call (from an earlier
// mutation) that finally completes AFTER a newer mutation has already
// committed and converged.
//
// Unlike the original version of this file, InventoryReservationsService is
// never mocked away - it is real, backed by a real Redis instance
// (ISOLATED_DB_INDEX 7 - see cart-service-concurrency-test-helpers.ts), so
// every assertion below reads the ACTUAL Redis hash value via a raw client,
// not an assumption about what a mock "would have" written. reserve() is
// confirmed (by direct inspection of InventoryReservationsService) to be a
// plain, unconditioned HSET - no CAS/version predicate - so this suite
// proves what CartService's convergence protocol can and cannot do about
// that: it cannot prevent the physical overwrite, but it must never leave
// the marker falsely resolved when it can't prove Redis matches the latest
// durable target (see confirmOrUnresolve/markUnresolved in cart.service.ts).
describe('CartService reserve-path ordering (real Postgres, real Redis, controlled completion order)', () => {
  let fixture: ConcurrencyFixture;

  beforeAll(async () => {
    fixture = await setUpConcurrencyFixture('cart-reserve-race');
  });

  afterAll(async () => {
    await tearDownConcurrencyFixture(fixture);
  });

  it(
    'natural ordering: reserve converges Redis, Postgres, and the marker to the latest mutation',
    async () => {
      const { service, cartRepository, syncStateRepository, redisClient, productId, customerId } = fixture;
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);

      await service.addItem(customerId, { productId, quantity: 2 });
      const item = await cartRepository.findItemByCartAndProduct(cart.id, productId);
      await service.updateItemQuantity(customerId, item!.id, { quantity: 7 });

      const finalItem = await cartRepository.findItemByCartAndProduct(cart.id, productId);
      expect(finalItem?.quantity).toBe(7);

      const rawEntry = await redisClient.hget(reservationHashKey(productId), cart.id);
      expect(rawEntry).not.toBeNull();
      expect((JSON.parse(rawEntry!) as { quantity: number }).quantity).toBe(7);

      const marker = await syncStateRepository.findByCartAndProduct(cart.id, productId);
      expect(marker?.expectedQuantity).toBe(7);
      expect(marker?.resolvedAt).not.toBeNull();

      await service.removeItem(customerId, finalItem!.id);
    },
    15_000,
  );

  it(
    'stale-then-fresh: a delayed reserve() that lands after a newer mutation already converged physically overwrites Redis, but must never leave the marker falsely resolved',
    async () => {
      const { service, cartRepository, syncStateRepository, inventoryReservations, redisClient, productId, customerId } =
        fixture;
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);

      const { staleCallStarted, releaseStaleCall } = installDelayedReserveSpy(inventoryReservations);

      // Mutation A: addItem. Its own Postgres transaction (CartItem create
      // + marker upsert) commits before convergeReservation's reserve()
      // call is even entered - confirmed by staleCallStarted resolving
      // only once reserve() has actually started.
      const mutationA = service.addItem(customerId, { productId, quantity: 2 });
      await staleCallStarted;

      const itemAfterA = await cartRepository.findItemByCartAndProduct(cart.id, productId);
      expect(itemAfterA?.quantity).toBe(2);

      // Mutation B: a fully independent, later updateItemQuantity call on
      // the same item, completing entirely (Postgres commit + its own real
      // reserve() call - NOT the delayed first call) while A is still
      // blocked.
      await service.updateItemQuantity(customerId, itemAfterA!.id, { quantity: 7 });

      const markerAfterB = await syncStateRepository.findByCartAndProduct(cart.id, productId);
      expect(markerAfterB?.expectedQuantity).toBe(7);
      expect(markerAfterB?.resolvedAt).not.toBeNull();
      const generationAfterB = markerAfterB!.generation;

      const rawAfterB = await redisClient.hget(reservationHashKey(productId), cart.id);
      expect((JSON.parse(rawAfterB!) as { quantity: number }).quantity).toBe(7);

      // Release A's stale, delayed reserve() call - it performs the REAL
      // HSET now, exactly as InventoryReservationsService.reserve always
      // does: unconditioned, last-write-wins.
      releaseStaleCall();
      await mutationA;

      // Real Redis: A's stale write physically overwrote B's value - this
      // is the raw HSET's actual, unconditioned behavior, proven directly
      // rather than inferred from a mock.
      const rawAfterA = await redisClient.hget(reservationHashKey(productId), cart.id);
      expect(rawAfterA).not.toBeNull();
      expect((JSON.parse(rawAfterA!) as { quantity: number }).quantity).toBe(2);

      // Postgres retains B - A's own primary mutation already committed
      // before B ran, and A's Redis write never touches Postgres at all.
      const finalItem = await cartRepository.findItemByCartAndProduct(cart.id, productId);
      expect(finalItem?.quantity).toBe(7);

      // Required invariant (see the DA.1 concurrency-proof correction):
      // since Redis cannot be proven to match B's durable target - it
      // provably does NOT, per the assertion above - the marker must be
      // left unresolved for a future DA.1B to repair, not falsely marked
      // resolved just because A's own reserve() call returned successfully.
      const finalMarker = await syncStateRepository.findByCartAndProduct(cart.id, productId);
      expect(finalMarker?.expectedQuantity).toBe(7);
      expect(finalMarker?.generation).toBe(generationAfterB);
      expect(finalMarker?.resolvedAt).toBeNull();

      await service.removeItem(customerId, finalItem!.id);
    },
    15_000,
  );
});
