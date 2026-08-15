import { randomUUID } from 'crypto';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { reservationHashKey } from '../../inventory/constants/inventory.constants';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { buildLegacyPricingSnapshot } from '../../orders/services/legacy-pricing-snapshot.builder';
import { OrdersService } from '../../orders/services/orders.service';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { installDelayedReserveSpy } from './cart-reservation-sync-recovery-delay-spy-test-helpers';
import {
  RecoveryFixture,
  createProduct,
  setUpRecoveryFixture,
  tearDownRecoveryFixture,
} from './cart-reservation-sync-recovery-test-helpers';

// Phase 16A.0-DA, Unit DA.1B FINAL REVIEW - repository-wide mutation
// invariant audit and checkout-clear correction. DA.1B's safe-resolution
// predicate depends on: every production mutation that changes CartItem
// existence or quantity for a (cartId, productId) pair atomically advances
// CartReservationSyncState.generation in the same transaction. The audit
// found OrdersService.createOrderInTransaction's checkout-clear bulk
// delete (CartRepository.clear()) was the one gap - confirmed by an
// earlier version of this test, which reproducibly observed the forbidden
// state (CartItem absent, stale Redis reservation, marker falsely
// resolved) against the unfixed code. createOrderInTransaction now also
// calls CartReservationSyncStateRepository.advanceForClearedCart in the
// same transaction; this test proves the fix against the ACTUAL production
// createOrderInTransaction method (not mocked), and additionally proves
// the full DA.1A -> checkout -> DA.1B loop closes: a stale worker's
// Redis write may temporarily linger (reserve/release remain
// unconditioned - that is unchanged and accepted, see DA.1A Review #2),
// but it can never be credited as resolving the superseded generation, and
// a subsequent recovery pass fully converges.
describe('DA.1B repository-wide invariant: checkout clear vs. recovery worker (real Postgres, real Redis)', () => {
  let fixture: RecoveryFixture;
  let ordersService: OrdersService;

  beforeAll(async () => {
    fixture = await setUpRecoveryFixture('recovery-checkout-clear');
    const { prisma } = fixture;

    const ordersRepository = new OrdersRepository(prisma);
    const vendorOrdersRepository = new VendorOrdersRepository(prisma);
    const inventoryEventsRepository = new InventoryEventsRepository(prisma);

    // createOrderInTransaction never touches paymentsService,
    // vendorPermissionsService, or eventEmitter - only prepareCheckout()/
    // checkout()'s outer orchestration does. Untyped stand-ins are safe
    // here since this test calls createOrderInTransaction directly, the
    // same real method OrdersService.checkout() and
    // CheckoutCoordinatorService both call.
    ordersService = new OrdersService(
      prisma,
      ordersRepository,
      vendorOrdersRepository,
      fixture.cartRepository,
      fixture.productsRepository,
      undefined as never,
      undefined as never,
      undefined as never,
      inventoryEventsRepository,
      fixture.inventoryReservations,
      new EventEmitter2(),
      fixture.syncStateRepository,
    );
  });

  let purchasedProductId: string;

  afterAll(async () => {
    // createOrderInTransaction wrote a real InventoryEvent row for the
    // purchased product; InventoryEvent.productId is Restrict, so it
    // blocks the vendor-user-cascade Product deletion the shared teardown
    // triggers unless cleared first.
    if (purchasedProductId) {
      await fixture.prisma.inventoryEvent.deleteMany({ where: { productId: purchasedProductId } });
    }
    await tearDownRecoveryFixture(fixture);
  });

  it(
    'checkout clear advances marker generation: a delayed recovery-worker write for the stale generation is fenced, and a subsequent recovery pass fully converges',
    async () => {
      const { cartRepository, syncStateRepository, redisClient, inventoryReservations, customerId } = fixture;
      const product = await createProduct(fixture, 'Checkout Clear Race');
      purchasedProductId = product.id;
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);

      await fixture.cartService.addItem(customerId, { productId: product.id, quantity: 5 }, randomUUID());
      const marker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      const generationBeforeRace = marker!.generation;
      // Simulate a pending recovery need that predates checkout (e.g. a
      // DA.1A leftover) - the marker is unresolved at generation G while
      // the CartItem still genuinely holds quantity 5.
      await syncStateRepository.markUnresolved(cart.id, product.id);

      const { staleCallStarted, releaseStaleCall } = installDelayedReserveSpy(inventoryReservations);

      // Recovery worker: claims generation G, reads CartItem (quantity=5),
      // blocks on its own reserve() call.
      const workerPromise = fixture.recoveryService.reconcileOne(marker!.id, new Date());
      await staleCallStarted;

      // Checkout: the ACTUAL production createOrderInTransaction clears
      // the cart within a real transaction, exactly as
      // OrdersService.checkout() and CheckoutCoordinatorService both do.
      const cartWithItems = await cartRepository.findOrCreateByCustomerId(customerId);
      const pricing = buildLegacyPricingSnapshot(cartWithItems);
      await fixture.prisma.$transaction((tx) =>
        ordersService.createOrderInTransaction(
          tx,
          {
            cart: cartWithItems,
            dto: {
              deliveryAddressLine1: '12 Ocean View Road',
              deliveryParish: 'KINGSTON',
              deliveryPhone: '+18765551234',
              paymentMethod: 'CASH_ON_DELIVERY',
            },
            deliveryZoneId: null,
          },
          pricing,
        ),
      );

      // Release the worker's stale, delayed reserve() call - it "succeeds"
      // from the worker's own point of view, physically writing a
      // reservation for a product that has just been purchased and
      // deleted from the cart.
      releaseStaleCall();
      const outcome = await workerPromise;

      const finalItem = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      const raw = await redisClient.hget(reservationHashKey(product.id), cart.id);
      const finalMarker = await syncStateRepository.findById(marker!.id);

      // Full state captured structurally (not collapsed to a boolean) so a
      // failure prints the exact diagnostic per the DA.1B final review's
      // explicit "do not summarize as pass/fail" requirement.
      const diagnostic = {
        cartItemExists: finalItem !== null,
        cartItemQuantity: finalItem?.quantity ?? null,
        redisReservationPresent: raw !== null,
        redisReservationQuantity: raw !== null ? (JSON.parse(raw) as { quantity: number }).quantity : null,
        markerGeneration: finalMarker?.generation ?? null,
        markerStatus: finalMarker?.status ?? null,
        markerResolvedAtSet: finalMarker?.resolvedAt !== null && finalMarker?.resolvedAt !== undefined,
        workerOutcome: outcome.outcome,
      };

      // Required post-race state (Section 8 of the DA.1B final review): the
      // worker's stale Redis write MAY temporarily leave the old
      // reservation (reserve/release remain unconditioned, unchanged and
      // accepted since DA.1A) - the invariant that actually matters is
      // that the marker's generation genuinely advanced BECAUSE checkout
      // cleared the item, resolvedAt stays null for that (now-superseded)
      // generation, and the worker outcome is never RESOLVED_CONVERGED for
      // the stale generation.
      expect(diagnostic).toEqual({
        cartItemExists: false,
        cartItemQuantity: null,
        redisReservationPresent: true,
        redisReservationQuantity: 5,
        markerGeneration: generationBeforeRace + 1, // advanced by checkout's own clear
        markerStatus: 'PENDING',
        markerResolvedAtSet: false,
        workerOutcome: 'REQUEUED_SUPERSEDED',
      });

      // Close the loop: a subsequent DA.1B recovery pass on the CURRENT
      // (now-superseded) marker reads the current CartItem truth (absent),
      // releases the stale Redis reservation, and fully converges.
      const secondAttempt = await fixture.recoveryService.reconcileOne(finalMarker!.id, new Date());

      expect(secondAttempt).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: finalMarker!.id });
      const rawAfterRecovery = await redisClient.hget(reservationHashKey(product.id), cart.id);
      expect(rawAfterRecovery).toBeNull();
      const markerAfterRecovery = await syncStateRepository.findById(finalMarker!.id);
      expect(markerAfterRecovery?.generation).toBe(generationBeforeRace + 1);
      expect(markerAfterRecovery?.resolvedAt).not.toBeNull();
    },
    15_000,
  );

  it(
    'marker advancement and CartItem deletion are atomic: a failure after advanceForClearedCart rolls back the whole checkout transaction',
    async () => {
      const { cartRepository, syncStateRepository, prisma, customerId } = fixture;
      const product = await createProduct(fixture, 'Checkout Clear Rollback');
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);

      await fixture.cartService.addItem(customerId, { productId: product.id, quantity: 4 }, randomUUID());
      const itemBefore = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      const markerBefore = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      expect(markerBefore?.resolvedAt).not.toBeNull(); // converged normally, real Redis

      const realAdvance = fixture.syncStateRepository.advanceForClearedCart.bind(fixture.syncStateRepository);
      const spy = jest
        .spyOn(fixture.syncStateRepository, 'advanceForClearedCart')
        .mockImplementation(async (...args) => {
          await realAdvance(...args); // the real durable write genuinely executes...
          throw new Error('simulated failure after marker advancement, before transaction completion');
        });

      const cartWithItems = await cartRepository.findOrCreateByCustomerId(customerId);
      const pricing = buildLegacyPricingSnapshot(cartWithItems);

      await expect(
        prisma.$transaction((tx) =>
          ordersService.createOrderInTransaction(
            tx,
            {
              cart: cartWithItems,
              dto: {
                deliveryAddressLine1: '12 Ocean View Road',
                deliveryParish: 'KINGSTON',
                deliveryPhone: '+18765551234',
                paymentMethod: 'CASH_ON_DELIVERY',
              },
              deliveryZoneId: null,
            },
            pricing,
          ),
        ),
      ).rejects.toThrow('simulated failure after marker advancement, before transaction completion');

      spy.mockRestore();

      // ...but since it happened inside the still-open transaction, the
      // later throw rolled EVERYTHING back - no partial checkout-clear
      // synchronization state survives.
      const finalItem = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      expect(finalItem?.quantity).toBe(4);
      expect(finalItem?.id).toBe(itemBefore?.id); // still the same row, never deleted
      expect(finalItem?.mutationVersion).toBe(itemBefore?.mutationVersion); // never touched

      const finalMarker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      expect(finalMarker?.generation).toBe(markerBefore?.generation);
      expect(finalMarker?.expectedQuantity).toBe(markerBefore?.expectedQuantity);
      expect(finalMarker?.resolvedAt?.getTime()).toBe(markerBefore?.resolvedAt?.getTime());

      await fixture.cartService.removeItem(customerId, finalItem!.id);
    },
    15_000,
  );
});
