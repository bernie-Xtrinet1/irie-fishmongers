import { ReservationAvailabilityResult } from '../../reservation-engine-mode/types/reservation-availability.types';

// Phase 16A.0-C, Unit C3 (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md).
// Additive and unwired - CheckoutReservationModule is not imported by
// CartModule, AppModule, or any other production module.
//
// customerId (reserveForCart) is trusted only after the caller has already
// proven the authenticated customer owns cartId - CartService already
// resolves cart.id from userId before any reservation call today. C3
// performs syntactic identifier validation only; it never queries Postgres
// for cart/product/vendor ownership and has no CartRepository/
// ProductsRepository/PrismaService dependency of any kind.
export interface ReservationGateway {
  reserveForCart(
    cartId: string,
    productId: string,
    customerId: string,
    desiredQuantity: number,
  ): Promise<ReserveForCartResult>;

  releaseForCart(cartId: string, productId: string): Promise<ReleaseForCartResult>;

  releaseCart(cartId: string, productIds: string[]): Promise<ReleaseCartResult>;

  getCartAdmissionAvailability(
    productId: string,
    quantityAvailable: number,
    cartId: string,
  ): Promise<ReservationAvailabilityResult>;
}

export const RESERVATION_GATEWAY = Symbol('RESERVATION_GATEWAY');

export type MirrorFailureReasonCode =
  | 'PRODUCT_SUSPENDED'
  | 'CHECKOUT_IN_PROGRESS'
  | 'ACCOUNTING_UNDERFLOW'
  | 'UNKNOWN_INFRA_FAILURE';

// SYNCED is reachable only when the cart-scoped write succeeded AND
// reported no underflow - never reported when accounting could not be
// trusted. FAILED never carries a raw caught Error/message.
export type MirrorDiagnostic =
  | { status: 'SYNCED' }
  | { status: 'NOT_ATTEMPTED' }
  | { status: 'FAILED'; operation: 'RESERVE' | 'RELEASE'; reasonCode: MirrorFailureReasonCode };

export type ReserveForCartResult =
  | { ok: true; mode: 'LEGACY'; mirror: { status: 'NOT_ATTEMPTED' } }
  | { ok: true; mode: 'MIRROR'; mirror: MirrorDiagnostic }
  | { ok: true; mode: 'CART_SCOPED'; mirror: { status: 'NOT_ATTEMPTED' } }
  | { ok: false; mode: 'DRAINING'; code: 'MODE_NOT_ADMITTING' }
  | { ok: false; code: 'RESERVATION_CHECKOUT_IN_PROGRESS' }
  | { ok: false; code: 'RESERVATION_PRODUCT_SUSPENDED' }
  | { ok: false; code: 'INVALID_INPUT'; field: string; reason: string };

// No `released: boolean` - LEGACY (hdel-based) and CART_SCOPED (Lua,
// idempotent-by-construction) have no shared, meaningful definition of
// "did a key previously exist" worth exposing on one public contract.
// Success means the facade completed the selected mode's release
// operation, nothing more specific.
export type ReleaseForCartResult =
  | { ok: true; mode: 'LEGACY'; mirror: { status: 'NOT_ATTEMPTED' } }
  | { ok: true; mode: 'MIRROR'; mirror: MirrorDiagnostic }
  | { ok: true; mode: 'CART_SCOPED'; mirror: { status: 'NOT_ATTEMPTED' } }
  | { ok: true; mode: 'DRAINING'; mirror: { status: 'NOT_ATTEMPTED' } }
  | { ok: false; code: 'INVALID_INPUT'; field: string; reason: string };

export interface ReleaseCartItemResult {
  productId: string;
  result: ReleaseForCartResult;
}

export type ReleaseCartResult =
  | { ok: true; items: ReleaseCartItemResult[] }
  | { ok: false; code: 'INVALID_INPUT'; field: string; reason: string };
