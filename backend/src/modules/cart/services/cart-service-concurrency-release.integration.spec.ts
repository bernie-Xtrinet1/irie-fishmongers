import { reservationHashKey } from '../../inventory/constants/inventory.constants';
import {
  ConcurrencyFixture,
  installDelayedReleaseSpy,
  setUpConcurrencyFixture,
  tearDownConcurrencyFixture,
} from './cart-service-concurrency-test-helpers';

// Phase 16A.0-DA, Unit DA.1A (see the DA.1 architecture review, including
// the concurrency-proof correction / Review #2, Section 6 - "test the
// corresponding release/remove path"). Mirrors
// cart-service-concurrency.integration.spec.ts's reserve-path race, but for
// release(): a plain, unconditioned HDEL (confirmed by direct inspection of
// InventoryReservationsService) is just as capable of corrupting Redis as
// reserve()'s HSET - a stale, delayed HDEL can delete a fresher mutation's
// entry outright, producing "Postgres has an item, Redis has nothing" (a
// different divergence shape than the reserve-path race, but the same
// required invariant: the marker must never be left falsely resolved).
describe('CartService release-path ordering (real Postgres, real Redis, controlled completion order)', () => {
  let fixture: ConcurrencyFixture;

  beforeAll(async () => {
    fixture = await setUpConcurrencyFixture('cart-release-race');
  });

  afterAll(async () => {
    await tearDownConcurrencyFixture(fixture);
  });

  it(
    'natural ordering: release clears Redis, Postgres, and resolves the marker for the deleted state',
    async () => {
      const { service, cartRepository, syncStateRepository, redisClient, productId, customerId } = fixture;
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);

      await service.addItem(customerId, { productId, quantity: 3 });
      const item = await cartRepository.findItemByCartAndProduct(cart.id, productId);
      await service.removeItem(customerId, item!.id);

      const finalItem = await cartRepository.findItemByCartAndProduct(cart.id, productId);
      expect(finalItem).toBeNull();

      const rawEntry = await redisClient.hget(reservationHashKey(productId), cart.id);
      expect(rawEntry).toBeNull();

      const marker = await syncStateRepository.findByCartAndProduct(cart.id, productId);
      expect(marker?.expectedQuantity).toBeNull();
      expect(marker?.resolvedAt).not.toBeNull();
    },
    15_000,
  );

  it(
    'stale-then-fresh: a delayed release() that lands after a newer mutation already converged deletes that mutation\'s Redis entry outright, but must never leave the marker falsely resolved',
    async () => {
      const { service, cartRepository, syncStateRepository, inventoryReservations, redisClient, productId, customerId } =
        fixture;
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);

      // Unraced setup: get a real, converged item into the cart first.
      await service.addItem(customerId, { productId, quantity: 3 });
      const itemBeforeA = await cartRepository.findItemByCartAndProduct(cart.id, productId);

      const { staleCallStarted, releaseStaleCall } = installDelayedReleaseSpy(inventoryReservations);

      // Mutation A: removeItem. Its own Postgres transaction (CartItem
      // delete + marker upsert to expectedQuantity=null) commits before
      // convergeReservation's release() call is even entered - confirmed
      // by staleCallStarted resolving only once release() has actually
      // started.
      const mutationA = service.removeItem(customerId, itemBeforeA!.id);
      await staleCallStarted;

      const itemAfterA = await cartRepository.findItemByCartAndProduct(cart.id, productId);
      expect(itemAfterA).toBeNull();

      // Mutation B: a fully independent, later addItem call for the same
      // product on the same cart (the item was just deleted by A, so this
      // creates a fresh CartItem), completing entirely - Postgres commit +
      // its own real reserve() call (untouched by the release spy) -
      // while A's release() is still blocked.
      await service.addItem(customerId, { productId, quantity: 9 });

      const markerAfterB = await syncStateRepository.findByCartAndProduct(cart.id, productId);
      expect(markerAfterB?.expectedQuantity).toBe(9);
      expect(markerAfterB?.resolvedAt).not.toBeNull();
      const generationAfterB = markerAfterB!.generation;

      const rawAfterB = await redisClient.hget(reservationHashKey(productId), cart.id);
      expect((JSON.parse(rawAfterB!) as { quantity: number }).quantity).toBe(9);

      // Release A's stale, delayed release() call - it performs the REAL
      // HDEL now, exactly as InventoryReservationsService.release always
      // does: unconditioned, deletes whatever is currently in the field
      // regardless of value.
      releaseStaleCall();
      await mutationA;

      // Real Redis: A's stale HDEL deleted B's fresh entry outright - this
      // is the raw HDEL's actual, unconditioned behavior, proven directly
      // rather than inferred from a mock.
      const rawAfterA = await redisClient.hget(reservationHashKey(productId), cart.id);
      expect(rawAfterA).toBeNull();

      // Postgres retains B - A's own primary mutation already committed
      // before B ran, and A's Redis write never touches Postgres at all.
      const finalItem = await cartRepository.findItemByCartAndProduct(cart.id, productId);
      expect(finalItem?.quantity).toBe(9);

      // Required invariant (see the DA.1 concurrency-proof correction):
      // since Redis cannot be proven to match B's durable target - it
      // provably does NOT, per the assertion above - the marker must be
      // left unresolved for a future DA.1B to repair, not falsely marked
      // resolved just because A's own release() call returned successfully.
      const finalMarker = await syncStateRepository.findByCartAndProduct(cart.id, productId);
      expect(finalMarker?.expectedQuantity).toBe(9);
      expect(finalMarker?.generation).toBe(generationAfterB);
      expect(finalMarker?.resolvedAt).toBeNull();

      await service.removeItem(customerId, finalItem!.id);
    },
    15_000,
  );
});
