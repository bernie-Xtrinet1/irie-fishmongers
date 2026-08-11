import { ValidatedCartPriceLockItem } from '../../price-lock/types/price-lock.types';

// Phase 16A.0-D, Unit D.2. The single canonical checkout plan, reconciled
// from OrdersService.prepareCheckout's durable cart read and
// PriceLockService.validateCartPriceLocks's locked-price read before any
// CheckoutAttempt is created. Both checkoutMark's reservation quantities
// and the OrderPricingSnapshot passed into createOrderInTransaction are
// derived exclusively from this one plan - CheckoutCoordinatorService never
// independently rebuilds either view from prepared.cart.items or from
// priceLockResult.items separately once reconciliation has produced this.
//
// currency lives only on the plan (not per-item), matching D.1.1's
// OrderPricingSnapshot invariant of a single currency authority -
// PriceLockService.validateCartPriceLocks already guarantees every
// ValidatedCartPriceLockItem.lockedCurrency equals its own returned
// cartCurrency (currency-mismatched items are excluded from a successful
// result and reported via PRICE_LOCKS_INVALID instead), so this plan does
// not re-derive currency per item.
export interface CanonicalCheckoutPlanItem {
  productId: string;
  quantity: number;
  lockedUnitPrice: string;
}

export interface CanonicalCheckoutPlan {
  currency: string;
  items: CanonicalCheckoutPlanItem[];
}

// The reconciliation this plan is built from re-derives desired state from
// two independent reads of the same cart (OrdersService.prepareCheckout and
// PriceLockService.validateCartPriceLocks) taken at slightly different
// times - see checkout-plan-reconciliation.ts. A mismatch here reflects a
// genuine time-of-check-to-time-of-use race (e.g. a concurrent cart
// mutation between the two reads), not a structural gap in either read on
// its own.
export type CheckoutPlanReconciliationResult =
  | { ok: true; plan: CanonicalCheckoutPlan }
  | {
      ok: false;
      code: 'CHECKOUT_PLAN_MISMATCH';
      missingFromPriceLock: string[];
      extraInPriceLock: string[];
      quantityMismatchProductIds: string[];
    };

export type PriceLockValidatedResult = { ok: true; cartCurrency: string; items: ValidatedCartPriceLockItem[] };
