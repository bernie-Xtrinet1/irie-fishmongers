import { Prisma } from '@prisma/client';

// Phase 16A.0-D, Unit D.1.1 (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md).
// The exclusive source of durable per-item price and currency for
// OrdersService.createOrderInTransaction - unitPrice is never read from
// Product.price inside the transaction; every price/currency value written
// to Order/OrderItem comes from this snapshot. Legacy OrdersService.checkout
// builds a snapshot from today's live Product.price with a null currency
// (preserving current persisted behavior exactly, see
// buildLegacyPricingSnapshot). The future Phase-D CheckoutCoordinatorService
// will build one exclusively from PriceLockService.validateCartPriceLocks's
// locked values, never from Product.price. Both callers share this one type
// and the one createOrderInTransaction implementation that consumes it - no
// second durable-order write path exists.
//
// currency lives only on the snapshot, never per-line: pricing.currency is
// the single authority persisted to both Order.currency and every
// OrderItem.currency for the whole order - two independent currency values
// that could disagree is exactly the divergence this snapshot exists to
// prevent. It is `string | null` so the legacy snapshot can preserve
// today's unset (null) Order.currency/OrderItem.currency columns rather
// than starting to persist a value neither column has ever stored - that
// would be a legacy persisted-behavior change, not mere type symmetry. The
// Phase-D snapshot always supplies a real locked-currency string.

export interface OrderPricingLine {
  productId: string;
  quantity: number;
  unitPrice: Prisma.Decimal;
}

export interface OrderPricingSnapshot {
  currency: string | null;
  items: OrderPricingLine[];
}
