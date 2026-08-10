import { CheckoutDto } from '../dto/checkout.dto';
import { CartWithItems } from '../../cart/repositories/cart.repository';

// Phase 16A.0-D, Unit D.1 (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md).
// OrdersService.checkout's pre-transaction validation, extracted into a
// typed result so a second caller (the future CheckoutCoordinatorService)
// can react to a failure without parsing HTTP exception message text. Every
// failure variant below corresponds to one of the distinct business
// conditions already present in OrdersService.checkout before this
// extraction - never one variant per throw statement, never two
// materially different conditions collapsed into one variant.

export interface PreparedCheckout {
  cart: CartWithItems;
  dto: CheckoutDto;
  deliveryZoneId: string | null;
}

export type PrepareCheckoutFailure =
  | { ok: false; code: 'CART_EMPTY' }
  | { ok: false; code: 'PRODUCT_NOT_AVAILABLE'; productId: string; productName: string }
  | { ok: false; code: 'PRODUCT_FOOD_SAFETY_HOLD'; productId: string; productName: string }
  | { ok: false; code: 'VENDOR_NOT_APPROVED'; productId: string; productName: string }
  | { ok: false; code: 'VENDOR_SALES_LIMIT_EXCEEDED'; vendorId: string; message: string };

export type PrepareCheckoutResult = { ok: true; prepared: PreparedCheckout } | PrepareCheckoutFailure;
