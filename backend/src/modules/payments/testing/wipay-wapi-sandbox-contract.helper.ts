import { createHash, createHmac, timingSafeEqual } from 'crypto';

const PRODUCTION_OR_LEGACY_WIPAY_HOSTS = new Set([
  'jm.wipayfinancial.com',
  'tt.wipayfinancial.com',
  'bb.wipayfinancial.com',
  'gy.wipayfinancial.com',
  'api.wipayfinancial.com',
  'tx.wipayfinancial.com',
  'wipayfinancial.com',
]);

export const WIPAY_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface IsolatedWiPaySandboxAuditSummary {
  checkoutApiOrigin: string | null;
  checkoutConfiguredAsJamaicaSandbox: boolean;
  hasCheckoutAccountNumber: boolean;
  hasCheckoutApiKey: boolean;
  hasCheckoutFeeStructure: boolean;
  wapiBaseOrigin: string | null;
  wapiAuthMode: 'oauth2' | 'api_key' | 'missing';
  hasWapiCredentials: boolean;
  hasSandboxRefundableTxnId: boolean;
  hasWebhookSecret: boolean;
}

export interface IsolatedWiPayWapiRuntimeConfig {
  wapiBaseUrl: string;
  authMode: 'oauth2' | 'api_key';
  wapiKey?: string;
  clientId?: string;
  clientSecret?: string;
  merchantAccountId: string;
  refundableSandboxTxnId: string;
  webhookSecret?: string;
}

