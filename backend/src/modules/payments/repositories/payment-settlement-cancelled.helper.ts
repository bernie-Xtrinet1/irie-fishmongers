import { randomUUID } from 'crypto';

import {
  PaymentProviderName,
  PaymentSettlementReceipt,
  PaymentStatus,
  Prisma,
  RefundObligationStatus,
  RefundObligationType,
  RefundStatus,
  SettlementDisposition,
} from '@prisma/client';

import {
  ApplyPaymentSettlementCommand,
  SettlementExecutionResult,
} from '../types/payment-settlement.types';
import { lockPaymentObligationsAndRefunds } from './refund-locks.helper';

export interface LockedSettlementPayment {
  id: string;
  orderId: string;
  provider: PaymentProviderName;
  merchantAccountId: string;
  status: PaymentStatus;
  amount: Prisma.Decimal;
  currency: string;
  providerReference: string | null;
}

export async function recordSettlementReceiptTx(
  tx: Prisma.TransactionClient,
  input: {
    provider: PaymentProviderName;
    merchantAccountId: string;
    eventId: string;
    gatewayTxnId: string;
    disposition: SettlementDisposition;
    sourceIp?: string | null;
    signatureValid?: boolean;
  },
): Promise<PaymentSettlementReceipt> {
  return tx.paymentSettlementReceipt.create({
    data: {
      provider: input.provider,
      merchantAccountId: input.merchantAccountId,
      eventId: input.eventId,
      gatewayTxnId: input.gatewayTxnId,
      disposition: input.disposition,
      sourceIp: input.sourceIp ?? null,
      signatureValid: input.signatureValid ?? false,
    },
  });
}

export async function rejectSettlementConflictTx(
  tx: Prisma.TransactionClient,
  command: ApplyPaymentSettlementCommand,
  payment: Pick<LockedSettlementPayment, 'id' | 'orderId' | 'status'>,
  message: string,
  extra?: Partial<Pick<SettlementExecutionResult, 'settlementEventId' | 'resultingPaymentStatus'>>,
): Promise<SettlementExecutionResult> {
  const receipt = await recordSettlementReceiptTx(tx, {
    provider: command.provider,
    merchantAccountId: command.merchantAccountId,
    eventId: command.eventId,
    gatewayTxnId: command.gatewayTxnId,
    disposition: SettlementDisposition.CONFLICT_REJECTED,
    sourceIp: command.evidence.sourceIp,
    signatureValid: command.evidence.signatureValid ?? false,
  });

  return {
    applied: false,
    disposition: SettlementDisposition.CONFLICT_REJECTED,
    paymentId: payment.id,
    orderId: payment.orderId,
    resultingPaymentStatus: extra?.resultingPaymentStatus ?? payment.status,
    ...(extra?.settlementEventId ? { settlementEventId: extra.settlementEventId } : {}),
    receiptId: receipt.id,
    message,
  };
}

