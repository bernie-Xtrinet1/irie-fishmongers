import { Prisma } from '@prisma/client';

import { CartWithItems } from '../../cart/repositories/cart.repository';
import { CheckoutDto } from '../../orders/dto/checkout.dto';
import { OrderWithDetails } from '../../orders/repositories/orders.repository';

// Shared fixture builders for CheckoutCoordinatorService's spec files -
// kept here, not duplicated per file, matching this codebase's convention
// for multi-file spec suites of a single unit (e.g.
// inventory-reservations.redis-test-helpers.ts).

export const checkoutDto: CheckoutDto = {
  deliveryAddressLine1: '1 Test Street',
  deliveryParish: 'KINGSTON',
  deliveryPhone: '+18765551234',
  paymentMethod: 'CASH_ON_DELIVERY',
};

export function buildCart(overrides: Partial<CartWithItems> = {}): CartWithItems {
  return {
    id: 'cart-1',
    customerId: 'user-1',
    currency: 'JMD',
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: 'item-1',
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 2,
        lockedUnitPrice: new Prisma.Decimal(500),
        lockedCurrency: 'JMD',
        priceLockedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as CartWithItems['items'][number],
    ],
    ...overrides,
  };
}

export function buildPrepared(cart: CartWithItems = buildCart()) {
  return { cart, dto: checkoutDto, deliveryZoneId: null };
}

export function buildPriceLockOk(
  overrides: { productId?: string; quantity?: number; lockedUnitPrice?: string; currency?: string } = {},
) {
  return {
    ok: true as const,
    cartCurrency: overrides.currency ?? 'JMD',
    items: [
      {
        cartItemId: 'item-1',
        productId: overrides.productId ?? 'product-1',
        quantity: overrides.quantity ?? 2,
        lockedUnitPrice: overrides.lockedUnitPrice ?? '500',
        lockedCurrency: overrides.currency ?? 'JMD',
        priceLockedAt: new Date(),
      },
    ],
  };
}

export function buildAttemptSummary(
  overrides: Partial<{ id: string; orderId: string | null; failureCode: string | null }> = {},
) {
  return {
    id: 'attempt-1',
    idempotencyKey: 'key-1',
    cartId: 'cart-1',
    customerId: 'user-1',
    status: 'PROCESSING' as const,
    orderId: null,
    failureCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastHeartbeatAt: new Date(),
    ...overrides,
  };
}

export function buildOrder(overrides: Partial<OrderWithDetails> = {}): OrderWithDetails {
  return {
    id: 'order-1',
    customerId: 'user-1',
    deliveryAddressLine1: '1 Test Street',
    deliveryAddressLine2: null,
    deliveryParish: 'KINGSTON',
    deliveryPhone: '+18765551234',
    deliveryZoneId: null,
    currency: 'JMD',
    createdAt: new Date(),
    updatedAt: new Date(),
    vendorOrders: [
      {
        id: 'vo-1',
        orderId: 'order-1',
        vendorId: 'vendor-1',
        status: 'PENDING',
        subtotal: new Prisma.Decimal(1000),
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: 'oi-1',
            vendorOrderId: 'vo-1',
            productId: 'product-1',
            productName: 'Fresh Snapper',
            unitPrice: new Prisma.Decimal(500),
            unit: 'PER_POUND',
            quantity: 2,
            subtotal: new Prisma.Decimal(1000),
            currency: 'JMD',
            createdAt: new Date(),
          },
        ],
      },
    ],
    ...overrides,
  };
}
