// Neutral, checkout-independent reservation-accounting types. Lives
// outside checkout-reservation-state.types.ts specifically so
// InventoryReservationsService (which predates the checkout-state family
// and has no other reason to depend on it) never has to import from a
// checkout-specific types module - see the Unit 2.4.3 correction.
//
// Shared by reserveOrRenew/releaseReservation (Unit 2.3),
// checkoutRevert/finalizeCheckoutConsumption (Unit 2.4.3), and future
// reconciliation work - see docs/architecture/reservation-lifecycle.md §5.
export interface ReservationUnderflowDetails {
  productId: string;
  cartId: string;
  reservationQuantity: number;
  storedTotal: number;
  operationName:
    | 'reserveOrRenew'
    | 'releaseReservation'
    | 'checkoutRevert'
    | 'finalizeCheckoutConsumption';
  timestamp: number;
}
