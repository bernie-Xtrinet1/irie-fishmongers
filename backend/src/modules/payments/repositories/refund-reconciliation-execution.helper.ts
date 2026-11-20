import { ConflictException } from '@nestjs/common';
import {
  Prisma,
  RefundAttemptFailureClass,
  RefundAttemptStatus,
  RefundEvidenceProvenance,
  RefundObligation,
  RefundObligationStatus,
  RefundProviderAttempt,
  RefundReconciliationActionType,
  RefundReconciliationApproval,
  RefundReconciliationApprovalEventType,
  RefundReconciliationApprovalStatus,
  RefundStatus,
} from '@prisma/client';

import {
  DualControlApprovalView,
  DualControlExecutionResult,
  mapApprovalToView,
} from '../types/refund-dual-control.types';
import { getNextEventSequenceTx } from './refund-attempt-quarantine.helper';
import { buildRefundOutboxLogicalKey, LockedRefundPaymentRow } from './refund-locks.helper';
import { appendApprovalLifecycleEventTx } from './refund-reconciliation-binding.helper';
import {
  appendManualAttemptAuditEventTx,
  applyVerifiedCompletedTransitionTx,
} from './refund-reconciliation-completion.helper';

export async function finalizeTerminalApprovalOutcomeTx(
  tx: Prisma.TransactionClient,
  params: {
    approval: RefundReconciliationApproval;
    targetStatus: 'QUARANTINED' | 'EXPIRED';
    actorId: string;
    actorRole?: string | null;
    now: Date;
    reason: string;
    payment: LockedRefundPaymentRow;
    obligation: RefundObligation;
    currentRefundStatus: RefundStatus | null;
    currentAttemptStatus: RefundAttemptStatus | null;
  },
): Promise<DualControlExecutionResult> {
  const { approval, targetStatus, now, reason, payment, obligation } = params;
  const nextRev = approval.authorizationRevision + 1;
  const isQuarantine = targetStatus === 'QUARANTINED';

  const updated = await tx.refundReconciliationApproval.update({
    where: { id: approval.id },
    data: {
      status: isQuarantine
        ? RefundReconciliationApprovalStatus.QUARANTINED
        : RefundReconciliationApprovalStatus.EXPIRED,
      authorizationRevision: nextRev,
      ...(isQuarantine ? { quarantinedAt: now, quarantineReason: reason } : {}),
    },
  });

  await appendApprovalLifecycleEventTx(tx, {
    approvalId: approval.id,
    obligationId: obligation.id,
    eventType: isQuarantine
      ? RefundReconciliationApprovalEventType.QUARANTINED
      : RefundReconciliationApprovalEventType.EXPIRED,
    previousStatus: approval.status,
    resultingStatus: updated.status,
    authorizationRevision: nextRev,
    actorId: params.actorId,
    actorRole: params.actorRole,
    evidenceDigest: approval.evidenceDigest,
    sanitizedPayload: isQuarantine
      ? { reason }
      : { expiresAt: approval.expiresAt?.toISOString() ?? null },
    occurredAt: now,
  });

  let outboxEventId: string | null = null;
  if (isQuarantine) {
    const outbox = await tx.paymentOutbox.create({
      data: {
        aggregateId: obligation.id,
        aggregateType: 'RefundObligation',
        eventType: 'REFUND_RECONCILIATION_APPROVAL_QUARANTINED',
        payload: {
          logicalEventKey: buildRefundOutboxLogicalKey({
            eventType: 'REFUND_RECONCILIATION_APPROVAL_QUARANTINED',
            obligationId: obligation.id,
            approvalId: approval.id,
          }),
          approvalId: approval.id,
          obligationId: obligation.id,
          paymentId: payment.id,
          reason,
          timestamp: now.toISOString(),
        },
        published: false,
      },
    });
    outboxEventId = outbox.id;
  }

  const events = await tx.refundReconciliationApprovalEvent.findMany({
    where: { approvalId: approval.id },
    orderBy: { eventSequence: 'asc' },
  });

  return {
    applied: false,
    quarantined: isQuarantine,
    expired: !isQuarantine,
    approval: mapApprovalToView({ ...updated, events }),
    obligationStatus: obligation.status,
    refundStatus: params.currentRefundStatus,
    attemptStatus: params.currentAttemptStatus,
    attemptEventId: null,
    outboxEventId,
    message: reason,
  };
}

