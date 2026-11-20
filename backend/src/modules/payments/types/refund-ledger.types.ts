import {
  PaymentProviderName,
  Prisma,
  Refund,
  RefundAttemptFailureClass,
  RefundExecutionChannel,
  RefundObligation,
  RefundObligationType,
  RefundProviderAttempt,
  RefundProviderAttemptEvent,
  RefundReconciliationActionType,
  RefundReconciliationApproval,
} from '@prisma/client';

export interface RefundDispatchActor {
  actorId?: string | null;
  actorRole?: string | null;
}

export interface PrepareRefundAttemptInput {
  paymentId: string;
  amount: number | Prisma.Decimal | string;
  reason: string;
  idempotencyKey?: string | null;
  orderId?: string | null;
  obligationId?: string | null;
  obligationType?: RefundObligationType;
  vendorOrderId?: string | null;
  executionChannel?: RefundExecutionChannel;
  allowReplacementRetry?: boolean;
  leaseDurationMs?: number;
  actor?: RefundDispatchActor;
}

export interface PrepareRefundAttemptResult {
  action: 'DISPATCH' | 'RETURN_EXISTING' | 'EXCEEDS_BALANCE' | 'TERMINAL_FAILED';
  obligation?: RefundObligation;
  refund?: Refund;
  attempt?: RefundProviderAttempt;
  parentPaymentReference?: string | null;
  provider?: PaymentProviderName;
  merchantAccountId?: string;
  remainingBalance: Prisma.Decimal;
  errorReason?: string;
}

export interface RecordPreSendAbortInput {
  attemptId: string;
  paymentId: string;
  failureClass: RefundAttemptFailureClass;
  errorReason: string;
  httpStatusCode?: number | null;
  rawErrorPayload?: unknown;
  actor?: RefundDispatchActor;
}

export interface RecordAttemptOutcomeInput {
  attemptId: string;
  paymentId: string;
  providerOutcome: 'COMPLETED' | 'PENDING' | 'FAILED';
  providerRefundReference?: string | null;
  expectedAmount: number | Prisma.Decimal | string;
  failureClass?: RefundAttemptFailureClass;
  retryEligible?: boolean;
  httpStatusCode?: number | null;
  rawResponsePayload?: unknown;
  actor?: RefundDispatchActor;
}

export interface QuarantineAttemptInput {
  attemptId: string;
  paymentId: string;
  failureClass: RefundAttemptFailureClass;
  errorMessage: string;
  httpStatusCode?: number | null;
  rawPayload?: unknown;
  actor?: RefundDispatchActor;
}

export interface RefundAttemptOutcomeResult {
  obligation: RefundObligation;
  refund: Refund;
  attempt: RefundProviderAttempt;
  outboxEventId?: string;
}

export interface RefundAttemptInspectionRecord {
  obligation: RefundObligation;
  refunds: Refund[];
  attempts: Array<RefundProviderAttempt & { events: RefundProviderAttemptEvent[] }>;
}

export interface RequestReconciliationApprovalInput {
  obligationId: string;
  refundId?: string | null;
  attemptId?: string | null;
  actionType: RefundReconciliationActionType;
  evidenceType: string;
  externalSettlementReference?: string | null;
  rawEvidence: unknown;
  rationale: string;
  requestedByActorId: string;
}

export interface ApproveReconciliationInput {
  approvalId: string;
  approvedByActorId: string;
}

export interface VoidObligationWithApprovalInput {
  obligationId: string;
  approvalId: string;
  actor?: RefundDispatchActor;
}

export interface ReconciliationApprovalResult {
  approval: RefundReconciliationApproval;
  obligation?: RefundObligation;
}
