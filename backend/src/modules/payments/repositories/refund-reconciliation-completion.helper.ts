import { randomUUID } from 'crypto';

import { ConflictException } from '@nestjs/common';
import {
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  RefundAttemptEventType,
  RefundAttemptFailureClass,
  RefundAttemptStatus,
  RefundEvidenceProvenance,
  RefundExecutionChannel,
  RefundObligation,
  RefundObligationStatus,
  RefundProviderAttempt,
  RefundReconciliationActionType,
  RefundReconciliationApproval,
  RefundStatus,
} from '@prisma/client';

import { getNextEventSequenceTx } from './refund-attempt-quarantine.helper';
import { LockedRefundPaymentRow, sanitizeRefundPayload } from './refund-locks.helper';
import { sha256HexForAttemptDigest } from './refund-reconciliation-binding.helper';

export async function appendManualAttemptAuditEventTx(
  tx: Prisma.TransactionClient,
  params: {
    attemptId: string;
    refundId: string;
    obligationId: string;
    eventSequence: number;
    previousAttemptStatus: RefundAttemptStatus | null;
    resultingAttemptStatus: RefundAttemptStatus;
    provider: PaymentProviderName;
    merchantAccountId: string;
    providerRefundReference?: string | null;
    evidenceDigest: string;
    sanitizedPayload: Record<string, unknown>;
    actorId: string;
    actorRole?: string | null;
    occurredAt: Date;
  },
): Promise<string> {
  const eventId = randomUUID();
  await tx.refundProviderAttemptEvent.create({
    data: {
      id: eventId,
      attemptId: params.attemptId,
      refundId: params.refundId,
      obligationId: params.obligationId,
      eventSequence: params.eventSequence,
      eventType: RefundAttemptEventType.MANUAL_RECONCILIATION_APPLIED,
      previousAttemptStatus: params.previousAttemptStatus,
      resultingAttemptStatus: params.resultingAttemptStatus,
      provenance: RefundEvidenceProvenance.DUAL_CONTROL_ADMIN_RECONCILIATION,
      provider: params.provider,
      merchantAccountId: params.merchantAccountId,
      providerRefundReference: params.providerRefundReference ?? null,
      evidenceDigest: params.evidenceDigest,
      sanitizedPayload: sanitizeRefundPayload(params.sanitizedPayload),
      actorId: params.actorId,
      actorRole: params.actorRole ?? 'ADMINISTRATOR',
      occurredAt: params.occurredAt,
    },
  });
  return eventId;
}

