import { createHash } from 'crypto';

import {
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  RefundObligationStatus,
  RefundObligationType,
  RefundStatus,
} from '@prisma/client';

import { MissingRefundIdempotencyKeyException } from '../errors/refund-dispatch.errors';

export interface LockedRefundPaymentRow {
  id: string;
  orderId: string;
  status: PaymentStatus;
  amount: Prisma.Decimal;
  currency: string;
  provider: PaymentProviderName;
  merchantAccountId: string;
  providerReference: string | null;
}

export const ACTIVE_OBLIGATION_NON_VOID_STATUSES: RefundObligationStatus[] = [
  RefundObligationStatus.OPEN,
  RefundObligationStatus.IN_FLIGHT,
  RefundObligationStatus.PENDING_PROVIDER,
  RefundObligationStatus.RECONCILE_REQUIRED,
  RefundObligationStatus.FULFILLED,
];

interface OptionalObligationTxClient {
  refundObligation?: {
    findMany: (args: {
      where: { paymentId: string; status: { not: RefundObligationStatus } };
      select: { authorizedAmount: true };
    }) => Promise<Array<{ authorizedAmount: Prisma.Decimal | number | string }>>;
  };
}

export async function lockRefundFinancialHierarchy(
  tx: Prisma.TransactionClient,
  paymentId: string,
  hintOrderId?: string | null,
): Promise<LockedRefundPaymentRow | null> {
  const rawTx = tx as unknown as {
    $queryRaw?: (q: Prisma.Sql) => Promise<unknown[]>;
    payment?: { findUnique?: (args: unknown) => Promise<LockedRefundPaymentRow | null> };
  };

  if (typeof rawTx.$queryRaw !== 'function') {
    if (rawTx.payment?.findUnique) {
      return rawTx.payment.findUnique({ where: { id: paymentId } });
    }
    return null;
  }

  let effectiveOrderId = hintOrderId ?? null;
  if (!effectiveOrderId) {
    const metaRows = (await rawTx.$queryRaw(
      Prisma.sql`SELECT "orderId" FROM "payments" WHERE "id" = ${paymentId}`,
    )) as Array<{ orderId: string }>;
    if (metaRows.length === 0) {
      return null;
    }
    effectiveOrderId = metaRows[0]?.orderId ?? null;
  }

  if (!effectiveOrderId) {
    return null;
  }

  await rawTx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "orders" WHERE "id" = ${effectiveOrderId} FOR UPDATE`,
  );
  await rawTx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "vendor_orders" WHERE "orderId" = ${effectiveOrderId} ORDER BY "id" ASC FOR UPDATE`,
  );

  const paymentRows = (await rawTx.$queryRaw(
    Prisma.sql`
      SELECT "id", "orderId", "status", "amount", "currency", "provider", "merchantAccountId", "providerReference"
      FROM "payments"
      WHERE "id" = ${paymentId}
      FOR UPDATE
    `,
  )) as LockedRefundPaymentRow[];

  return paymentRows[0] ?? null;
}

export async function lockPaymentObligationsAndRefunds(
  tx: Prisma.TransactionClient,
  paymentId: string,
): Promise<void> {
  const rawTx = tx as unknown as { $queryRaw?: (q: Prisma.Sql) => Promise<unknown[]> };
  if (typeof rawTx.$queryRaw !== 'function') {
    return;
  }

  await rawTx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "refund_obligations" WHERE "paymentId" = ${paymentId} ORDER BY "id" ASC FOR UPDATE`,
  );
  await rawTx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "refunds" WHERE "paymentId" = ${paymentId} ORDER BY "id" ASC FOR UPDATE`,
  );
  await rawTx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "refund_provider_attempts" WHERE "paymentId" = ${paymentId} ORDER BY "id" ASC FOR UPDATE`,
  );
}

export async function computeRemainingRefundCapacityTx(
  tx: Prisma.TransactionClient,
  paymentId: string,
  paymentAmount: Prisma.Decimal | number | string,
  excludeRefundId?: string,
): Promise<{
  obligatedTotal: Prisma.Decimal;
  unlinkedRefundsTotal: Prisma.Decimal;
  remainingBalance: Prisma.Decimal;
}> {
  const optTx = tx as unknown as OptionalObligationTxClient;
  const totalPayment = new Prisma.Decimal(paymentAmount);

  if (optTx.refundObligation?.findMany) {
    const obligations = await optTx.refundObligation.findMany({
      where: {
        paymentId,
        status: { not: RefundObligationStatus.CANCELLED_VOIDED },
      },
      select: { authorizedAmount: true },
    });

    const unlinkedRefunds = (await tx.refund.findMany({
      where: {
        paymentId,
        obligationId: null,
        status: { not: RefundStatus.FAILED },
        ...(excludeRefundId ? { id: { not: excludeRefundId } } : {}),
      },
      select: { amount: true },
    })) as Array<{ amount: Prisma.Decimal | number | string }>;

    const obligatedTotal = obligations.reduce(
      (sum, row) => sum.add(new Prisma.Decimal(row.authorizedAmount)),
      new Prisma.Decimal(0),
    );
    const unlinkedRefundsTotal = unlinkedRefunds.reduce(
      (sum, row) => sum.add(new Prisma.Decimal(row.amount)),
      new Prisma.Decimal(0),
    );
    const remaining = totalPayment.sub(obligatedTotal).sub(unlinkedRefundsTotal);

    return {
      obligatedTotal,
      unlinkedRefundsTotal,
      remainingBalance: remaining.lt(0) ? new Prisma.Decimal(0) : remaining,
    };
  }

  const activeRefunds = (await tx.refund.findMany({
    where: {
      paymentId,
      status: { not: RefundStatus.FAILED },
      ...(excludeRefundId ? { id: { not: excludeRefundId } } : {}),
    },
    select: { amount: true },
  })) as Array<{ amount: Prisma.Decimal | number | string }>;

  const unlinkedRefundsTotal = activeRefunds.reduce(
    (sum, row) => sum.add(new Prisma.Decimal(row.amount)),
    new Prisma.Decimal(0),
  );
  const remaining = totalPayment.sub(unlinkedRefundsTotal);
  return {
    obligatedTotal: new Prisma.Decimal(0),
    unlinkedRefundsTotal,
    remainingBalance: remaining.lt(0) ? new Prisma.Decimal(0) : remaining,
  };
}

export function sha256Hex(payload: unknown): string {
  return createHash('sha256').update(canonicalSerialize(payload)).digest('hex');
}

function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalSerialize(item)).join(',')}]`;
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalSerialize(v)}`).join(',')}}`;
}

