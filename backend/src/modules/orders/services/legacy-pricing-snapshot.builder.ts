import { CartWithItems } from '../../cart/repositories/cart.repository';
import { OrderPricingSnapshot } from '../types/order-pricing-snapshot.types';

// Phase 16A.0-D, Unit D.1.1. Legacy-only: builds a pricing snapshot from
// today's live Product.price with a null currency, so
// OrdersService.createOrderInTransaction's persisted unitPrice/subtotal
// arithmetic and Order.currency/OrderItem.currency (both stay null, exactly
// as before this unit) are byte-for-byte unchanged from pre-D.1.1 behavior.
// Never reused by the future Phase-D CheckoutCoordinatorService, which
// builds its own snapshot exclusively from PriceLockService's locked
// values - never from Product.price.
export function buildLegacyPricingSnapshot(cart: CartWithItems): OrderPricingSnapshot {
  return {
    currency: null,
    items: cart.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: item.product.price,
    })),
  };
}
