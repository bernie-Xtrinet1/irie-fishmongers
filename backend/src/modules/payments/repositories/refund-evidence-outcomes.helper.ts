import { randomUUID } from 'crypto';

import { ConflictException } from '@nestjs/common';
import {
  PaymentStatus,
  Prisma,
  RefundAttemptFailureClass,
  RefundAttemptStatus,
  RefundEvidenceDisposition,
  RefundObligation,
  RefundObligationStatus,
  RefundProviderAttempt,
  RefundStatus,
} from '@prisma/client';

import {
  ProcessRefundEvidenceInput,
  ProcessRefundEvidenceResult,
} from '../types/refund-reconciliation.types';
import { getNextEventSequenceTx } from './refund-attempt-quarantine.helper';
import {
  mapEvidenceEventType,
  persistEvidenceReceipt,
} from './refund-evidence-validation.helper';
import {
  buildRefundOutboxLogicalKey,
  LockedRefundPaymentRow,
  sanitizeRefundPayload,
} from './refund-locks.helper';

export async function applyPendingEvidenceTx(
  tx: Prisma.TransactionClient,
  input: ProcessRefundEvidenceInput,
  attempt: RefundProviderAttempt,
  refundStatus: RefundStatus,
  obligation: RefundObligation,
  payment: LockedRefundPaymentRow,
  normalizedDigest: string,
  normalizedRef: string | null,
): Promise<ProcessRefundEvidenceResult> {
  const now = new Date();
  const isQuarantined = attempt.status === RefundAttemptStatus.AMBIGUOUS_OUTCOME;
  const nextAttemptStatus = isQuarantined
    ? RefundAttemptStatus.AMBIGUOUS_OUTCOME
    : RefundAttemptStatus.PROVIDER_PENDING;
  const nextSeq = await getNextEventSequenceTx(tx, attempt.id);
  const eventId = randomUUID();

  await tx.refundProviderAttemptEvent.create({
    data: {
      id: eventId,
      attemptId: attempt.id,
      refundId: attempt.refundId,
      obligationId: attempt.obligationId,
      eventSequence: nextSeq,
      eventType: mapEvidenceEventType(input.evidence.provenance),
      previousAttemptStatus: attempt.status,
      resultingAttemptStatus: nextAttemptStatus,
      provenance: input.evidence.provenance,
      provider: attempt.provider,
      merchantAccountId: attempt.merchantAccountId,
      providerEventId: input.evidence.eventId,
      providerRefundReference: normalizedRef ?? attempt.providerRefundReference,
      httpStatusCode: input.httpStatusCode ?? null,
      evidenceDigest: normalizedDigest,
      sanitizedPayload: sanitizeRefundPayload(input.evidence.rawPayload),
      occurredAt: input.evidence.eventTimestamp,
    },
  });

  await tx.refundProviderAttempt.update({
    where: { id: attempt.id },
    data: {
      status: nextAttemptStatus,
      providerRefundReference: normalizedRef ?? attempt.providerRefundReference,
      providerRespondedAt: attempt.providerRespondedAt ?? now,
      pollLockUntil: null,
      version: { increment: 1 },
    },
  });

  let finalRefundStatus = refundStatus;
  let finalObligationStatus = obligation.status;
  let outboxEventId: string | null = null;

  if (!isQuarantined) {
    if (refundStatus !== RefundStatus.PENDING) {
      const updatedRefund = await tx.refund.update({
        where: { id: attempt.refundId },
        data: {
          status: RefundStatus.PENDING,
          ...(normalizedRef ? { providerReference: normalizedRef } : {}),
        },
      });
      finalRefundStatus = updatedRefund.status;
    }

    if (
      obligation.status !== RefundObligationStatus.PENDING_PROVIDER &&
      obligation.status !== RefundObligationStatus.FULFILLED &&
      obligation.status !== RefundObligationStatus.CANCELLED_VOIDED &&
      obligation.status !== RefundObligationStatus.RECONCILE_REQUIRED
    ) {
      const updatedObl = await tx.refundObligation.update({
        where: { id: obligation.id },
        data: { status: RefundObligationStatus.PENDING_PROVIDER },
      });
      finalObligationStatus = updatedObl.status;
    }

    if (attempt.status !== RefundAttemptStatus.PROVIDER_PENDING) {
      const outbox = await tx.paymentOutbox.create({
        data: {
          aggregateId: attempt.refundId,
          aggregateType: 'Refund',
          eventType: 'REFUND_STATUS_CHANGED',
          payload: {
            logicalEventKey: buildRefundOutboxLogicalKey({
              eventType: 'REFUND_STATUS_CHANGED',
              attemptId: attempt.id,
              eventSequence: nextSeq,
            }),
            sourceEventId: eventId,
            eventSequence: nextSeq,
            attemptId: attempt.id,
            refundId: attempt.refundId,
            obligationId: attempt.obligationId,
            paymentId: attempt.paymentId,
            orderId: payment.orderId,
            status: finalRefundStatus,
            attemptStatus: nextAttemptStatus,
            timestamp: now.toISOString(),
          },
          published: false,
        },
      });
      outboxEventId = outbox.id;
    }
  }

  const receipt = await persistEvidenceReceipt(tx, {
    provider: input.provider,
    merchantAccountId: input.merchantAccountId,
    eventId: input.evidence.eventId,
    providerRefundReference: normalizedRef ?? attempt.providerRefundReference,
    attemptId: attempt.id,
    refundId: attempt.refundId,
    obligationId: attempt.obligationId,
    provenance: input.evidence.provenance,
    disposition: RefundEvidenceDisposition.APPLIED,
    signatureValid: Boolean(input.evidence.signatureValid),
    evidenceDigest: normalizedDigest,
    sourceIp: input.evidence.sourceIp ?? null,
  });

  return {
    applied: true,
    disposition: RefundEvidenceDisposition.APPLIED,
    attemptId: attempt.id,
    refundId: attempt.refundId,
    obligationId: attempt.obligationId,
    resultingAttemptStatus: nextAttemptStatus,
    resultingRefundStatus: finalRefundStatus,
    resultingObligationStatus: finalObligationStatus,
    receiptId: receipt.id,
    attemptEventId: eventId,
    outboxEventId,
    quarantined: isQuarantined,
    message: isQuarantined
      ? 'Pending evidence recorded while attempt remains AMBIGUOUS_OUTCOME'
      : 'Attempt moved to PROVIDER_PENDING',
  };
}

