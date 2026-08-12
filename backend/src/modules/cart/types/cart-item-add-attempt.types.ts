// Phase 16A.0-DA, Unit DA.2 (see the DA.2 design review). Public
// result/type contracts for CartItemAddAttemptRepository/
// CartItemAddIdempotencyService - see cart-item-add-attempt.repository.ts
// for the schema-level design rationale.

// A finished, typed business rejection recorded before any CartItem
// mutation is attempted - never an infrastructure failure (DB/Redis/
// process errors stay non-terminal, left at PROCESSING for stale reclaim).
// Maps 1:1 to the existing exception thrown by CartService's own
// assertProductIsPurchasable/assertQuantityAvailable checks - see
// CartService.classifyRejection.
export type CartItemAddRejectionCode =
  | 'PRODUCT_NOT_PURCHASABLE'
  | 'PRODUCT_ON_HOLD'
  | 'VENDOR_NOT_APPROVED'
  | 'QUANTITY_NOT_AVAILABLE';

export interface ClassifyCartItemAddAttemptInput {
  customerId: string;
  idempotencyKey: string;
  cartId: string;
  productId: string;
  requestedQuantity: number;
  now: Date;
}

export interface CartItemAddAttemptCompletedResult {
  cartItemId: string;
  quantity: number;
  mutationVersion: number;
  generation: number;
}

// EXECUTE covers both a brand-new key and a stale-reclaimed one - the
// caller never needs to distinguish them, only the fenced attemptCount to
// complete/reject against.
export type ClassifyCartItemAddAttemptResult =
  | { outcome: 'EXECUTE'; attemptId: string; attemptCount: number }
  | { outcome: 'ALREADY_PROCESSING' }
  | { outcome: 'IDEMPOTENCY_KEY_CONFLICT' }
  | { outcome: 'COMPLETED_REPLAY'; result: CartItemAddAttemptCompletedResult }
  | { outcome: 'REJECTED_REPLAY'; rejectionCode: CartItemAddRejectionCode; rejectionMessage: string };
