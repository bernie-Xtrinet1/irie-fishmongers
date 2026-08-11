import { ValidateCartPriceLocksResult } from '../../price-lock/types/price-lock.types';
import { PrepareCheckoutFailure } from '../../orders/types/checkout-preparation.types';
import { OrderResponseEntity } from '../../orders/entities/order-response.entity';
import { CheckoutPlanReconciliationResult } from './canonical-checkout-plan.types';

type PriceLockValidationFailure = Exclude<ValidateCartPriceLocksResult, { ok: true }>;
type CheckoutPlanMismatchFailure = Extract<CheckoutPlanReconciliationResult, { ok: false }>;

// Phase 16A.0-D, Unit D.2. CheckoutCoordinatorService's public result -
// never a thrown exception for an expected business/idempotency outcome,
// matching every other Phase-16A.0-C/D service's discriminated-union
// convention. `ok: true` covers both a freshly created order and an
// ALREADY_COMMITTED duplicate-request replay - both are a successful
// checkout from the caller's perspective.
export type CheckoutCoordinatorResult =
  | { ok: true; order: OrderResponseEntity }
  | { ok: false; code: 'INVALID_INPUT'; field: string; reason: string }
  | { ok: false; code: 'PREPARE_FAILED'; prepareFailure: PrepareCheckoutFailure }
  | { ok: false; code: 'PRICE_LOCK_INVALID'; priceLockFailure: PriceLockValidationFailure }
  | ({ ok: false; code: 'CHECKOUT_PLAN_MISMATCH' } & Omit<CheckoutPlanMismatchFailure, 'code'>)
  | { ok: false; code: 'IDEMPOTENCY_KEY_CONFLICT' }
  | { ok: false; code: 'CHECKOUT_ALREADY_IN_PROGRESS' }
  | { ok: false; code: 'CHECKOUT_ALREADY_FAILED'; failureCode: string | null }
  | { ok: false; code: 'CHECKOUT_MARK_FAILED'; markFailureCode: string }
  | { ok: false; code: 'ORDER_TRANSACTION_FAILED' }
  | { ok: false; code: 'ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE' };
