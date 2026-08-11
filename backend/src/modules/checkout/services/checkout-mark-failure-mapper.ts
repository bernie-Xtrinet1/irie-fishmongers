import { CheckoutMarkResult } from '../../inventory/services/checkout-reservation-state.types';

const MAX_FAILURE_CODE_LENGTH = 64;

// Phase 16A.0-D, Unit D.2. Maps every non-success CheckoutMarkResult branch
// to a stable, <=64-char CheckoutAttempt.failureCode value - the durable
// record of exactly which checkoutMark condition caused the
// PROCESSING -> FAILED transition. Every CheckoutMarkResult failure `code`
// is a short, already-stable string (longest currently:
// RESERVATION_CHECKOUT_KEY_CONFLICT), so a single CHECKOUT_MARK_ prefix
// covers the whole union without a per-code switch - the length assertion
// below is the permanent guard against a future, longer code silently
// exceeding the CheckoutAttempt column's constraint.
export function mapCheckoutMarkFailureCode(result: Exclude<CheckoutMarkResult, { ok: true }>): string {
  const code = `CHECKOUT_MARK_${result.code}`;
  if (code.length > MAX_FAILURE_CODE_LENGTH) {
    throw new Error(`Internal consistency error: failureCode "${code}" exceeds ${MAX_FAILURE_CODE_LENGTH} characters`);
  }
  return code;
}