const SENSITIVE_KEY_PATTERN =
  /^(?:.*(?:password|secret|token|api[-_]?key|authorization|signature|bearer|private[-_]?key).*)$/i;

function redactSensitiveValues(val: unknown, depth = 0): unknown {
  if (depth > 8 || val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => redactSensitiveValues(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_PATTERN.test(k) ? '[REDACTED]' : redactSensitiveValues(v, depth + 1);
  }
  return out;
}

export function sanitizeRefundPayload(raw: unknown): Prisma.InputJsonValue | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null) {
    return Prisma.JsonNull as unknown as Prisma.InputJsonValue;
  }
  if (typeof raw === 'string') {
    return raw.slice(0, 1000);
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return raw;
  }
  try {
    const redacted = redactSensitiveValues(raw);
    const serialized = JSON.stringify(redacted);
    return JSON.parse(serialized.slice(0, 4000)) as Prisma.InputJsonValue;
  } catch {
    return 'unserializable_payload';
  }
}

export function deriveObligationType(
  idempotencyKey?: string | null,
  explicit?: RefundObligationType,
): RefundObligationType {
  if (explicit) {
    return explicit;
  }
  if (
    idempotencyKey?.startsWith('refund_rejection_') ||
    idempotencyKey?.startsWith('refund_vendor_order_reject_')
  ) {
    return RefundObligationType.VENDOR_ORDER_REJECTION;
  }
  if (idempotencyKey?.startsWith('refund_vendor_order_cancel_')) {
    return RefundObligationType.VENDOR_ORDER_CANCELLATION;
  }
  if (idempotencyKey?.startsWith('refund_order_cancel_')) {
    return RefundObligationType.ORDER_CANCELLATION;
  }
  if (idempotencyKey?.startsWith('refund_post_cancel_')) {
    return RefundObligationType.SETTLED_AFTER_CANCELLATION;
  }
  return RefundObligationType.ADMIN_EXCEPTIONAL_ADJUSTMENT;
}

export function normalizeManualIdempotencyKey(rawKey?: string | null): string {
  if (typeof rawKey !== 'string') {
    throw new MissingRefundIdempotencyKeyException();
  }
  const trimmed = rawKey.trim();
  if (trimmed.length < 8 || trimmed.length > 128 || !/^[A-Za-z0-9:_-]+$/.test(trimmed)) {
    throw new MissingRefundIdempotencyKeyException(
      'Valid Idempotency-Key (8-128 alphanumeric, :, _, - chars) is required for manual refunds',
    );
  }
  return trimmed;
}

export function buildRefundOutboxLogicalKey(params: {
  eventType: string;
  attemptId?: string | null;
  eventSequence?: number | null;
  obligationId?: string | null;
  approvalId?: string | null;
}): string {
  if (params.attemptId && params.eventSequence !== undefined && params.eventSequence !== null) {
    return `refund_outbox:${params.eventType}:att:${params.attemptId}:seq:${params.eventSequence}`;
  }
  if (params.obligationId && params.approvalId) {
    return `refund_outbox:${params.eventType}:obl:${params.obligationId}:appr:${params.approvalId}`;
  }
  return `refund_outbox:${params.eventType}:${params.attemptId ?? params.obligationId ?? 'unknown'}`;
}

export function computeEvidencePayloadDigest(rawPayload: Record<string, unknown> | string): string {
  const payloadStr = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
  return createHash('sha256').update(payloadStr, 'utf8').digest('hex');
}
