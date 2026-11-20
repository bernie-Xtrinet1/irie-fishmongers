import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PaymentProviderName,
  RefundAttemptStatus,
  RefundObligationStatus,
  RefundReconciliationActionType,
  RefundReconciliationApprovalStatus,
  RefundReconciliationOutcome,
  RefundStatus,
} from '@prisma/client';

import {
  DualControlApprovalEventView,
  DualControlApprovalView,
  DualControlExecutionResult,
} from '../types/refund-dual-control.types';

export class RefundApprovalEventEntity {
  @ApiProperty() id!: string;
  @ApiProperty() eventSequence!: number;
  @ApiProperty() eventType!: string;
  @ApiPropertyOptional({ enum: RefundReconciliationApprovalStatus, nullable: true })
  previousStatus!: RefundReconciliationApprovalStatus | null;
  @ApiProperty({ enum: RefundReconciliationApprovalStatus })
  resultingStatus!: RefundReconciliationApprovalStatus;
  @ApiProperty() authorizationRevision!: number;
  @ApiProperty() actorId!: string;
  @ApiPropertyOptional({ nullable: true }) actorRole!: string | null;
  @ApiProperty() evidenceDigest!: string;
  @ApiProperty() occurredAt!: Date;
}

export class RefundApprovalResponseEntity {
  @ApiProperty() id!: string;
  @ApiProperty() obligationId!: string;
  @ApiPropertyOptional({ nullable: true }) refundId!: string | null;
  @ApiPropertyOptional({ nullable: true }) attemptId!: string | null;
  @ApiPropertyOptional({ nullable: true }) paymentId!: string | null;
  @ApiPropertyOptional({ enum: PaymentProviderName, nullable: true })
  provider!: PaymentProviderName | null;
  @ApiPropertyOptional({ nullable: true }) merchantAccountId!: string | null;
  @ApiPropertyOptional({ nullable: true }) amount!: string | null;
  @ApiPropertyOptional({ nullable: true }) currency!: string | null;
  @ApiProperty({ enum: RefundReconciliationActionType })
  actionType!: RefundReconciliationActionType;
  @ApiPropertyOptional({ enum: RefundReconciliationOutcome, nullable: true })
  requestedOutcome!: RefundReconciliationOutcome | null;
  @ApiProperty() evidenceType!: string;
  @ApiPropertyOptional({ nullable: true }) externalSettlementReference!: string | null;
  @ApiProperty() evidenceDigest!: string;
  @ApiProperty({ type: [String] }) evidenceReceiptIds!: string[];
  @ApiPropertyOptional({ nullable: true }) requestDigest!: string | null;
  @ApiPropertyOptional({ nullable: true }) approvalDigest!: string | null;
  @ApiProperty() rationale!: string;
  @ApiProperty() authorizationRevision!: number;
  @ApiProperty() requestedByActorId!: string;
  @ApiProperty() requestedAt!: Date;
  @ApiPropertyOptional({ nullable: true }) approvedByActorId!: string | null;
  @ApiPropertyOptional({ nullable: true }) approvedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) expiresAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) rejectedByActorId!: string | null;
  @ApiPropertyOptional({ nullable: true }) rejectedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) rejectionReason!: string | null;
  @ApiPropertyOptional({ nullable: true }) revokedByActorId!: string | null;
  @ApiPropertyOptional({ nullable: true }) revokedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) revocationReason!: string | null;
  @ApiPropertyOptional({ nullable: true }) executedByActorId!: string | null;
  @ApiPropertyOptional({ nullable: true }) executingAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) appliedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) quarantinedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) quarantineReason!: string | null;
  @ApiPropertyOptional({ nullable: true }) resultingAttemptEventId!: string | null;
  @ApiPropertyOptional({ nullable: true }) resultingOutboxId!: string | null;
  @ApiPropertyOptional({ enum: RefundAttemptStatus, nullable: true })
  resultingAttemptStatus!: RefundAttemptStatus | null;
  @ApiPropertyOptional({ enum: RefundStatus, nullable: true })
  resultingRefundStatus!: RefundStatus | null;
  @ApiPropertyOptional({ enum: RefundObligationStatus, nullable: true })
  resultingObligationStatus!: RefundObligationStatus | null;
  @ApiProperty({ enum: RefundReconciliationApprovalStatus })
  status!: RefundReconciliationApprovalStatus;
  @ApiProperty({ type: [RefundApprovalEventEntity] })
  events!: RefundApprovalEventEntity[];
}

