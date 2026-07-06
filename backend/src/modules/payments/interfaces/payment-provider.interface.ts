import { PaymentProviderName } from '@prisma/client';

export interface PaymentCreateInput {
  orderId: string;
  amount: number;
  currency: string;
}

export interface PaymentCreateResult {
  providerReference: string;
  redirectUrl?: string;
  status: 'PENDING' | 'PAID';
}

export interface PaymentVerifyResult {
  status: 'PENDING' | 'PAID' | 'FAILED';
  providerReference: string;
}

export interface PaymentRefundResult {
  providerReference: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
}

/**
 * Per docs/integrations/ADR-001-payment-provider-selection.md: business logic
 * (OrdersService, VendorOrdersService, controllers) must never call a payment
 * provider's API directly - only through PaymentsService, which delegates to
 * whichever adapter matches Payment.provider. Adding a new provider (Fygaro,
 * Stripe Connect) means writing one adapter, not touching Orders/Vendors.
 */
export interface PaymentProviderAdapter {
  readonly name: PaymentProviderName;
  createPayment(input: PaymentCreateInput): Promise<PaymentCreateResult>;
  verifyPayment(providerReference: string): Promise<PaymentVerifyResult>;
  refundPayment(
    providerReference: string,
    amount: number,
    reason: string,
  ): Promise<PaymentRefundResult>;
}