export async function applyVerifiedCompletedTransitionTx(params: {
  tx: Prisma.TransactionClient;
  approval: RefundReconciliationApproval;
  now: Date;
  executedByActorId: string;
  actorRole?: string | null;
  payment: LockedRefundPaymentRow;
  obligation: RefundObligation;
  targetAttempt: RefundProviderAttempt | null;
}): Promise<{
  resultingAttemptEventId: string;
  resultingAttemptStatus: RefundAttemptStatus;
  resultingRefundStatus: RefundStatus;
  resultingObligationStatus: RefundObligationStatus;
  refundId: string;
}> {
  const { tx, approval, now, payment, obligation, targetAttempt } = params;
  const extRef = approval.externalSettlementReference?.trim();
  if (!extRef) {
    throw new ConflictException(
      'VERIFIED_COMPLETED reconciliation requires verified non-empty externalSettlementReference',
    );
  }

  let updatedAttemptId: string;
  let updatedRefundId: string;
  let eventId: string;

  if (
    approval.actionType === RefundReconciliationActionType.RESOLVE_QUARANTINED_COMPLETED &&
    targetAttempt &&
    targetAttempt.status !== RefundAttemptStatus.FAILED &&
    targetAttempt.status !== RefundAttemptStatus.CANCELLED_BEFORE_DISPATCH
  ) {
    const nextSeq = await getNextEventSequenceTx(tx, targetAttempt.id);
    eventId = await appendManualAttemptAuditEventTx(tx, {
      attemptId: targetAttempt.id,
      refundId: targetAttempt.refundId,
      obligationId: obligation.id,
      eventSequence: nextSeq,
      previousAttemptStatus: targetAttempt.status,
      resultingAttemptStatus: RefundAttemptStatus.COMPLETED,
      provider: payment.provider,
      merchantAccountId: payment.merchantAccountId,
      providerRefundReference: extRef,
      evidenceDigest: approval.evidenceDigest,
      sanitizedPayload: { approvalId: approval.id, externalSettlementReference: extRef },
      actorId: params.executedByActorId,
      actorRole: params.actorRole,
      occurredAt: now,
    });
    const updatedAtt = await tx.refundProviderAttempt.update({
      where: { id: targetAttempt.id },
      data: {
        status: RefundAttemptStatus.COMPLETED,
        providerRefundReference: extRef,
        providerRespondedAt: targetAttempt.providerRespondedAt ?? now,
        terminalizedAt: now,
        failureClassification: RefundAttemptFailureClass.NONE,
        retryEligible: false,
        resolvedByProvenance: RefundEvidenceProvenance.DUAL_CONTROL_ADMIN_RECONCILIATION,
        reconciliationApprovalId: approval.id,
        pollLockUntil: null,
        version: { increment: 1 },
      },
    });
    const updatedRef = await tx.refund.update({
      where: { id: targetAttempt.refundId },
      data: { status: RefundStatus.COMPLETED, providerReference: extRef },
    });
    updatedAttemptId = updatedAtt.id;
    updatedRefundId = updatedRef.id;
  } else {
    const latestFailed = await tx.refund.findFirst({
      where: { obligationId: obligation.id, status: RefundStatus.FAILED },
      orderBy: { createdAt: 'desc' },
    });
    const existingNonFailed = await tx.refund.findFirst({
      where: { obligationId: obligation.id, status: { not: RefundStatus.FAILED } },
    });
    const attemptCount = await tx.refundProviderAttempt.count({
      where: { obligationId: obligation.id },
    });
    const refundIdToComplete = existingNonFailed
      ? existingNonFailed.id
      : (
          await tx.refund.create({
            data: {
              id: randomUUID(),
              paymentId: payment.id,
              obligationId: obligation.id,
              supersedesRefundId: latestFailed?.id ?? null,
              idempotencyKey: `${obligation.obligationKey}:manual:${attemptCount + 1}`,
              amount: obligation.authorizedAmount,
              reason: obligation.reason,
              status: RefundStatus.REQUIRED,
            },
          })
        ).id;

    const manualAttemptId = randomUUID();
    const createdAttempt = await tx.refundProviderAttempt.create({
      data: {
        id: manualAttemptId,
        refundId: refundIdToComplete,
        obligationId: obligation.id,
        paymentId: payment.id,
        provider: payment.provider,
        merchantAccountId: payment.merchantAccountId,
        attemptSequence: attemptCount + 1,
        providerIdempotencyKey: `refund:${obligation.id}:manual:${attemptCount + 1}`,
        amount: obligation.authorizedAmount,
        currency: obligation.currency,
        executionChannel: RefundExecutionChannel.MANUAL_PORTAL_SETTLEMENT,
        parentPaymentReference: payment.providerReference,
        providerRefundReference: extRef,
        status: RefundAttemptStatus.COMPLETED,
        failureClassification: RefundAttemptFailureClass.NONE,
        retryEligible: false,
        requestDigest: sha256HexForAttemptDigest(obligation, extRef, manualAttemptId),
        providerRespondedAt: now,
        terminalizedAt: now,
        resolvedByProvenance: RefundEvidenceProvenance.DUAL_CONTROL_ADMIN_RECONCILIATION,
        reconciliationApprovalId: approval.id,
        initiatedByActorId: params.executedByActorId,
        initiatedByRole: params.actorRole ?? 'ADMINISTRATOR',
      },
    });
    eventId = await appendManualAttemptAuditEventTx(tx, {
      attemptId: createdAttempt.id,
      refundId: refundIdToComplete,
      obligationId: obligation.id,
      eventSequence: 1,
      previousAttemptStatus: null,
      resultingAttemptStatus: RefundAttemptStatus.COMPLETED,
      provider: payment.provider,
      merchantAccountId: payment.merchantAccountId,
      providerRefundReference: extRef,
      evidenceDigest: approval.evidenceDigest,
      sanitizedPayload: { approvalId: approval.id, externalSettlementReference: extRef },
      actorId: params.executedByActorId,
      actorRole: params.actorRole,
      occurredAt: now,
    });
    const updatedRef = await tx.refund.update({
      where: { id: refundIdToComplete },
      data: { status: RefundStatus.COMPLETED, providerReference: extRef },
    });
    updatedAttemptId = createdAttempt.id;
    updatedRefundId = updatedRef.id;
  }

  const completedSum = await tx.refund.aggregate({
    where: { paymentId: payment.id, status: RefundStatus.COMPLETED },
    _sum: { amount: true },
  });
  const totalRefunded = completedSum._sum.amount ?? new Prisma.Decimal(0);
  if (totalRefunded.gt(payment.amount)) {
    throw new ConflictException(
      `Total completed refunds (${totalRefunded.toFixed(2)}) exceed payment amount (${new Prisma.Decimal(payment.amount).toFixed(2)})`,
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

  await tx.refundObligation.update({
    where: { id: obligation.id },
    data: {
      status: RefundObligationStatus.FULFILLED,
      fulfilledRefundId: updatedRefundId,
      fulfilledAttemptId: updatedAttemptId,
    },
  });

  return {
    resultingAttemptEventId: eventId,
    resultingAttemptStatus: RefundAttemptStatus.COMPLETED,
    resultingRefundStatus: RefundStatus.COMPLETED,
    resultingObligationStatus: RefundObligationStatus.FULFILLED,
    refundId: updatedRefundId,
  };
}