export async function applyCancelledOrderLateSettlementTx(
  tx: Prisma.TransactionClient,
  command: ApplyPaymentSettlementCommand,
  currentPayment: LockedSettlementPayment,
  commandAmountDecimal: Prisma.Decimal,
  targetProviderReference: string,
): Promise<SettlementExecutionResult> {
  await tx.payment.update({
    where: { id: currentPayment.id },
    data: {
      status: PaymentStatus.PAID,
      paidAt: new Date(),
      providerReference: targetProviderReference,
      failureReason: null,
    },
  });

  const settlementEvent = await tx.paymentSettlementEvent.create({
    data: {
      provider: command.provider,
      merchantAccountId: command.merchantAccountId,
      eventId: command.eventId,
      paymentId: currentPayment.id,
      orderId: currentPayment.orderId,
      checkoutAttemptId: command.checkoutAttemptId ?? null,
      gatewayTxnId: command.gatewayTxnId,
      amount: commandAmountDecimal,
      currency: command.currency,
      outcome: PaymentStatus.PAID,
      provenance: command.evidence.provenance,
      disposition: SettlementDisposition.SETTLED_AFTER_CANCELLATION,
      evidenceDigest: command.evidence.evidenceDigest,
      sanitizedPayload: sanitizeSettlementPayload(command.evidence.rawPayload),
      eventTimestamp: command.evidence.eventTimestamp,
    },
  });

  await lockPaymentObligationsAndRefunds(tx, currentPayment.id);

  // Idempotent Obligation + Refund generation with NULL providerReference (never store charge txn ID on refund!)
  const refundKey = `refund_post_cancel_${currentPayment.id}`;
  const obligationKey = `late_settlement:${currentPayment.id}`;

  let obligation = await tx.refundObligation.findUnique({ where: { obligationKey } });
  if (!obligation) {
    obligation = await tx.refundObligation.create({
      data: {
        id: randomUUID(),
        paymentId: currentPayment.id,
        orderId: currentPayment.orderId,
        obligationKey,
        obligationType: RefundObligationType.SETTLED_AFTER_CANCELLATION,
        authorizedAmount: commandAmountDecimal,
        currency: currentPayment.currency,
        reason: 'Late settlement for cancelled order',
        status: RefundObligationStatus.OPEN,
      },
    });
  }

  let refund = await tx.refund.findUnique({ where: { idempotencyKey: refundKey } });
  if (!refund) {
    refund = await tx.refund.create({
      data: {
        id: randomUUID(),
        idempotencyKey: refundKey,
        paymentId: currentPayment.id,
        obligationId: obligation.id,
        amount: commandAmountDecimal,
        reason: 'Late settlement for cancelled order',
        status: RefundStatus.REQUIRED,
        providerReference: null,
      },
    });
  } else if (!refund.obligationId) {
    refund = await tx.refund.update({
      where: { id: refund.id },
      data: { obligationId: obligation.id },
    });
  }

  const receipt = await recordSettlementReceiptTx(tx, {
    provider: command.provider,
    merchantAccountId: command.merchantAccountId,
    eventId: command.eventId,
    gatewayTxnId: command.gatewayTxnId,
    disposition: SettlementDisposition.SETTLED_AFTER_CANCELLATION,
    sourceIp: command.evidence.sourceIp,
    signatureValid: command.evidence.signatureValid ?? true,
  });

  const outbox = await tx.paymentOutbox.create({
    data: {
      aggregateId: currentPayment.id,
      aggregateType: 'Payment',
      eventType: 'PAYMENT_SETTLED_AFTER_CANCELLATION',
      payload: {
        paymentId: currentPayment.id,
        orderId: currentPayment.orderId,
        amount: commandAmountDecimal.toString(),
        currency: command.currency,
        settlementEventId: settlementEvent.id,
        obligationId: obligation.id,
        refundId: refund.id,
        refundStatus: refund.status,
        timestamp: new Date().toISOString(),
      },
      published: false,
    },
  });

  return {
    applied: true,
    disposition: SettlementDisposition.SETTLED_AFTER_CANCELLATION,
    paymentId: currentPayment.id,
    orderId: currentPayment.orderId,
    resultingPaymentStatus: PaymentStatus.PAID,
    settlementEventId: settlementEvent.id,
    receiptId: receipt.id,
    refundId: refund.id,
    refundStatus: refund.status,
    outboxEventId: outbox.id,
    message: 'Payment settled after order cancellation. Refund required generated.',
  };
}

export function sanitizeSettlementPayload(
  payload: Record<string, unknown> | string,
): Prisma.InputJsonValue {
  try {
    let obj: Record<string, unknown>;
    if (typeof payload === 'string') {
      obj = JSON.parse(payload) as Record<string, unknown>;
    } else if (typeof payload === 'object' && payload !== null) {
      obj = { ...payload };
    } else {
      return { raw: String(payload) };
    }

    const sensitivePatterns = [
      'cvv',
      'cvc',
      'cardnumber',
      'pan',
      'securitycode',
      'password',
      'token',
      'secret',
      'apikey',
      'authorization',
    ];

    const redact = (target: unknown): unknown => {
      if (target === null || target === undefined) return target;
      if (typeof target !== 'object') return target;
      if (Array.isArray(target)) return target.map(redact);

      const copy: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(target as Record<string, unknown>)) {
        const lowerKey = key.toLowerCase();
        if (sensitivePatterns.some((p) => lowerKey.includes(p))) {
          copy[key] = '***REDACTED***';
        } else if (typeof val === 'object' && val !== null) {
          copy[key] = redact(val);
        } else {
          copy[key] = val;
        }
      }
      return copy;
    };

    return redact(obj) as Prisma.InputJsonValue;
  } catch {
    return { raw: '***UNPARSEABLE_PAYLOAD***' };
  }
}