export interface ResolvedIsolatedWiPaySandboxConfig {
  ready: boolean;
  summary: IsolatedWiPaySandboxAuditSummary;
  missingRequirements: string[];
  errors: string[];
  runtime?: IsolatedWiPayWapiRuntimeConfig;
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  targetName: string,
): string | null {
  const lower = targetName.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower) continue;
    const raw = Array.isArray(v) ? v[0] : v;
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function validateSandboxWapiUrl(
  rawUrl: string | undefined,
  allowedHosts?: string[],
): { ok: true; baseUrl: string; origin: string } | { ok: false; error: string } {
  const trimmed = rawUrl?.trim();
  if (!trimmed) {
    return { ok: false, error: 'Missing WIPAY_WAPI_SANDBOX_BASE_URL' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'WIPAY_WAPI_SANDBOX_BASE_URL is not a valid URL' };
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return { ok: false, error: 'WIPAY_WAPI_SANDBOX_BASE_URL must use HTTPS without userinfo' };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: 'WIPAY_WAPI_SANDBOX_BASE_URL must not contain query or hash' };
  }
  const host = parsed.hostname.toLowerCase();
  if (PRODUCTION_OR_LEGACY_WIPAY_HOSTS.has(host)) {
    return { ok: false, error: `Refused production/legacy WiPay host "${host}" in sandbox mode` };
  }
  const explicitSet = new Set((allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean));
  const isWiPaySubdomain = host.endsWith('.wipayfinancial.com') && host !== 'wipayfinancial.com';
  if (!isWiPaySubdomain && !explicitSet.has(host)) {
    return {
      ok: false,
      error: `Unconfirmed sandbox host "${host}"; expected a confirmed WiPay sandbox host`,
    };
  }
  return {
    ok: true,
    baseUrl: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`,
    origin: parsed.origin,
  };
}

export function resolveIsolatedWiPayWapiSandboxConfig(
  env: Record<string, string | undefined> = process.env,
  options?: { allowedWapiHosts?: string[]; requireWebhookSecret?: boolean },
): ResolvedIsolatedWiPaySandboxConfig {
  const checkoutUrlRaw = env.WIPAY_API_URL?.trim();
  let checkoutApiOrigin: string | null = null;
  if (checkoutUrlRaw) {
    try {
      checkoutApiOrigin = new URL(checkoutUrlRaw).origin;
    } catch {
      checkoutApiOrigin = 'invalid_url';
    }
  }
  const checkoutKey = env.WIPAY_API_KEY?.trim() || '';
  const wapiUrlCheck = validateSandboxWapiUrl(
    env.WIPAY_WAPI_SANDBOX_BASE_URL,
    options?.allowedWapiHosts,
  );
  const wapiKey = env.WIPAY_WAPI_KEY?.trim() || '';
  const clientId = env.WIPAY_WAPI_CLIENT_ID?.trim() || '';
  const clientSecret = env.WIPAY_WAPI_CLIENT_SECRET?.trim() || '';
  const txnId = env.WIPAY_SANDBOX_REFUNDABLE_TXN_ID?.trim() || '';
  const webhookSecret = env.WIPAY_SANDBOX_WEBHOOK_SECRET?.trim() || '';

  const hasOAuth = Boolean(clientId && clientSecret);
  const authMode: 'oauth2' | 'api_key' | 'missing' = hasOAuth
    ? 'oauth2'
    : wapiKey
      ? 'api_key'
      : 'missing';

  const missing: string[] = [];
  const errors: string[] = [];

  if (!env.WIPAY_WAPI_SANDBOX_BASE_URL?.trim()) {
    missing.push('WIPAY_WAPI_SANDBOX_BASE_URL (confirmed Jamaica WAPI sandbox base URL)');
  } else if (!wapiUrlCheck.ok) {
    errors.push(wapiUrlCheck.error);
  }
  if (authMode === 'missing') {
    missing.push('WAPI sandbox credentials (WIPAY_WAPI_CLIENT_ID+WIPAY_WAPI_CLIENT_SECRET or WIPAY_WAPI_KEY)');
  }
  if (checkoutKey && (wapiKey === checkoutKey || clientSecret === checkoutKey)) {
    errors.push('Checkout WIPAY_API_KEY cannot be reused as WAPI sandbox credentials');
  }
  if (!txnId) {
    missing.push('WIPAY_SANDBOX_REFUNDABLE_TXN_ID (settled sandbox charge eligible for refund)');
  }
  if (options?.requireWebhookSecret !== false && !webhookSecret) {
    missing.push('WIPAY_SANDBOX_WEBHOOK_SECRET (sandbox webhook HMAC-SHA256 signing secret)');
  }
  if (checkoutKey && webhookSecret && webhookSecret === checkoutKey) {
    errors.push('Checkout WIPAY_API_KEY cannot be reused as WIPAY_SANDBOX_WEBHOOK_SECRET');
  }

  const summary: IsolatedWiPaySandboxAuditSummary = {
    checkoutApiOrigin,
    checkoutConfiguredAsJamaicaSandbox: checkoutApiOrigin === 'https://jmsb.wipayfinancial.com',
    hasCheckoutAccountNumber: Boolean(env.WIPAY_ACCOUNT_NUMBER?.trim()),
    hasCheckoutApiKey: Boolean(checkoutKey),
    hasCheckoutFeeStructure: Boolean(env.WIPAY_FEE_STRUCTURE?.trim()),
    wapiBaseOrigin: wapiUrlCheck.ok ? wapiUrlCheck.origin : null,
    wapiAuthMode: authMode,
    hasWapiCredentials: authMode !== 'missing',
    hasSandboxRefundableTxnId: Boolean(txnId),
    hasWebhookSecret: Boolean(webhookSecret),
  };

  if (missing.length > 0 || errors.length > 0 || !wapiUrlCheck.ok || authMode === 'missing') {
    return { ready: false, summary, missingRequirements: missing, errors };
  }

  return {
    ready: true,
    summary,
    missingRequirements: [],
    errors: [],
    runtime: {
      wapiBaseUrl: wapiUrlCheck.baseUrl,
      authMode,
      ...(wapiKey ? { wapiKey } : {}),
      ...(hasOAuth ? { clientId, clientSecret } : {}),
      merchantAccountId: env.WIPAY_WAPI_MERCHANT_ACCOUNT_ID?.trim() || 'default',
      refundableSandboxTxnId: txnId,
      ...(webhookSecret ? { webhookSecret } : {}),
    },
  };
}

export interface WiPayWebhookVerifyResult {
  valid: boolean;
  reason?: string;
  eventType?: string;
  eventId?: string;
  timestampSec?: number;
  version?: string;
  evidenceDigest: string;
}

export function verifyWiPayWapiWebhookHeaders(params: {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  endpointSecret: string;
  nowEpochSec?: number;
  maxToleranceSec?: number;
}): WiPayWebhookVerifyResult {
  const evidenceDigest = createHash('sha256').update(params.rawBody, 'utf8').digest('hex');
  const secret = params.endpointSecret.trim();
  if (!secret) {
    return { valid: false, reason: 'Missing webhook signing secret', evidenceDigest };
  }

  const eventType = getHeader(params.headers, 'X-WiPay-Webhook-Event');
  const eventId = getHeader(params.headers, 'X-WiPay-Webhook-Id');
  const signature = getHeader(params.headers, 'X-WiPay-Webhook-Signature');
  const timestampRaw = getHeader(params.headers, 'X-WiPay-Webhook-Timestamp');
  const version = getHeader(params.headers, 'X-WiPay-Webhook-Version') ?? undefined;

  if (!eventType || !eventId || !signature || !timestampRaw) {
    return { valid: false, reason: 'Missing required X-WiPay-Webhook-* header(s)', evidenceDigest };
  }
  if (!/^\d{10,13}$/.test(timestampRaw)) {
    return { valid: false, reason: 'Invalid X-WiPay-Webhook-Timestamp format', evidenceDigest };
  }
  const timestampSec =
    timestampRaw.length === 13 ? Math.floor(Number(timestampRaw) / 1000) : Number(timestampRaw);
  const nowSec = params.nowEpochSec ?? Math.floor(Date.now() / 1000);
  const tolerance = params.maxToleranceSec ?? WIPAY_WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(nowSec - timestampSec) > tolerance) {
    return { valid: false, reason: 'Webhook timestamp outside replay tolerance', evidenceDigest };
  }

  const normalizedSig = signature.replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedSig)) {
    return { valid: false, reason: 'Malformed webhook signature hex format', evidenceDigest };
  }
  const expectedHex = createHmac('sha256', secret)
    .update(`${timestampRaw}.${params.rawBody}`, 'utf8')
    .digest('hex');
  if (!timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(normalizedSig, 'hex'))) {
    return { valid: false, reason: 'Webhook HMAC-SHA256 signature mismatch', evidenceDigest };
  }

  return { valid: true, eventType, eventId, timestampSec, version, evidenceDigest };
}

export function classifyWiPayWapiRefundResponse(params: {
  httpStatus: number;
  payload: unknown;
  parentChargeRef: string;
}): { outcome: 'COMPLETED' | 'PENDING' | 'FAILED' | 'AMBIGUOUS'; refundRef: string | null; reason?: string } {
  if (params.httpStatus >= 500 || params.httpStatus === 429 || params.httpStatus === 0) {
    return { outcome: 'AMBIGUOUS', refundRef: null, reason: `Transient HTTP ${params.httpStatus}` };
  }
  if (!params.payload || typeof params.payload !== 'object' || Array.isArray(params.payload)) {
    return { outcome: 'AMBIGUOUS', refundRef: null, reason: 'Non-object WAPI payload' };
  }
  const obj = params.payload as Record<string, unknown>;
  const rawStatus = typeof obj.status === 'string' ? obj.status.trim().toUpperCase() : '';
  const refRaw = obj.refund_id ?? obj.refundId ?? obj.transaction_id;
  const refundRef = typeof refRaw === 'string' && refRaw.trim().length > 0 ? refRaw.trim() : null;

  if (refundRef && refundRef.toLowerCase() === params.parentChargeRef.trim().toLowerCase()) {
    return {
      outcome: 'AMBIGUOUS',
      refundRef: null,
      reason: 'Gateway refund reference echoed parent charge reference',
    };
  }
  if (rawStatus === 'COMPLETED' || rawStatus === 'SUCCEEDED' || rawStatus === 'SETTLED') {
    if (!refundRef) {
      return { outcome: 'AMBIGUOUS', refundRef: null, reason: 'COMPLETED response missing refund reference' };
    }
    return { outcome: 'COMPLETED', refundRef };
  }
  if (rawStatus === 'PENDING' || rawStatus === 'PROCESSING' || rawStatus === 'QUEUED') {
    return { outcome: 'PENDING', refundRef };
  }
  if (rawStatus === 'FAILED' || rawStatus === 'DECLINED' || rawStatus === 'REJECTED') {
    return { outcome: 'FAILED', refundRef };
  }
  return { outcome: 'AMBIGUOUS', refundRef: null, reason: `Unrecognized status "${rawStatus}"` };
}
