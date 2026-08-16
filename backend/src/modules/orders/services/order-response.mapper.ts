import { OrderResponseEntity } from '../entities/order-response.entity';
import { OrderWithDetails } from '../repositories/orders.repository';

// Extracted from OrdersService purely to keep that file within the
// repository's 400-line limit once the CART_SCOPED activation-boundary
// gate's mutation-barrier wiring was added - a pure, stateless mapping
// function with no dependency of its own, matching this module's existing
// sibling-file pattern (legacy-pricing-snapshot.builder.ts,
// order-pricing-snapshot.validator.ts).
export function toOrderResponse(order: OrderWithDetails): OrderResponseEntity {
  return {
    id: order.id,
    customerId: order.customerId,
    deliveryAddressLine1: order.deliveryAddressLine1,
    deliveryAddressLine2: order.deliveryAddressLine2,
    deliveryParish: order.deliveryParish,
    deliveryPhone: order.deliveryPhone,
    deliveryZoneId: order.deliveryZoneId,
    createdAt: order.createdAt,
    vendorOrders: order.vendorOrders.map((vendorOrder) => ({
      id: vendorOrder.id,
      orderId: vendorOrder.orderId,
      vendorId: vendorOrder.vendorId,
      status: vendorOrder.status,
      subtotal: vendorOrder.subtotal.toString(),
      createdAt: vendorOrder.createdAt,
      items: vendorOrder.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        productName: item.productName,
        unitPrice: item.unitPrice.toString(),
        unit: item.unit,
        quantity: item.quantity,
        subtotal: item.subtotal.toString(),
      })),
    })),
  };
}