export async function applyTerminalResolutionTx(
  tx: Prisma.TransactionClient,
  input: ProcessRefundEvidenceInput,
  attempt: RefundProviderAttempt,
  obligation: RefundObligation,
  payment: LockedRefundPaymentRow,
  normalizedDigest: string,
  normalizedRef: string | null,
): Promise<ProcessRefundEvidenceResult> {
  const now = new Date();
  const targetAttemptStatus =
    input.outcome === 'COMPLETED' ? RefundAttemptStatus.COMPLETED : RefundAttemptStatus.FAILED;
  const nextSeq = await getNextEventSequenceTx(tx, attempt.id);
  const eventId = randomUUID();

  // Insert attempt event BEFORE updating attempt status so trigger checks
  // (especially AMBIGUOUS_OUTCOME -> COMPLETED|FAILED resolvedByEventId) pass.
  await tx.refundProviderAttemptEvent.create({
    data: {
      id: eventId,
      attemptId: attempt.id,
      refundId: attempt.refundId,
      obligationId: attempt.obligationId,
      eventSequence: nextSeq,
      eventType: mapEvidenceEventType(input.evidence.provenance),
      previousAttemptStatus: attempt.status,
      resultingAttemptStatus: targetAttemptStatus,
      provenance: input.evidence.provenance,
      provider: attempt.provider,
      merchantAccountId: attempt.merchantAccountId,
      providerEventId: input.evidence.eventId,
      providerRefundReference: normalizedRef ?? attempt.providerRefundReference,
      httpStatusCode: input.httpStatusCode ?? null,
      evidenceDigest: normalizedDigest,
      sanitizedPayload: sanitizeRefundPayload(input.evidence.rawPayload),
      occurredAt: input.evidence.eventTimestamp,
    },
  });

  await tx.refundProviderAttempt.update({
    where: { id: attempt.id },
    data: {
      status: targetAttemptStatus,
      providerRefundReference: normalizedRef ?? attempt.providerRefundReference,
      providerRespondedAt: attempt.providerRespondedAt ?? now,
      terminalizedAt: now,
      failureClassification:
        targetAttemptStatus === RefundAttemptStatus.FAILED
          ? RefundAttemptFailureClass.PROVIDER_DEFINITIVE_DECLINE
          : RefundAttemptFailureClass.NONE,
      retryEligible: targetAttemptStatus === RefundAttemptStatus.FAILED,
      resolvedByProvenance: input.evidence.provenance,
      resolvedByEventId: eventId,
      pollLockUntil: null,
      version: { increment: 1 },
    },
  });

  const targetRefundStatus =
    targetAttemptStatus === RefundAttemptStatus.COMPLETED
      ? RefundStatus.COMPLETED
      : RefundStatus.FAILED;

  const updatedRefund = await tx.refund.update({
    where: { id: attempt.refundId },
    data: {
      status: targetRefundStatus,
      ...(normalizedRef ? { providerReference: normalizedRef } : {}),
    },
  });

  let finalObligationStatus = obligation.status;
  if (targetAttemptStatus === RefundAttemptStatus.COMPLETED) {
    const completedSum = await tx.refund.aggregate({
      where: { paymentId: payment.id, status: RefundStatus.COMPLETED },
      _sum: { amount: true },
    });
    const totalRefunded = completedSum._sum.amount ?? new Prisma.Decimal(0);
    if (totalRefunded.gt(payment.amount)) {
      throw new ConflictException(
        `Completed refunds (${totalRefunded.toFixed(2)}) exceed payment amount (${new Prisma.Decimal(payment.amount).toFixed(2)})`,
      );
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: totalRefunded.gte(payment.amount)
          ? PaymentStatus.REFUNDED
          : PaymentStatus.PARTIALLY_REFUNDED,
      },
    });

    const updatedObl = await tx.refundObligation.update({
      where: { id: obligation.id },
      data: {
        status: RefundObligationStatus.FULFILLED,
        fulfilledRefundId: updatedRefund.id,
        fulfilledAttemptId: attempt.id,
      },
    });
    finalObligationStatus = updatedObl.status;
  } else {
    const nonFailedCount = await tx.refundProviderAttempt.count({
      where: {
        obligationId: obligation.id,
        status: { not: RefundAttemptStatus.FAILED },
      },
    });
    if (
      nonFailedCount === 0 &&
      obligation.status !== RefundObligationStatus.FULFILLED &&
      obligation.status !== RefundObligationStatus.CANCELLED_VOIDED
    ) {
      const updatedObl = await tx.refundObligation.update({
        where: { id: obligation.id },
        data: { status: RefundObligationStatus.OPEN },
      });
      finalObligationStatus = updatedObl.status;
    }
  }

  const receipt = await persistEvidenceReceipt(tx, {
    provider: input.provider,
    merchantAccountId: input.merchantAccountId,
    eventId: input.evidence.eventId,
    providerRefundReference: normalizedRef ?? attempt.providerRefundReference,
    attemptId: attempt.id,
    refundId: attempt.refundId,
    obligationId: attempt.obligationId,
    provenance: input.evidence.provenance,
    disposition: RefundEvidenceDisposition.APPLIED,
    signatureValid: Boolean(input.evidence.signatureValid),
    evidenceDigest: normalizedDigest,
    sourceIp: input.evidence.sourceIp ?? null,
  });

  const outbox = await tx.paymentOutbox.create({
    data: {
      aggregateId: updatedRefund.id,
      aggregateType: 'Refund',
      eventType: 'REFUND_STATUS_CHANGED',
      payload: {
        logicalEventKey: buildRefundOutboxLogicalKey({
          eventType: 'REFUND_STATUS_CHANGED',
          attemptId: attempt.id,
          eventSequence: nextSeq,
        }),
        sourceEventId: eventId,
        eventSequence: nextSeq,
        refundId: updatedRefund.id,
        paymentId: payment.id,
        orderId: payment.orderId,
        obligationId: obligation.id,
        attemptId: attempt.id,
        amount: updatedRefund.amount.toString(),
        status: updatedRefund.status,
        attemptStatus: targetAttemptStatus,
        timestamp: now.toISOString(),
      },
      published: false,
    },
  });

  return {
    applied: true,
    disposition: RefundEvidenceDisposition.APPLIED,
    attemptId: attempt.id,
    refundId: updatedRefund.id,
    obligationId: obligation.id,
    resultingAttemptStatus: targetAttemptStatus,
    resultingRefundStatus: updatedRefund.status,
    resultingObligationStatus: finalObligationStatus,
    receiptId: receipt.id,
    attemptEventId: eventId,
    outboxEventId: outbox.id,
    quarantined: false,
    message: `Attempt "${attempt.id}" resolved to ${targetAttemptStatus}`,
  };
}
