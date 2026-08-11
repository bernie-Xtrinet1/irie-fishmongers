import { Prisma } from '@prisma/client';

import { CartWithItems } from '../../cart/repositories/cart.repository';
import { CheckoutReservationPlanItem } from '../../inventory/services/checkout-reservation-state.types';
import { OrderPricingSnapshot } from '../../orders/types/order-pricing-snapshot.types';
import {
  CanonicalCheckoutPlan,
  CheckoutPlanReconciliationResult,
  PriceLockValidatedResult,
} from '../types/canonical-checkout-plan.types';

// Phase 16A.0-D, Unit D.2. Reconciles OrdersService.prepareCheckout's
// durable cart read against PriceLockService.validateCartPriceLocks's
// locked-price read into one CanonicalCheckoutPlan, before
// CheckoutCoordinatorService creates any CheckoutAttempt or calls
// checkoutMark. Requires an exact productId-set match with agreeing
// quantities between the two reads - anything else is rejected as
// CHECKOUT_PLAN_MISMATCH, never silently reconciled by preferring one
// read over the other.
export function reconcileCheckoutPlan(
  cart: CartWithItems,
  priceLockResult: PriceLockValidatedResult,
): CheckoutPlanReconciliationResult {
  const cartQuantityByProductId = new Map(cart.items.map((item) => [item.productId, item.quantity]));
  const priceLockByProductId = new Map(priceLockResult.items.map((item) => [item.productId, item]));

  const missingFromPriceLock: string[] = [];
  const quantityMismatchProductIds: string[] = [];
  for (const [productId, quantity] of cartQuantityByProductId) {
    const priceLockItem = priceLockByProductId.get(productId);
    if (!priceLockItem) {
      missingFromPriceLock.push(productId);
      continue;
    }
    if (priceLockItem.quantity !== quantity) {
      quantityMismatchProductIds.push(productId);
    }
  }

  const extraInPriceLock: string[] = [];
  for (const productId of priceLockByProductId.keys()) {
    if (!cartQuantityByProductId.has(productId)) {
      extraInPriceLock.push(productId);
    }
  }

  if (
    missingFromPriceLock.length > 0 ||
    extraInPriceLock.length > 0 ||
    quantityMismatchProductIds.length > 0
  ) {
    return {
      ok: false,
      code: 'CHECKOUT_PLAN_MISMATCH',
      missingFromPriceLock,
      extraInPriceLock,
      quantityMismatchProductIds,
    };
  }

  const plan: CanonicalCheckoutPlan = {
    currency: priceLockResult.cartCurrency,
    items: priceLockResult.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      lockedUnitPrice: item.lockedUnitPrice,
    })),
  };

  return { ok: true, plan };
}

// The one derivation of checkoutMark's reservation-quantity plan from the
// canonical plan - never independently rebuilt from cart or price-lock data.
export function toCheckoutMarkItems(plan: CanonicalCheckoutPlan): CheckoutReservationPlanItem[] {
  return plan.items.map((item) => ({ productId: item.productId, expectedQuantity: item.quantity }));
}

// The one derivation of the durable OrderPricingSnapshot from the canonical
// plan - never independently rebuilt, and never falls back to
// item.product.price. lockedUnitPrice is PriceLockService's own decimal
// string; Prisma.Decimal accepts a string constructor argument directly.
export function toOrderPricingSnapshot(plan: CanonicalCheckoutPlan): OrderPricingSnapshot {
  return {
    currency: plan.currency,
    items: plan.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: new Prisma.Decimal(item.lockedUnitPrice),
    })),
  };
}
