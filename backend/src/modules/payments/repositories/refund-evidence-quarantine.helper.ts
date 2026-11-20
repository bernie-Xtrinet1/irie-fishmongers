import { randomUUID } from 'crypto';

import {
  Prisma,
  RefundAttemptEventType,
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
import { persistEvidenceReceipt } from './refund-evidence-validation.helper';
import {
  buildRefundOutboxLogicalKey,
  LockedRefundPaymentRow,
  sanitizeRefundPayload,
} from './refund-locks.helper';

export async function recordConflictAndQuarantineTx(
  tx: Prisma.TransactionClient,
  params: {
    input: ProcessRefundEvidenceInput;
    attempt: RefundProviderAttempt;
    refundStatus: RefundStatus;
    obligation: RefundObligation;
    payment: LockedRefundPaymentRow;
    normalizedDigest: string;
    normalizedRef: string | null;
    reason: string;
    recordExternalEventId: boolean;
  },
): Promise<ProcessRefundEvidenceResult> {
  const { input, attempt, obligation, payment, normalizedDigest, normalizedRef, reason } = params;
  const now = new Date();
  const isTerminal =
    attempt.status === RefundAttemptStatus.COMPLETED ||
    attempt.status === RefundAttemptStatus.FAILED ||
    attempt.status === RefundAttemptStatus.CANCELLED_BEFORE_DISPATCH;

  const receipt = await persistEvidenceReceipt(tx, {
    provider: input.provider,
    merchantAccountId: input.merchantAccountId,
    eventId: input.evidence.eventId,
    providerRefundReference: normalizedRef,
    attemptId: attempt.id,
    refundId: attempt.refundId,
    obligationId: attempt.obligationId,
    provenance: input.evidence.provenance,
    disposition: RefundEvidenceDisposition.CONFLICT_REJECTED,
    signatureValid: Boolean(input.evidence.signatureValid),
    evidenceDigest: normalizedDigest,
    sourceIp: input.evidence.sourceIp ?? null,
    rejectionReason: reason,
  });

  const targetAttemptStatus = isTerminal
    ? attempt.status
    : RefundAttemptStatus.AMBIGUOUS_OUTCOME;

  if (!isTerminal) {
    await tx.refundProviderAttempt.update({
      where: { id: attempt.id },
      data: {
        status: RefundAttemptStatus.AMBIGUOUS_OUTCOME,
        failureClassification: RefundAttemptFailureClass.EVIDENCE_CONTRADICTION,
        retryEligible: false,
        quarantinedAt: attempt.quarantinedAt ?? now,
        pollLockUntil: null,
        version: { increment: 1 },
      },
    });
  }

  const nextSeq = await getNextEventSequenceTx(tx, attempt.id);
  const eventId = randomUUID();
  await tx.refundProviderAttemptEvent.create({
    data: {
      id: eventId,
      attemptId: attempt.id,
      refundId: attempt.refundId,
      obligationId: attempt.obligationId,
      eventSequence: nextSeq,
      eventType: RefundAttemptEventType.CONTRADICTION_QUARANTINED,
      previousAttemptStatus: attempt.status,
      resultingAttemptStatus: targetAttemptStatus,
      provenance: input.evidence.provenance,
      provider: attempt.provider,
      merchantAccountId: attempt.merchantAccountId,
      providerEventId: params.recordExternalEventId ? input.evidence.eventId : null,
      providerRefundReference: normalizedRef,
      httpStatusCode: input.httpStatusCode ?? null,
      evidenceDigest: normalizedDigest,
      sanitizedPayload: sanitizeRefundPayload({
        conflictReason: reason,
        externalEventId: input.evidence.eventId,
        outcome: input.outcome,
        rawPayload: input.evidence.rawPayload,
      }),
      occurredAt: input.evidence.eventTimestamp,
    },
  });

  let finalRefundStatus = params.refundStatus;
  if (
    params.refundStatus !== RefundStatus.COMPLETED &&
    params.refundStatus !== RefundStatus.FAILED &&
    params.refundStatus !== RefundStatus.RECONCILE_REQUIRED
  ) {
    await tx.refund.update({
      where: { id: attempt.refundId },
      data: { status: RefundStatus.RECONCILE_REQUIRED },
    });
    finalRefundStatus = RefundStatus.RECONCILE_REQUIRED;
  }

  let finalObligationStatus = obligation.status;
  if (
    obligation.status !== RefundObligationStatus.FULFILLED &&
    obligation.status !== RefundObligationStatus.CANCELLED_VOIDED &&
    obligation.status !== RefundObligationStatus.RECONCILE_REQUIRED
  ) {
    await tx.refundObligation.update({
      where: { id: obligation.id },
      data: { status: RefundObligationStatus.RECONCILE_REQUIRED },
    });
    finalObligationStatus = RefundObligationStatus.RECONCILE_REQUIRED;
  }

  const outbox = await tx.paymentOutbox.create({
    data: {
      aggregateId: attempt.refundId,
      aggregateType: 'Refund',
      eventType: 'REFUND_CONTRADICTION_QUARANTINED',
      payload: {
        logicalEventKey: buildRefundOutboxLogicalKey({
          eventType: 'REFUND_CONTRADICTION_QUARANTINED',
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
        attemptStatus: targetAttemptStatus,
        refundStatus: finalRefundStatus,
        obligationStatus: finalObligationStatus,
        externalEventId: input.evidence.eventId,
        reason,
        timestamp: now.toISOString(),
      },
      published: false,
    },
  });

  return {
    applied: false,
    disposition: RefundEvidenceDisposition.CONFLICT_REJECTED,
    attemptId: attempt.id,
    refundId: attempt.refundId,
    obligationId: attempt.obligationId,
    resultingAttemptStatus: targetAttemptStatus,
    resultingRefundStatus: finalRefundStatus,
    resultingObligationStatus: finalObligationStatus,
    receiptId: receipt.id,
    attemptEventId: eventId,
    outboxEventId: outbox.id,
    quarantined: true,
    message: reason,
  };
}