export class RefundReconciliationExecutionResponseEntity {
  @ApiProperty() applied!: boolean;
  @ApiProperty() quarantined!: boolean;
  @ApiProperty() expired!: boolean;
  @ApiProperty({ type: RefundApprovalResponseEntity })
  approval!: RefundApprovalResponseEntity;
  @ApiProperty({ enum: RefundObligationStatus })
  obligationStatus!: RefundObligationStatus;
  @ApiPropertyOptional({ enum: RefundStatus, nullable: true })
  refundStatus!: RefundStatus | null;
  @ApiPropertyOptional({ enum: RefundAttemptStatus, nullable: true })
  attemptStatus!: RefundAttemptStatus | null;
  @ApiPropertyOptional({ nullable: true }) attemptEventId!: string | null;
  @ApiPropertyOptional({ nullable: true }) outboxEventId!: string | null;
  @ApiProperty() message!: string;
}

export class RefundObligationInspectionResponseEntity {
  @ApiProperty() id!: string;
  @ApiProperty() paymentId!: string;
  @ApiProperty() orderId!: string;
  @ApiPropertyOptional({ nullable: true }) vendorOrderId!: string | null;
  @ApiProperty() obligationKey!: string;
  @ApiProperty() obligationType!: string;
  @ApiProperty() authorizedAmount!: string;
  @ApiProperty() currency!: string;
  @ApiPropertyOptional({ nullable: true }) reason!: string | null;
  @ApiProperty({ enum: RefundObligationStatus }) status!: RefundObligationStatus;
  @ApiProperty({ type: 'array' }) refunds!: unknown[];
  @ApiProperty({ type: 'array' }) attempts!: unknown[];
  @ApiProperty({ type: 'array' }) evidenceReceipts!: unknown[];
  @ApiProperty({ type: [RefundApprovalResponseEntity] })
  reconciliationApprovals!: RefundApprovalResponseEntity[];
}

function toEventEntity(evt: DualControlApprovalEventView): RefundApprovalEventEntity {
  return {
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
  };
}

export function toApprovalResponseEntity(
  view: DualControlApprovalView,
): RefundApprovalResponseEntity {
  return {
    id: view.id,
    obligationId: view.obligationId,
    refundId: view.refundId,
    attemptId: view.attemptId,
    paymentId: view.paymentId,
    provider: view.provider,
    merchantAccountId: view.merchantAccountId,
    amount: view.amount,
    currency: view.currency,
    actionType: view.actionType,
    requestedOutcome: view.requestedOutcome,
    evidenceType: view.evidenceType,
    externalSettlementReference: view.externalSettlementReference,
    evidenceDigest: view.evidenceDigest,
    evidenceReceiptIds: [...view.evidenceReceiptIds],
    requestDigest: view.requestDigest,
    approvalDigest: view.approvalDigest,
    rationale: view.rationale,
    authorizationRevision: view.authorizationRevision,
    requestedByActorId: view.requestedByActorId,
    requestedAt: view.requestedAt,
    approvedByActorId: view.approvedByActorId,
    approvedAt: view.approvedAt,
    expiresAt: view.expiresAt,
    rejectedByActorId: view.rejectedByActorId,
    rejectedAt: view.rejectedAt,
    rejectionReason: view.rejectionReason,
    revokedByActorId: view.revokedByActorId,
    revokedAt: view.revokedAt,
    revocationReason: view.revocationReason,
    executedByActorId: view.executedByActorId,
    executingAt: view.executingAt,
    appliedAt: view.appliedAt,
    quarantinedAt: view.quarantinedAt,
    quarantineReason: view.quarantineReason,
    resultingAttemptEventId: view.resultingAttemptEventId,
    resultingOutboxId: view.resultingOutboxId,
    resultingAttemptStatus: view.resultingAttemptStatus,
    resultingRefundStatus: view.resultingRefundStatus,
    resultingObligationStatus: view.resultingObligationStatus,
    status: view.status,
    events: view.events.map(toEventEntity),
  };
}

export function toExecutionResponseEntity(
  result: DualControlExecutionResult,
): RefundReconciliationExecutionResponseEntity {
  return {
    applied: result.applied,
    quarantined: result.quarantined,
    expired: result.expired,
    approval: toApprovalResponseEntity(result.approval),
    obligationStatus: result.obligationStatus,
    refundStatus: result.refundStatus,
    attemptStatus: result.attemptStatus,
    attemptEventId: result.attemptEventId,
    outboxEventId: result.outboxEventId,
    message: result.message,
  };
}
