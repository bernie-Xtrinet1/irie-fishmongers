import { createHash } from 'crypto';

import { BadGatewayException, BadRequestException, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { isWiPayCheckoutUrl, WiPayAdapter, WIPAY_SANDBOX_API_URL } from './wipay.adapter';

describe('WiPay checkout URL environment boundary', () => {
  it.each(['jmsb', 'jm'])(
    'accepts only the configured %s origin without enabling initiation',
    (host) => {
      const apiUrl = `https://${host}.wipayfinancial.com/plugins/payments`;
      expect(isWiPayCheckoutUrl(`https://${host}.wipayfinancial.com/checkout/txn-1`, apiUrl)).toBe(
        true,
      );
      const other = host === 'jm' ? 'jmsb' : 'jm';
      expect(isWiPayCheckoutUrl(`https://${other}.wipayfinancial.com/checkout/txn-1`, apiUrl)).toBe(
        false,
      );
      expect(isWiPayCheckoutUrl(`http://${host}.wipayfinancial.com/checkout/txn-1`, apiUrl)).toBe(
        false,
      );
      expect(
        isWiPayCheckoutUrl(`https://user:pass@${host}.wipayfinancial.com/checkout`, apiUrl),
      ).toBe(false);
    },
  );

  it('rejects malformed URLs and unrecognized configured origins', () => {
    expect(isWiPayCheckoutUrl('not-a-url', WIPAY_SANDBOX_API_URL)).toBe(false);
    expect(
      isWiPayCheckoutUrl('https://evil.example/checkout', 'https://evil.example/plugins/payments'),
    ).toBe(false);
  });
});

describe('WiPayAdapter', () => {
  let values: Record<string, string>;
  let adapter: WiPayAdapter;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  const input = {
    orderId: 'order-1',
    amount: 1000,
    currency: 'JMD',
    customerEmail: 'customer+test@example.com',
  };
  const bootstrap = {
    transaction_id: 'txn-1',
    url: 'https://jmsb.wipayfinancial.com/checkout/txn-1',
  };

  beforeEach(() => {
    values = {
      WIPAY_API_URL: WIPAY_SANDBOX_API_URL,
      WIPAY_ACCOUNT_NUMBER: '1234567890',
      WIPAY_API_KEY: 'test-api-key',
      WIPAY_FEE_STRUCTURE: 'merchant_absorb',
      APP_BASE_URL: 'http://localhost:3001',
      API_PREFIX: 'api/v1',
    };
    adapter = new WiPayAdapter({ getOrThrow: (key: string) => values[key] } as ConfigService);
    fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify(bootstrap)));
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends the complete Jamaica sandbox form without authorization or idempotency headers', async () => {
    await expect(adapter.createPayment(input)).resolves.toEqual({
      providerReference: 'txn-1',
      redirectUrl: bootstrap.url,
      status: 'PENDING',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://jmsb.wipayfinancial.com/plugins/payments/request');
    expect(request.method).toBe('POST');
    expect(request.redirect).toBe('error');
    expect(request.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    });
    expect(Object.fromEntries(new URLSearchParams(request.body as string))).toEqual({
      account_number: '1234567890',
      country_code: 'JM',
      currency: 'JMD',
      environment: 'sandbox',
      fee_structure: 'merchant_absorb',
      method: 'credit_card_co',
      order_id: 'order-1',
      origin: 'IrieFishmongers',
      response_url: 'http://localhost:3001/api/v1/payments/returns/wipay',
      total: '1000.00',
      email: input.customerEmail,
    });
    expect(request.body).toContain('customer%2Btest%40example.com');
    expect(request.body).not.toContain(values.WIPAY_API_KEY);
  });

  it.each(['customer_pay', 'merchant_absorb', 'split'])(
    'uses configured fee structure %s and API prefix',
    async (fee) => {
      values.WIPAY_FEE_STRUCTURE = fee;
      values.API_PREFIX = '/custom/v2/';
      values.APP_BASE_URL = 'https://api.example.com/';
      await adapter.createPayment(input);
      const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = new URLSearchParams(request.body as string);
      expect(body.get('fee_structure')).toBe(fee);
      expect(body.get('response_url')).toBe(
        'https://api.example.com/custom/v2/payments/returns/wipay',
      );
    },
  );

  it.each([
    null,
    [],
    'invalid',
    {},
    { url: bootstrap.url },
    { transaction_id: 'txn-1' },
    { ...bootstrap, transaction_id: '' },
    { ...bootstrap, transaction_id: 42 },
    { ...bootstrap, transaction_id: ' txn-1' },
    { ...bootstrap, url: '' },
    { ...bootstrap, url: 'not-a-url' },
    { ...bootstrap, url: 'javascript:alert(1)' },
    { ...bootstrap, url: 'http://jmsb.wipayfinancial.com/checkout' },
    { ...bootstrap, url: 'https://evil.example/checkout' },
    { ...bootstrap, url: 'https://user:pass@jmsb.wipayfinancial.com/checkout' },
  ])('rejects malformed or unsafe bootstrap %j without retry', async (body) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(adapter.createPayment(input)).rejects.toBeInstanceOf(BadGatewayException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed JSON without retry', async () => {
    fetchMock.mockResolvedValue(new Response('{broken'));
    await expect(adapter.createPayment(input)).rejects.toBeInstanceOf(BadGatewayException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([302, 400, 401, 500, 503])('rejects HTTP %s without retry', async (status) => {
    fetchMock.mockResolvedValue(new Response('{}', { status }));
    await expect(adapter.createPayment(input)).rejects.toBeInstanceOf(BadGatewayException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates ambiguous network failure without retry', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));
    await expect(adapter.createPayment(input)).rejects.toThrow('timeout');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { currency: 'USD' },
    { amount: NaN },
    { amount: 0 },
    { amount: -1 },
    { customerEmail: undefined },
    { customerEmail: 'invalid' },
    { customerEmail: 'x'.repeat(50) + '@example.com' },
  ])('rejects invalid sandbox input %j before any request', async (override) => {
    await expect(adapter.createPayment({ ...input, ...override })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'https://jm.wipayfinancial.com/plugins/payments',
    'https://tx.wipayfinancial.com/plugins/payments',
  ])('rejects non-sandbox host %s', async (url) => {
    values.WIPAY_API_URL = url;
    await expect(adapter.createPayment(input)).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an explicit valid fee policy', async () => {
    values.WIPAY_FEE_STRUCTURE = '';
    await expect(adapter.createPayment(input)).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on status and refund without making provider calls', async () => {
    await expect(adapter.verifyPayment('txn-1')).rejects.toBeInstanceOf(NotImplementedException);
    await expect(adapter.refundPayment('txn-1', 100, 'reason')).rejects.toBeInstanceOf(
      NotImplementedException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('transaction response hash', () => {
    const valid = {
      transaction_id: 'txn-1',
      status: 'success',
      total: '1200.00',
      hash: createHash('md5')
        .update('txn-1' + '1000.00' + 'test-api-key')
        .digest('hex'),
    };
    it('verifies using the original total, ignoring the customer-facing total and unsigned identity fields', () => {
      expect(
        adapter.verifyTransactionResponse(
          { ...valid, order_id: 'attacker', currency: 'USD' },
          'txn-1',
          '1000.00',
        ),
      ).toBe(true);
      expect(adapter.verifyTransactionResponse(valid, 'txn-1', '1200.00')).toBe(false);
      expect(adapter.verifyTransactionResponse(valid, 'different', '1000.00')).toBe(false);
      expect(adapter.verifyTransactionResponse(valid, 'txn-1', '1000')).toBe(false);
    });
    it.each([
      undefined,
      null,
      '',
      '0'.repeat(32),
      'z'.repeat(32),
      'a'.repeat(31),
      ['a'.repeat(32)],
      42,
    ])('rejects invalid hash %j', (hash) => {
      expect(adapter.verifyTransactionResponse({ ...valid, hash }, 'txn-1', '1000.00')).toBe(false);
    });
    it.each(['failed', 'error', 'pending', undefined])(
      'never authenticates status %s using a success hash',
      (status) => {
        expect(adapter.verifyTransactionResponse({ ...valid, status }, 'txn-1', '1000.00')).toBe(
          false,
        );
      },
    );
  });
});
