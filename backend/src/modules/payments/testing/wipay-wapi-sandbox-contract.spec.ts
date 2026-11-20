import { createHmac } from 'crypto';

import {
  classifyWiPayWapiRefundResponse,
  resolveIsolatedWiPayWapiSandboxConfig,
  verifyWiPayWapiWebhookHeaders,
} from './wipay-wapi-sandbox-contract.helper';

describe('WiPay Jamaica WAPI Sandbox Isolated Contract Harness (Offline)', () => {
  it('reports exact missing WAPI sandbox requirements without leaking checkout or WAPI secrets', () => {
    const resolved = resolveIsolatedWiPayWapiSandboxConfig({
      WIPAY_API_URL: 'https://tx.wipayfinancial.com/plugins/payments',
      WIPAY_ACCOUNT_NUMBER: '1234567890',
      WIPAY_API_KEY: 'synthetic-checkout-key-never-leak',
    });

    expect(resolved.ready).toBe(false);
    expect(resolved.runtime).toBeUndefined();
    expect(resolved.summary).toEqual({
      checkoutApiOrigin: 'https://tx.wipayfinancial.com',
      checkoutConfiguredAsJamaicaSandbox: false,
      hasCheckoutAccountNumber: true,
      hasCheckoutApiKey: true,
      hasCheckoutFeeStructure: false,
      wapiBaseOrigin: null,
      wapiAuthMode: 'missing',
      hasWapiCredentials: false,
      hasSandboxRefundableTxnId: false,
      hasWebhookSecret: false,
    });
    expect(resolved.missingRequirements).toEqual([
      'WIPAY_WAPI_SANDBOX_BASE_URL (confirmed Jamaica WAPI sandbox base URL)',
      'WAPI sandbox credentials (WIPAY_WAPI_CLIENT_ID+WIPAY_WAPI_CLIENT_SECRET or WIPAY_WAPI_KEY)',
      'WIPAY_SANDBOX_REFUNDABLE_TXN_ID (settled sandbox charge eligible for refund)',
      'WIPAY_SANDBOX_WEBHOOK_SECRET (sandbox webhook HMAC-SHA256 signing secret)',
    ]);
    expect(JSON.stringify(resolved)).not.toContain('synthetic-checkout-key-never-leak');
  });

  it('rejects production/legacy URLs and blocks reusing checkout WIPAY_API_KEY for WAPI or webhooks', () => {
    const prodAttempt = resolveIsolatedWiPayWapiSandboxConfig({
      WIPAY_API_URL: 'https://jmsb.wipayfinancial.com/plugins/payments',
      WIPAY_API_KEY: 'shared-checkout-secret',
      WIPAY_WAPI_SANDBOX_BASE_URL: 'https://jm.wipayfinancial.com/wapi',
      WIPAY_WAPI_KEY: 'shared-checkout-secret',
      WIPAY_SANDBOX_REFUNDABLE_TXN_ID: 'sbx-txn-1',
      WIPAY_SANDBOX_WEBHOOK_SECRET: 'shared-checkout-secret',
    });

    expect(prodAttempt.ready).toBe(false);
    expect(prodAttempt.errors).toEqual([
      'Refused production/legacy WiPay host "jm.wipayfinancial.com" in sandbox mode',
      'Checkout WIPAY_API_KEY cannot be reused as WAPI sandbox credentials',
      'Checkout WIPAY_API_KEY cannot be reused as WIPAY_SANDBOX_WEBHOOK_SECRET',
    ]);

    const legacyAttempt = resolveIsolatedWiPayWapiSandboxConfig({
      WIPAY_WAPI_SANDBOX_BASE_URL: 'https://tx.wipayfinancial.com/wapi',
      WIPAY_WAPI_CLIENT_ID: 'cid',
      WIPAY_WAPI_CLIENT_SECRET: 'csec',
      WIPAY_SANDBOX_REFUNDABLE_TXN_ID: 'sbx-txn-1',
      WIPAY_SANDBOX_WEBHOOK_SECRET: 'wh-sec',
    });
    expect(legacyAttempt.ready).toBe(false);
    expect(legacyAttempt.errors[0]).toContain('tx.wipayfinancial.com');
  });

  it('loads separated checkout and WAPI sandbox settings cleanly when valid isolated config is supplied', () => {
    const resolved = resolveIsolatedWiPayWapiSandboxConfig({
      WIPAY_API_URL: 'https://jmsb.wipayfinancial.com/plugins/payments',
      WIPAY_FEE_STRUCTURE: 'merchant_absorb',
      WIPAY_ACCOUNT_NUMBER: '9999000011',
      WIPAY_API_KEY: 'checkout-md5-secret',
      WIPAY_WAPI_SANDBOX_BASE_URL: 'https://jmsb.wipayfinancial.com/wapi/',
      WIPAY_WAPI_CLIENT_ID: 'wapi-client-1',
      WIPAY_WAPI_CLIENT_SECRET: 'wapi-secret-isolated',
      WIPAY_SANDBOX_REFUNDABLE_TXN_ID: 'chg-sbx-100',
      WIPAY_SANDBOX_WEBHOOK_SECRET: 'wh-secret-isolated',
    });

    expect(resolved.ready).toBe(true);
    expect(resolved.errors).toEqual([]);
    expect(resolved.missingRequirements).toEqual([]);
    expect(resolved.summary.checkoutConfiguredAsJamaicaSandbox).toBe(true);
    expect(resolved.summary.wapiBaseOrigin).toBe('https://jmsb.wipayfinancial.com');
    expect(resolved.summary.wapiAuthMode).toBe('oauth2');
    expect(resolved.runtime?.wapiBaseUrl).toBe('https://jmsb.wipayfinancial.com/wapi');
    expect(JSON.stringify(resolved.summary)).not.toContain('checkout-md5-secret');
    expect(JSON.stringify(resolved.summary)).not.toContain('wapi-secret-isolated');
    expect(JSON.stringify(resolved.summary)).not.toContain('wh-secret-isolated');
  });

  it('verifies X-WiPay-Webhook-* HMAC-SHA256 signatures and rejects stale replays or tampered bodies', () => {
    const secret = 'synthetic-wipay-webhook-secret';
    const rawBody = JSON.stringify({ event: 'refund.completed', refund_id: 'wref-1', status: 'COMPLETED' });
    const nowSec = 1_760_000_500;
    const tsHeader = String(nowSec - 45);
    const sigHex = createHmac('sha256', secret).update(`${tsHeader}.${rawBody}`, 'utf8').digest('hex');

    const ok = verifyWiPayWapiWebhookHeaders({
      headers: {
        'x-wipay-webhook-event': 'refund.completed',
        'X-WiPay-Webhook-Id': 'evt-sbx-1',
        'X-WiPay-Webhook-Signature': `sha256=${sigHex}`,
        'X-WiPay-Webhook-Timestamp': tsHeader,
        'X-WiPay-Webhook-Version': '1',
      },
      rawBody,
      endpointSecret: secret,
      nowEpochSec: nowSec,
    });
    expect(ok.valid).toBe(true);
    expect(ok.eventId).toBe('evt-sbx-1');
    expect(ok.eventType).toBe('refund.completed');
    expect(ok.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);

    const tampered = verifyWiPayWapiWebhookHeaders({
      headers: {
        'X-WiPay-Webhook-Event': 'refund.completed',
        'X-WiPay-Webhook-Id': 'evt-sbx-1',
        'X-WiPay-Webhook-Signature': sigHex,
        'X-WiPay-Webhook-Timestamp': tsHeader,
      },
      rawBody: rawBody.replace('wref-1', 'wref-tampered'),
      endpointSecret: secret,
      nowEpochSec: nowSec,
    });
    expect(tampered.valid).toBe(false);
    expect(tampered.reason).toContain('mismatch');

    const staleTs = String(nowSec - 301);
    const staleSig = createHmac('sha256', secret).update(`${staleTs}.${rawBody}`, 'utf8').digest('hex');
    const stale = verifyWiPayWapiWebhookHeaders({
      headers: {
        'X-WiPay-Webhook-Event': 'refund.completed',
        'X-WiPay-Webhook-Id': 'evt-sbx-old',
        'X-WiPay-Webhook-Signature': staleSig,
        'X-WiPay-Webhook-Timestamp': staleTs,
      },
      rawBody,
      endpointSecret: secret,
      nowEpochSec: nowSec,
    });
    expect(stale.valid).toBe(false);
    expect(stale.reason).toContain('replay tolerance');
  });

  it('classifies WAPI pending, duplicate-ref echo, missing-ref completion, declined, and 5xx outcomes safely', () => {
    expect(
      classifyWiPayWapiRefundResponse({
        httpStatus: 202,
        payload: { status: 'PENDING', refund_id: 'wref-pend-1' },
        parentChargeRef: 'wchg-1',
      }),
    ).toEqual({ outcome: 'PENDING', refundRef: 'wref-pend-1' });

    expect(
      classifyWiPayWapiRefundResponse({
        httpStatus: 200,
        payload: { status: 'COMPLETED', refund_id: 'wref-ok-1' },
        parentChargeRef: 'wchg-1',
      }),
    ).toEqual({ outcome: 'COMPLETED', refundRef: 'wref-ok-1' });

    expect(
      classifyWiPayWapiRefundResponse({
        httpStatus: 200,
        payload: { status: 'COMPLETED', refund_id: 'wchg-1' },
        parentChargeRef: 'wchg-1',
      }),
    ).toMatchObject({ outcome: 'AMBIGUOUS', refundRef: null });

    expect(
      classifyWiPayWapiRefundResponse({
        httpStatus: 200,
        payload: { status: 'COMPLETED' },
        parentChargeRef: 'wchg-1',
      }),
    ).toMatchObject({ outcome: 'AMBIGUOUS', refundRef: null });

    expect(
      classifyWiPayWapiRefundResponse({
        httpStatus: 200,
        payload: { status: 'FAILED' },
        parentChargeRef: 'wchg-1',
      }),
    ).toEqual({ outcome: 'FAILED', refundRef: null });

    expect(
      classifyWiPayWapiRefundResponse({
        httpStatus: 503,
        payload: { message: 'Service Unavailable' },
        parentChargeRef: 'wchg-1',
      }),
    ).toMatchObject({ outcome: 'AMBIGUOUS', refundRef: null });
  });
});
