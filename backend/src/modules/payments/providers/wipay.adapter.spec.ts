import { createHmac } from 'crypto';

import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { WiPayAdapter } from './wipay.adapter';

function buildConfigService(): { getOrThrow: jest.Mock } {
  const values: Record<string, string> = {
    WIPAY_API_URL: 'https://tx.wipayfinancial.com/plugins/payments',
    WIPAY_ACCOUNT_NUMBER: 'test-account-number',
    WIPAY_API_KEY: 'test-api-key',
    APP_BASE_URL: 'http://localhost:3001',
  };
  return {
    getOrThrow: jest.fn((key: string) => values[key]),
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('WiPayAdapter', () => {
  let configService: { getOrThrow: jest.Mock };
  let adapter: WiPayAdapter;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    configService = buildConfigService();
    adapter = new WiPayAdapter(configService as unknown as ConfigService);
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  describe('createPayment', () => {
    it('returns a redirect url and provider reference on success', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ transaction_id: 'txn-1', url: 'https://tx.wipayfinancial.com/checkout/txn-1' }),
      );

      const result = await adapter.createPayment({
        orderId: 'order-1',
        amount: 1000,
        currency: 'JMD',
      });

      expect(result).toEqual({
        providerReference: 'txn-1',
        redirectUrl: 'https://tx.wipayfinancial.com/checkout/txn-1',
        status: 'PENDING',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://tx.wipayfinancial.com/plugins/payments/request',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws BadGatewayException when WiPay rejects the request', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, false));

      await expect(
        adapter.createPayment({ orderId: 'order-1', amount: 1000, currency: 'JMD' }),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  describe('verifyPayment', () => {
    it.each([
      ['success', 'PAID'],
      ['failed', 'FAILED'],
      ['pending', 'PENDING'],
    ] as const)('maps WiPay status %s to %s', async (wipayStatus, expected) => {
      fetchMock.mockResolvedValue(jsonResponse({ transaction_id: 'txn-1', status: wipayStatus }));

      const result = await adapter.verifyPayment('txn-1');
      expect(result).toEqual({ providerReference: 'txn-1', status: expected });
    });

    it('throws BadGatewayException when the status lookup fails', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, false));
      await expect(adapter.verifyPayment('txn-1')).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  describe('refundPayment', () => {
    it('reports a completed refund', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ refund_id: 'refund-1', status: 'success' }));
      const result = await adapter.refundPayment('txn-1', 500, 'Vendor rejected order');
      expect(result).toEqual({ providerReference: 'refund-1', status: 'COMPLETED' });
    });

    it('reports a failed refund', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ refund_id: 'refund-1', status: 'failed' }));
      const result = await adapter.refundPayment('txn-1', 500, 'Vendor rejected order');
      expect(result.status).toBe('FAILED');
    });

    it('throws BadGatewayException when WiPay rejects the refund request', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, false));
      await expect(
        adapter.refundPayment('txn-1', 500, 'Vendor rejected order'),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  describe('verifyWebhookSignature', () => {
    it('accepts a signature computed with the configured API key', () => {
      const rawBody = JSON.stringify({ transaction_id: 'txn-1', status: 'success' });
      const signature = createHmac('sha256', 'test-api-key').update(rawBody).digest('hex');
      expect(adapter.verifyWebhookSignature(rawBody, signature)).toBe(true);
    });

    it('rejects a signature that does not match', () => {
      const rawBody = JSON.stringify({ transaction_id: 'txn-1', status: 'success' });
      expect(adapter.verifyWebhookSignature(rawBody, 'not-the-right-signature')).toBe(false);
    });
  });
});
