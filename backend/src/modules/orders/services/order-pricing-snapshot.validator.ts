import { CartWithItems } from '../../cart/repositories/cart.repository';
import { OrderPricingLine, OrderPricingSnapshot } from '../types/order-pricing-snapshot.types';

// Phase 16A.0-D, Unit D.1.1. Verifies a pricing snapshot exactly
// corresponds to the prepared cart before OrdersService.createOrderInTransaction
// performs any durable write - the required invariant is
// set(cart.items.productId) == set(pricing.items.productId), with matching
// quantities for every product. Every violation is an internal consistency
// error (never a normal result, never silently tolerated): a duplicate
// pricing line, a pricing line for a product absent from the cart, a cart
// item with no pricing line, or a quantity mismatch.
//
// There is no separate `pricing.items.length !== cart.items.length` check:
// once duplicates are rejected and every pricing productId is proven to be
// in the cart (the "extra" check below) and every cart productId is proven
// to have a pricing line (the "missing" check below), the two sets are
// already provably equal - a standalone length comparison could never fire
// on its own input and would be dead code. Both directions of a length
// mismatch are still fully rejected, just reported as "extra" or "missing"
// depending on which set has the surplus/gap.
export function validatePricingSnapshot(
  cart: CartWithItems,
  pricing: OrderPricingSnapshot,
): Map<string, OrderPricingLine> {
  const pricingByProductId = new Map<string, OrderPricingLine>();
  for (const line of pricing.items) {
    if (pricingByProductId.has(line.productId)) {
      throw new Error(
        `Internal consistency error: pricing snapshot has a duplicate line for product ${line.productId}`,
      );
    }
    pricingByProductId.set(line.productId, line);
  }

  const cartProductIds = new Set(cart.items.map((item) => item.productId));
  for (const productId of pricingByProductId.keys()) {
    if (!cartProductIds.has(productId)) {
      throw new Error(
        `Internal consistency error: pricing snapshot has an extra line for product ${productId}`,
      );
    }
  }

  for (const item of cart.items) {
    const pricingLine = pricingByProductId.get(item.productId);
    if (!pricingLine) {
      throw new Error(`Internal consistency error: no pricing line for product ${item.productId}`);
    }
    if (pricingLine.quantity !== item.quantity) {
      throw new Error(
        `Internal consistency error: pricing quantity ${pricingLine.quantity} != cart quantity ` +
          `${item.quantity} for product ${item.productId}`,
      );
    }
  }

  return pricingByProductId;
}
