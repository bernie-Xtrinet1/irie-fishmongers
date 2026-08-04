// Public result/type contracts for the checkout reservation-state services
// (CheckoutReservationStateService, CheckoutLeaseStateService).
//
// Unit 2.4.1 added checkoutMark's types. Unit 2.4.2 adds
// getCheckoutPendingLeaseState/extendCheckoutLease's types below.
// checkoutRevert, finalizeCheckoutConsumption, and reconciliation each add
// their own types in their own later sub-units - nothing for those
// operations is defined here ahead of need.

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

// getCheckoutPendingLeaseState (read-only, whole-cart) - see
// docs/architecture/reservation-lifecycle.md and the Unit 2.4.2 planning
// decisions for the exact found/complete/allOwnedByCheckoutKey semantics.
export interface CheckoutPendingLeaseStateResult {
  ok: true;
  found: boolean;
  complete: boolean;
  allOwnedByCheckoutKey: boolean;
  earliestCheckoutPendingAt: number | null;
  earliestCheckoutPendingExpiresAt: number | null;
  latestCheckoutPendingExpiresAt: number | null;
  pendingProductIds: string[];
  activeStatusProductIds: string[];
  missingProductIds: string[];
  malformedProductIds: string[];
  versionMismatchedProductIds: string[];
  conflictingKeyProductIds: string[];
  expiredLeaseProductIds: string[];
  hardLimitViolationProductIds: string[];
}

export type CheckoutLeaseStateResult = CheckoutPendingLeaseStateResult | CheckoutInputValidationFailure;

// extendCheckoutLease (whole-cart, validate-all-then-mutate-all).
export type CheckoutExtendLeaseErrorCode =
  | 'RESERVATION_MISSING'
  | 'RESERVATION_MALFORMED'
  | 'RESERVATION_VERSION_MISMATCH'
  | 'RESERVATION_CHECKOUT_KEY_MISMATCH'
  | 'CHECKOUT_PENDING_HARD_LIMIT_REACHED';

export type CheckoutExtendLeaseResult =
  | {
      ok: true;
      alreadyExtended: boolean;
      newCheckoutPendingExpiresAt: number;
      extendedProductIds: string[];
    }
  | { ok: false; code: 'RESERVATION_NOT_PENDING' }
  | { ok: false; code: 'CHECKOUT_STATE_INCOMPLETE'; pendingProductIds: string[]; activeProductIds: string[] }
  | { ok: false; code: CheckoutExtendLeaseErrorCode; productIds: string[] }
  | CheckoutInputValidationFailure;
