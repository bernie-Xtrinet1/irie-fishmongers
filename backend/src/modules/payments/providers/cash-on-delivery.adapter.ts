import { randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';
import { PaymentProviderName } from '@prisma/client';

import {
  PaymentCreateInput,
  PaymentCreateResult,
  PaymentProviderAdapter,
  PaymentRefundResult,
  PaymentVerifyResult,
} from '../interfaces/payment-provider.interface';

/**
 * No external gateway: cash changes hands at delivery time. "Paid" is
 * confirmed later via an explicit collection-confirmation action (once the
 * Delivery module exists to trigger it; until then, an admin can mark it
 * paid manually), not by polling a provider API.
 */
@Injectable()
export class CashOnDeliveryAdapter implements PaymentProviderAdapter {
  readonly name = PaymentProviderName.CASH_ON_DELIVERY;

  createPayment(input: PaymentCreateInput): Promise<PaymentCreateResult> {
    return Promise.resolve({
      providerReference: `cod-${input.orderId}`,
      status: 'PENDING',
    });
  }

  verifyPayment(providerReference: string): Promise<PaymentVerifyResult> {
    return Promise.resolve({ providerReference, status: 'PENDING' });
  }

  refundPayment(_providerReference: string, _amount: number): Promise<PaymentRefundResult> {
    return Promise.resolve({
      providerReference: `cod-refund-${randomUUID()}`,
      status: 'COMPLETED',
    });
  }
}
