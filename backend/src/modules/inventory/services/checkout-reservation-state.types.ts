// Public result/type contracts for CheckoutReservationStateService.
//
// Unit 2.4.1 scope only: types required by checkoutMark and its shared
// input-validation layer. Lease inspection/extension, checkoutRevert,
// finalizeCheckoutConsumption, and reconciliation each add their own types
// in their own later sub-units - nothing for those operations is defined
// here ahead of need.

export interface CheckoutReservationPlanItem {
  productId: string;
  expectedQuantity: number;
}

// Shared across every CheckoutReservationStateService public method -
// returned before any Redis call when an argument fails validation.
export interface CheckoutInputValidationFailure {
  ok: false;
  code: 'INVALID_INPUT';
  field: string;
  reason: string;
}

export interface CheckoutPlanMismatchDetails {
  submittedProductIds: string[];
  indexedProductIds: string[];
  missingFromPlan: string[];
  missingFromIndex: string[];
  duplicateProductIds: string[];
}

export type CheckoutMarkErrorCode =
  | 'RESERVATION_MISSING'
  | 'RESERVATION_MALFORMED'
  | 'RESERVATION_VERSION_MISMATCH'
  | 'RESERVATION_OWNER_MISMATCH'
  | 'RESERVATION_QUANTITY_MISMATCH'
  | 'RESERVATION_EXPIRED'
  | 'RESERVATION_ABSOLUTE_EXPIRED'
  | 'RESERVATION_CHECKOUT_KEY_CONFLICT';

export type CheckoutMarkResult =
  | { ok: true; suspectProductIds: string[] }
  | { ok: false; code: 'CHECKOUT_PLAN_EMPTY' }
  | { ok: false; code: 'CHECKOUT_PLAN_DUPLICATE_PRODUCT'; duplicateProductIds: string[] }
  | { ok: false; code: 'CHECKOUT_PLAN_MISMATCH'; details: CheckoutPlanMismatchDetails }
  | { ok: false; code: CheckoutMarkErrorCode; failedProductId: string }
  | CheckoutInputValidationFailure;
