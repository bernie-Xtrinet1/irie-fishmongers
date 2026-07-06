import { createHmac } from 'crypto';

import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProviderName } from '@prisma/client';

import {
  PaymentCreateInput,
  PaymentCreateResult,
  PaymentProviderAdapter,
  PaymentRefundResult,
  PaymentVerifyResult,
} from '../interfaces/payment-provider.interface';

interface WiPayRequestResponse {
  transaction_id: string;
  url: string;
}

interface WiPayStatusResponse {
  transaction_id: string;
  status: 'pending' | 'success' | 'failed';
}

interface WiPayRefundResponse {
  refund_id: string;
  status: 'pending' | 'success' | 'failed';
}

// Hosted-checkout request/callback shape based on WiPay's standard merchant
// integration pattern (account_number + total + currency + order reference,
// HMAC-signed callbacks). Endpoint paths and field names should be confirmed
// against a live WiPay merchant sandbox before production use.
@Injectable()
export class WiPayAdapter implements PaymentProviderAdapter {
  readonly name = PaymentProviderName.WIPAY;

  constructor(private readonly configService: ConfigService) {}

  async createPayment(input: PaymentCreateInput): Promise<PaymentCreateResult> {
    const response = await fetch(`${this.apiUrl()}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_number: this.configService.getOrThrow<string>('WIPAY_ACCOUNT_NUMBER'),
        order_id: input.orderId,
        total: input.amount.toFixed(2),
        currency: input.currency,
        response_url: `${this.configService.getOrThrow<string>('APP_BASE_URL')}/api/v1/payments/webhooks/wipay`,
      }),
    });

    if (!response.ok) {
      throw new BadGatewayException('WiPay rejected the payment request');
    }

    const data = (await response.json()) as WiPayRequestResponse;
    return { providerReference: data.transaction_id, redirectUrl: data.url, status: 'PENDING' };
  }

  async verifyPayment(providerReference: string): Promise<PaymentVerifyResult> {
    const response = await fetch(`${this.apiUrl()}/${providerReference}`, {
      headers: { Authorization: `Bearer ${this.apiKey()}` },
    });

    if (!response.ok) {
      throw new BadGatewayException('Unable to verify payment status with WiPay');
    }

    const data = (await response.json()) as WiPayStatusResponse;
    return { providerReference: data.transaction_id, status: WiPayAdapter.mapStatus(data.status) };
  }

  async refundPayment(
    providerReference: string,
    amount: number,
    reason: string,
  ): Promise<PaymentRefundResult> {
    const response = await fetch(`${this.apiUrl()}/${providerReference}/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey()}`,
      },
      body: JSON.stringify({ amount: amount.toFixed(2), reason }),
    });

    if (!response.ok) {
      throw new BadGatewayException('WiPay rejected the refund request');
    }

    const data = (await response.json()) as WiPayRefundResponse;
    return {
      providerReference: data.refund_id,
      status: data.status === 'success' ? 'COMPLETED' : data.status === 'failed' ? 'FAILED' : 'PENDING',
    };
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const expected = createHmac('sha256', this.apiKey()).update(rawBody).digest('hex');
    return expected === signature;
  }

  private apiUrl(): string {
    return this.configService.getOrThrow<string>('WIPAY_API_URL');
  }

  private apiKey(): string {
    return this.configService.getOrThrow<string>('WIPAY_API_KEY');
  }

  private static mapStatus(status: WiPayStatusResponse['status']): PaymentVerifyResult['status'] {
    if (status === 'success') return 'PAID';
    if (status === 'failed') return 'FAILED';
    return 'PENDING';
  }
}
