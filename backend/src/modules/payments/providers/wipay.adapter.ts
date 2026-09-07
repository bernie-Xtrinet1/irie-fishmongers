import { createHash, timingSafeEqual } from 'crypto';

import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotImplementedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProviderName } from '@prisma/client';
import { isEmail } from 'class-validator';

import {
  PaymentCreateInput,
  PaymentCreateResult,
  PaymentProviderAdapter,
  PaymentRefundResult,
  PaymentVerifyResult,
} from '../interfaces/payment-provider.interface';

export const WIPAY_SANDBOX_API_URL = 'https://jmsb.wipayfinancial.com/plugins/payments';

// URL validation follows the configured Jamaica environment. This does not
// authorize live initiation: createPayment retains its explicit F.4 sandbox gate.
export function isWiPayCheckoutUrl(url: string, apiUrl: string): boolean {
  if (![WIPAY_SANDBOX_API_URL, 'https://jm.wipayfinancial.com/plugins/payments'].includes(apiUrl)) {
    return false;
  }
  try {
    const checkoutUrl = new URL(url);
    return (
      checkoutUrl.protocol === 'https:' &&
      !checkoutUrl.username &&
      !checkoutUrl.password &&
      checkoutUrl.origin === new URL(apiUrl).origin
    );
  } catch {
    return false;
  }
}

// Payments API v1.0.11; this adapter intentionally supports Jamaica sandbox only.
// See docs/integrations/payment-providers.md for sources and unsupported operations.
@Injectable()
export class WiPayAdapter implements PaymentProviderAdapter {
  readonly name = PaymentProviderName.WIPAY;

  constructor(private readonly configService: ConfigService) {}

  async createPayment(input: PaymentCreateInput): Promise<PaymentCreateResult> {
    const apiUrl = this.configService.getOrThrow<string>('WIPAY_API_URL');
    const feeStructure = this.configService.getOrThrow<string>('WIPAY_FEE_STRUCTURE');
    if (apiUrl !== WIPAY_SANDBOX_API_URL || input.currency !== 'JMD') {
      throw new BadRequestException('WiPay supports Jamaica JMD sandbox payments only');
    }
    if (!['customer_pay', 'merchant_absorb', 'split'].includes(feeStructure)) {
      throw new BadRequestException('WiPay fee structure must be explicitly configured');
    }
    if (
      !Number.isFinite(input.amount) ||
      input.amount <= 0 ||
      !input.customerEmail ||
      !isEmail(input.customerEmail) ||
      input.customerEmail.length > 50
    ) {
      throw new BadRequestException(
        'WiPay requires a positive total and valid customer email (max 50 characters)',
      );
    }
    const appBaseUrl = this.configService.getOrThrow<string>('APP_BASE_URL').replace(/\/$/, '');
    const apiPrefix = this.configService.getOrThrow<string>('API_PREFIX').replace(/^\/+|\/+$/g, '');
    const response = await fetch(`${apiUrl}/request`, {
      method: 'POST',
      // Do not follow a provider redirect that could repeat this non-idempotent POST.
      redirect: 'error',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        account_number: this.configService.getOrThrow<string>('WIPAY_ACCOUNT_NUMBER'),
        country_code: 'JM',
        currency: input.currency,
        environment: 'sandbox',
        fee_structure: feeStructure,
        method: 'credit_card_co',
        order_id: input.orderId,
        origin: 'IrieFishmongers',
        response_url: `${appBaseUrl}/${apiPrefix}/payments/returns/wipay`,
        total: input.amount.toFixed(2),
        email: input.customerEmail,
      }).toString(),
    });

    if (!response.ok) {
      throw new BadGatewayException('WiPay rejected the payment request');
    }

    try {
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      const { transaction_id: reference, url } = data as Record<string, unknown>;
      if (
        typeof reference !== 'string' ||
        !reference.trim() ||
        reference !== reference.trim() ||
        typeof url !== 'string' ||
        !url.trim()
      )
        throw new Error();
      if (!isWiPayCheckoutUrl(url, apiUrl)) throw new Error();
      return { providerReference: reference, redirectUrl: url, status: 'PENDING' };
    } catch {
      // The session may exist even when the bootstrap is unusable. Never retry here.
      throw new BadGatewayException('WiPay returned an invalid hosted checkout response');
    }
  }

  verifyPayment(_providerReference: string): Promise<PaymentVerifyResult> {
    return Promise.reject(
      new NotImplementedException(
        'WiPay Payments API status lookup is unsupported; reconciliation remains unresolved',
      ),
    );
  }

  refundPayment(
    _providerReference: string,
    _amount: number,
    _reason: string,
  ): Promise<PaymentRefundResult> {
    return Promise.reject(
      new NotImplementedException('WiPay Payments API refunds are unsupported'),
    );
  }

  verifyTransactionResponse(
    payload: Record<string, unknown>,
    providerReference: string,
    originalTotal: string,
  ): boolean {
    if (
      payload.status !== 'success' ||
      payload.transaction_id !== providerReference ||
      !providerReference ||
      !/^\d+\.\d{2}$/.test(originalTotal) ||
      typeof payload.hash !== 'string' ||
      !/^[a-fA-F0-9]{32}$/.test(payload.hash)
    )
      return false;
    const expected = createHash('md5')
      .update(
        providerReference + originalTotal + this.configService.getOrThrow<string>('WIPAY_API_KEY'),
      )
      .digest();
    return timingSafeEqual(expected, Buffer.from(payload.hash, 'hex'));
  }
}
