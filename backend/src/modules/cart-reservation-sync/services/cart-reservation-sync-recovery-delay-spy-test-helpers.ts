import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';

// Test-only infrastructure - never imported by, registered in, or exported
// from any production module. Split from
// cart-reservation-sync-recovery-test-helpers.ts purely to keep both files
// within the repository's 400-line limit; renamed with the shared
// `-test-helpers` suffix (matching every other test-helper file in this
// codebase, e.g. checkout-coordinator-integration-test-helpers.ts) so its
// name alone marks it as test-only.

export interface DelayedCallHandle {
  staleCallStarted: Promise<void>;
  releaseStaleCall: () => void;
}

// Call-through spy: blocks the FIRST invocation of reserve() until
// explicitly released, while every invocation - including the eventually-
// released first one - still performs the REAL underlying Redis HSET
// (never mocked away). Mirrors cart-service-concurrency-test-helpers.ts's
// own helper of the same shape.
//
// Binds from the class PROTOTYPE, never from the instance's own (possibly
// already-spied) property: several tests in this file's siblings share one
// fixture/instance across multiple installDelayedReserveSpy calls without
// restoring between them (calling reconcileOne again mid-test needs the
// spy to stay live). jest.spyOn(instance, 'method') shadows via an own
// property, leaving the prototype method untouched - binding from the
// instance instead would capture a PRIOR test's still-installed spy as
// "real", producing unbounded mutual recursion (a real bug hit and fixed
// during this unit's own implementation).
export function installDelayedReserveSpy(
  inventoryReservations: InventoryReservationsService,
): DelayedCallHandle {
  const realReserve = InventoryReservationsService.prototype.reserve.bind(inventoryReservations);
  let callCount = 0;
  let release!: () => void;
  const staleCallStarted = new Promise<void>((resolveStarted) => {
    jest.spyOn(inventoryReservations, 'reserve').mockImplementation(async (productId, cartId, quantity) => {
      callCount += 1;
      if (callCount === 1) {
        resolveStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return realReserve(productId, cartId, quantity);
    });
  });
  return { staleCallStarted, releaseStaleCall: () => release() };
}

// Same prototype-binding rationale as installDelayedReserveSpy above.
export function installDelayedReleaseSpy(
  inventoryReservations: InventoryReservationsService,
): DelayedCallHandle {
  const realRelease = InventoryReservationsService.prototype.release.bind(inventoryReservations);
  let callCount = 0;
  let release!: () => void;
  const staleCallStarted = new Promise<void>((resolveStarted) => {
    jest.spyOn(inventoryReservations, 'release').mockImplementation(async (productId, cartId) => {
      callCount += 1;
      if (callCount === 1) {
        resolveStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return realRelease(productId, cartId);
    });
  });
  return { staleCallStarted, releaseStaleCall: () => release() };
}

// Phase 16A.0-DA, Unit DA.4B. Same prototype-binding rationale as
// installDelayedReserveSpy above, targeting the cart-scoped engine's own
// write instead of the legacy one - used by the CART_SCOPED-mode-race
// integration specs, where the write recovery pauses mid-flight on is
// reserveOrRenew, not reserve().
export function installDelayedReserveOrRenewSpy(
  inventoryReservations: InventoryReservationsService,
): DelayedCallHandle {
  const realReserveOrRenew = InventoryReservationsService.prototype.reserveOrRenew.bind(inventoryReservations);
  let callCount = 0;
  let release!: () => void;
  const staleCallStarted = new Promise<void>((resolveStarted) => {
    jest.spyOn(inventoryReservations, 'reserveOrRenew').mockImplementation(async (cartId, productId, customerId, quantity) => {
      callCount += 1;
      if (callCount === 1) {
        resolveStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return realReserveOrRenew(cartId, productId, customerId, quantity);
    });
  });
  return { staleCallStarted, releaseStaleCall: () => release() };
}

// Same prototype-binding rationale, targeting releaseReservation (the
// cart-scoped engine's release primitive).
export function installDelayedReleaseReservationSpy(
  inventoryReservations: InventoryReservationsService,
): DelayedCallHandle {
  const realReleaseReservation = InventoryReservationsService.prototype.releaseReservation.bind(inventoryReservations);
  let callCount = 0;
  let release!: () => void;
  const staleCallStarted = new Promise<void>((resolveStarted) => {
    jest.spyOn(inventoryReservations, 'releaseReservation').mockImplementation(async (cartId, productId) => {
      callCount += 1;
      if (callCount === 1) {
        resolveStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return realReleaseReservation(cartId, productId);
    });
  });
  return { staleCallStarted, releaseStaleCall: () => release() };
}
