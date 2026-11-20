import {
  PaymentProviderName,
  RefundAttemptStatus,
  RefundObligationStatus,
  RefundReconciliationActionType,
  RefundReconciliationApproval,
  RefundReconciliationApprovalEvent,
  RefundReconciliationApprovalStatus,
  RefundReconciliationOutcome,
  RefundStatus,
} from '@prisma/client';

export const REFUND_RECONCILIATION_API_POLICY = 'REFUND_RECONCILIATION_API_POLICY';

export interface RefundReconciliationEndpointPolicy {
  enabled: boolean;
}

export interface DualControlReconciliationRequestInput {
  obligationId: string;
  attemptId?: string | null;
  requestedOutcome: RefundReconciliationOutcome;
  evidenceType: string;
  externalSettlementReference?: string | null;
  evidenceReceiptIds?: string[];
  rawEvidence?: unknown;
  evidenceDigest?: string | null;
  rationale: string;
  ttlMs?: number;
  requestedByActorId: string;
  actorRole?: string | null;
}

export interface DualControlApproveInput {
  approvalId: string;
  approvedByActorId: string;
  actorRole?: string | null;
  expectedAuthorizationRevision?: number;
  expectedEvidenceDigest?: string | null;
  expiresAt?: Date;
}

export interface DualControlRejectInput {
  approvalId: string;
  rejectedByActorId: string;
  actorRole?: string | null;
  rejectionReason: string;
}

export interface DualControlRevokeInput {
  approvalId: string;
  revokedByActorId: string;
  actorRole?: string | null;
  revocationReason: string;
}

export interface DualControlExecuteInput {
  approvalId: string;
  executedByActorId: string;
  actorRole?: string | null;
  expectedAuthorizationRevision?: number;
  expectedEvidenceDigest?: string | null;
}

export interface DualControlApprovalEventView {
  id: string;
  eventSequence: number;
  eventType: string;
  previousStatus: RefundReconciliationApprovalStatus | null;
  resultingStatus: RefundReconciliationApprovalStatus;
  authorizationRevision: number;
  actorId: string;
  actorRole: string | null;
  evidenceDigest: string;
  occurredAt: Date;
}

export interface DualControlApprovalView {
  id: string;
  obligationId: string;
  refundId: string | null;
  attemptId: string | null;
  paymentId: string | null;
  provider: PaymentProviderName | null;
  merchantAccountId: string | null;
  amount: string | null;
  currency: string | null;
  actionType: RefundReconciliationActionType;
  requestedOutcome: RefundReconciliationOutcome | null;
  evidenceType: string;
  externalSettlementReference: string | null;
  evidenceDigest: string;
  evidenceReceiptIds: string[];
  requestDigest: string | null;
  approvalDigest: string | null;
  rationale: string;
  authorizationRevision: number;
  requestedByActorId: string;
  requestedAt: Date;
  approvedByActorId: string | null;
  approvedAt: Date | null;
  expiresAt: Date | null;
  rejectedByActorId: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  revokedByActorId: string | null;
  revokedAt: Date | null;
  revocationReason: string | null;
  executedByActorId: string | null;
  executingAt: Date | null;
  appliedAt: Date | null;
  quarantinedAt: Date | null;
  quarantineReason: string | null;
  resultingAttemptEventId: string | null;
  resultingOutboxId: string | null;
  resultingAttemptStatus: RefundAttemptStatus | null;
  resultingRefundStatus: RefundStatus | null;
  resultingObligationStatus: RefundObligationStatus | null;
  status: RefundReconciliationApprovalStatus;
  events: DualControlApprovalEventView[];
}

export interface DualControlExecutionResult {
  applied: boolean;
  quarantined: boolean;
  expired: boolean;
  approval: DualControlApprovalView;
  obligationStatus: RefundObligationStatus;
  refundStatus: RefundStatus | null;
  attemptStatus: RefundAttemptStatus | null;
  attemptEventId: string | null;
  outboxEventId: string | null;
  message: string;
}

export function mapApprovalToView(
  approval: RefundReconciliationApproval & { events?: RefundReconciliationApprovalEvent[] },
): DualControlApprovalView {
  const receiptIds = Array.isArray(approval.evidenceReceiptIds)
    ? approval.evidenceReceiptIds.filter((v): v is string => typeof v === 'string')
    : [];

  return {
    id: approval.id,
    obligationId: approval.obligationId,
    refundId: approval.refundId,
    attemptId: approval.attemptId,
    paymentId: approval.paymentId,
    provider: approval.provider,
    merchantAccountId: approval.merchantAccountId,
    amount: approval.amount ? approval.amount.toString() : null,
    currency: approval.currency,
    actionType: approval.actionType,
    requestedOutcome: approval.requestedOutcome,
    evidenceType: approval.evidenceType,
    externalSettlementReference: approval.externalSettlementReference,
    evidenceDigest: approval.evidenceDigest,
    evidenceReceiptIds: receiptIds,
    requestDigest: approval.requestDigest,
    approvalDigest: approval.approvalDigest,
    rationale: approval.rationale,
    authorizationRevision: approval.authorizationRevision,
    requestedByActorId: approval.requestedByActorId,
    requestedAt: approval.requestedAt,
    approvedByActorId: approval.approvedByActorId,
    approvedAt: approval.approvedAt,
    expiresAt: approval.expiresAt,
    rejectedByActorId: approval.rejectedByActorId,
    rejectedAt: approval.rejectedAt,
    rejectionReason: approval.rejectionReason,
    revokedByActorId: approval.revokedByActorId,
    revokedAt: approval.revokedAt,
    revocationReason: approval.revocationReason,
    executedByActorId: approval.executedByActorId,
    executingAt: approval.executingAt,
    appliedAt: approval.appliedAt,
    quarantinedAt: approval.quarantinedAt,
    quarantineReason: approval.quarantineReason,
    resultingAttemptEventId: approval.resultingAttemptEventId,
    resultingOutboxId: approval.resultingOutboxId,
    resultingAttemptStatus: approval.resultingAttemptStatus,
    resultingRefundStatus: approval.resultingRefundStatus,
    resultingObligationStatus: approval.resultingObligationStatus,
    status: approval.status,
    events: (approval.events ?? []).map((evt) => ({
      id: evt.id,
      eventSequence: evt.eventSequence,
      eventType: evt.eventType,
      previousStatus: evt.previousStatus,
      resultingStatus: evt.resultingStatus,
      authorizationRevision: evt.authorizationRevision,
      actorId: evt.actorId,
      actorRole: evt.actorRole,
      evidenceDigest: evt.evidenceDigest,
      occurredAt: evt.occurredAt,
    })),
  };
}
