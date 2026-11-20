import { PaymentProviderName } from '@prisma/client';

export interface PaymentCreateInput {
  orderId: string;
  amount: number;
  currency: string;
  /** Loaded from the stored order's customer by PaymentsService; required by WiPay. */
  customerEmail?: string;
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

export interface PaymentRefundDispatchContext {
  attemptId: string;
  obligationId: string;
  refundId: string;
  providerIdempotencyKey: string;
  attemptSequence: number;
}

export interface PaymentRefundResult {
  providerReference: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  httpStatusCode?: number;
  rawPayload?: unknown;
}

export interface RefundStatusLookupQuery {
  attemptId: string;
  providerIdempotencyKey: string;
  providerRefundReference?: string | null;
  parentPaymentReference?: string | null;
  amount: number;
  currency: string;
  merchantAccountId?: string;
}

export interface PaymentRefundStatusResult {
  outcome: 'PENDING' | 'COMPLETED' | 'FAILED';
  attemptId?: string;
  providerIdempotencyKey?: string;
  providerRefundReference?: string | null;
  parentPaymentReference?: string | null;
  amount?: number | string;
  currency?: string;
  merchantAccountId?: string;
  providerEventId?: string;
  occurredAt?: Date;
  verificationToken?: string;
  httpStatusCode?: number;
  rawPayload?: unknown;
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
  readonly supportsRefundStatusLookup?: boolean;
  createPayment(input: PaymentCreateInput): Promise<PaymentCreateResult>;
  verifyPayment(providerReference: string): Promise<PaymentVerifyResult>;
  refundPayment(
    providerReference: string,
    amount: number,
    reason: string,
    context?: PaymentRefundDispatchContext,
  ): Promise<PaymentRefundResult>;
  verifyRefundStatus?(query: RefundStatusLookupQuery): Promise<PaymentRefundStatusResult>;
}
