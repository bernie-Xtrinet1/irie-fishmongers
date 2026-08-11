import { CheckoutMarkResult } from '../../inventory/services/checkout-reservation-state.types';
import { mapCheckoutMarkFailureCode } from './checkout-mark-failure-mapper';

describe('mapCheckoutMarkFailureCode', () => {
  it('prefixes a checkoutMark failure code with CHECKOUT_MARK_', () => {
    const result: Exclude<CheckoutMarkResult, { ok: true }> = {
      ok: false,
      code: 'RESERVATION_EXPIRED',
      failedProductId: 'product-1',
    };
    expect(mapCheckoutMarkFailureCode(result)).toBe('CHECKOUT_MARK_RESERVATION_EXPIRED');
  });

  it('throws an internal consistency error if a future failure code would exceed 64 characters', () => {
    const result = {
      ok: false,
      code: 'A_HYPOTHETICAL_FUTURE_FAILURE_CODE_THAT_IS_FAR_TOO_LONG_TO_FIT',
    } as unknown as Exclude<CheckoutMarkResult, { ok: true }>;
    expect(() => mapCheckoutMarkFailureCode(result)).toThrow(/exceeds 64 characters/);
  });
});