export async function executeApprovedTransitionTx(params: {
  tx: Prisma.TransactionClient;
  approval: RefundReconciliationApproval;
  claimedRevision: number;
  now: Date;
  executedByActorId: string;
  actorRole?: string | null;
  payment: LockedRefundPaymentRow;
  obligation: RefundObligation;
  targetAttempt: RefundProviderAttempt | null;
  targetRefundStatus: RefundStatus | null;
}): Promise<DualControlExecutionResult> {
  const { tx, approval, claimedRevision, now, payment, obligation, targetAttempt } = params;

  let resultingAttemptEventId: string | null = null;
  let resultingAttemptStatus: RefundAttemptStatus | null = targetAttempt?.status ?? null;
  let resultingRefundStatus: RefundStatus | null = params.targetRefundStatus;
  let resultingObligationStatus: RefundObligationStatus = obligation.status;
  let outboxEventType = 'REFUND_STATUS_CHANGED';
  let aggregateType = 'Refund';
  let aggregateId = approval.refundId ?? obligation.id;

  if (approval.actionType === RefundReconciliationActionType.VOID_OBLIGATION) {
    const activeAttempts = await tx.refundProviderAttempt.count({
      where: {
        obligationId: obligation.id,
        status: {
          in: [
            RefundAttemptStatus.PREPARED,
            RefundAttemptStatus.DISPATCHING,
            RefundAttemptStatus.PROVIDER_PENDING,
            RefundAttemptStatus.AMBIGUOUS_OUTCOME,
            RefundAttemptStatus.COMPLETED,
          ],
        },
      },
    });
    if (activeAttempts > 0) {
      throw new ConflictException(
        `Cannot void obligation "${obligation.id}" while unresolved or completed attempts exist`,
      );
    }
    const activeAllocCount = await tx.refundVendorOrderAllocation.count({
      where: { refund: { obligationId: obligation.id, status: { not: RefundStatus.FAILED } } },
    });
    if (activeAllocCount > 0) {
      throw new ConflictException(
        `Cannot void obligation "${obligation.id}" while active non-failed allocations exist`,
      );
    }
    const updatedObl = await tx.refundObligation.update({
      where: { id: obligation.id },
      data: { status: RefundObligationStatus.CANCELLED_VOIDED, voidApprovalId: approval.id },
    });
    resultingObligationStatus = updatedObl.status;
    outboxEventType = 'REFUND_OBLIGATION_VOIDED';
    aggregateType = 'RefundObligation';
    aggregateId = obligation.id;
  } else if (approval.actionType === RefundReconciliationActionType.CONTINUE_QUARANTINE) {
    if (targetAttempt) {
      const nextSeq = await getNextEventSequenceTx(tx, targetAttempt.id);
      resultingAttemptEventId = await appendManualAttemptAuditEventTx(tx, {
        attemptId: targetAttempt.id,
        refundId: targetAttempt.refundId,
        obligationId: obligation.id,
        eventSequence: nextSeq,
        previousAttemptStatus: targetAttempt.status,
        resultingAttemptStatus: targetAttempt.status,
        provider: payment.provider,
        merchantAccountId: payment.merchantAccountId,
        evidenceDigest: approval.evidenceDigest,
        sanitizedPayload: {
          approvalId: approval.id,
          action: 'CONTINUE_QUARANTINE',
          rationale: approval.rationale,
        },
        actorId: params.executedByActorId,
        actorRole: params.actorRole,
        occurredAt: now,
      });
    }
    if (obligation.status !== RefundObligationStatus.RECONCILE_REQUIRED) {
      const updatedObl = await tx.refundObligation.update({
        where: { id: obligation.id },
        data: { status: RefundObligationStatus.RECONCILE_REQUIRED },
      });
      resultingObligationStatus = updatedObl.status;
    }
    outboxEventType = 'REFUND_RECONCILIATION_QUARANTINE_CONTINUED';
    aggregateType = 'RefundObligation';
    aggregateId = obligation.id;
  } else if (
    approval.actionType ===
    RefundReconciliationActionType.RESOLVE_QUARANTINED_DEFINITIVE_FAIL_NO_REMITTANCE
  ) {
    if (
      targetAttempt &&
      targetAttempt.status !== RefundAttemptStatus.FAILED &&
      targetAttempt.status !== RefundAttemptStatus.CANCELLED_BEFORE_DISPATCH
    ) {
      const nextSeq = await getNextEventSequenceTx(tx, targetAttempt.id);
      resultingAttemptEventId = await appendManualAttemptAuditEventTx(tx, {
        attemptId: targetAttempt.id,
        refundId: targetAttempt.refundId,
        obligationId: obligation.id,
        eventSequence: nextSeq,
        previousAttemptStatus: targetAttempt.status,
        resultingAttemptStatus: RefundAttemptStatus.FAILED,
        provider: payment.provider,
        merchantAccountId: payment.merchantAccountId,
        evidenceDigest: approval.evidenceDigest,
        sanitizedPayload: { approvalId: approval.id, rationale: approval.rationale },
        actorId: params.executedByActorId,
        actorRole: params.actorRole,
        occurredAt: now,
      });
      const updatedAtt = await tx.refundProviderAttempt.update({
        where: { id: targetAttempt.id },
        data: {
          status: RefundAttemptStatus.FAILED,
          terminalizedAt: now,
          failureClassification: RefundAttemptFailureClass.PROVIDER_DEFINITIVE_DECLINE,
          retryEligible: true,
          resolvedByProvenance: RefundEvidenceProvenance.DUAL_CONTROL_ADMIN_RECONCILIATION,
          reconciliationApprovalId: approval.id,
          pollLockUntil: null,
          version: { increment: 1 },
        },
      });
      const updatedRef = await tx.refund.update({
        where: { id: targetAttempt.refundId },
        data: { status: RefundStatus.FAILED },
      });
      resultingAttemptStatus = updatedAtt.status;
      resultingRefundStatus = updatedRef.status;
    } else if (targetAttempt) {
      const nextSeq = await getNextEventSequenceTx(tx, targetAttempt.id);
      resultingAttemptEventId = await appendManualAttemptAuditEventTx(tx, {
        attemptId: targetAttempt.id,
        refundId: targetAttempt.refundId,
        obligationId: obligation.id,
        eventSequence: nextSeq,
        previousAttemptStatus: targetAttempt.status,
        resultingAttemptStatus: targetAttempt.status,
        provider: payment.provider,
        merchantAccountId: payment.merchantAccountId,
        evidenceDigest: approval.evidenceDigest,
        sanitizedPayload: {
          approvalId: approval.id,
          action: 'VERIFIED_FAILED_NO_REMITTANCE',
        },
        actorId: params.executedByActorId,
        actorRole: params.actorRole,
        occurredAt: now,
      });
    }
    const updatedObl = await tx.refundObligation.update({
      where: { id: obligation.id },
      data: { status: RefundObligationStatus.OPEN },
    });
    resultingObligationStatus = updatedObl.status;
    aggregateType = 'RefundObligation';
    aggregateId = obligation.id;
  } else {
    const completed = await applyVerifiedCompletedTransitionTx({
      tx,
      approval,
      now,
      executedByActorId: params.executedByActorId,
      actorRole: params.actorRole,
      payment,
      obligation,
      targetAttempt,
    });
    resultingAttemptEventId = completed.resultingAttemptEventId;
    resultingAttemptStatus = completed.resultingAttemptStatus;
    resultingRefundStatus = completed.resultingRefundStatus;
    resultingObligationStatus = completed.resultingObligationStatus;
    aggregateId = completed.refundId;
  }

  const outbox = await tx.paymentOutbox.create({
    data: {
      aggregateId,
      aggregateType,
      eventType: outboxEventType,
      payload: {
        logicalEventKey: buildRefundOutboxLogicalKey({
          eventType: outboxEventType,
          obligationId: obligation.id,
          approvalId: approval.id,
        }),
        approvalId: approval.id,
        obligationId: obligation.id,
        paymentId: payment.id,
        refundId: aggregateType === 'Refund' ? aggregateId : approval.refundId,
        obligationStatus: resultingObligationStatus,
        refundStatus: resultingRefundStatus,
        attemptStatus: resultingAttemptStatus,
        actorId: params.executedByActorId,
        timestamp: now.toISOString(),
      },
      published: false,
    },
  });

  const finalRev = claimedRevision + 1;
  const appliedApproval = await tx.refundReconciliationApproval.update({
    where: { id: approval.id },
    data: {
      status: RefundReconciliationApprovalStatus.APPLIED,
      appliedAt: now,
      authorizationRevision: finalRev,
      resultingAttemptEventId,
      resultingOutboxId: outbox.id,
      resultingAttemptStatus,
      resultingRefundStatus,
      resultingObligationStatus,
    },
  });

  await appendApprovalLifecycleEventTx(tx, {
    approvalId: approval.id,
    obligationId: obligation.id,
    eventType: RefundReconciliationApprovalEventType.APPLIED,
    previousStatus: RefundReconciliationApprovalStatus.EXECUTING,
    resultingStatus: RefundReconciliationApprovalStatus.APPLIED,
    authorizationRevision: finalRev,
    actorId: params.executedByActorId,
    actorRole: params.actorRole,
    evidenceDigest: approval.evidenceDigest,
    sanitizedPayload: {
      outboxId: outbox.id,
      resultingObligationStatus,
      resultingRefundStatus,
      resultingAttemptStatus,
    },
    occurredAt: now,
  });

  const events = await tx.refundReconciliationApprovalEvent.findMany({
    where: { approvalId: approval.id },
    orderBy: { eventSequence: 'asc' },
  });

  const view: DualControlApprovalView = mapApprovalToView({ ...appliedApproval, events });
  return {
    applied: true,
    quarantined: false,
    expired: false,
    approval: view,
    obligationStatus: resultingObligationStatus,
    refundStatus: resultingRefundStatus,
    attemptStatus: resultingAttemptStatus,
    attemptEventId: resultingAttemptEventId,
    outboxEventId: outbox.id,
    message: `Dual-control reconciliation ${approval.actionType} applied`,
  };
}
