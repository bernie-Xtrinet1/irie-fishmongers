import {
  PaymentProviderName,
  Prisma,
  RefundAttemptStatus,
  RefundEvidenceDisposition,
  RefundEvidenceProvenance,
  RefundObligationStatus,
  RefundStatus,
} from '@prisma/client';

export interface RefundEvidenceVerificationProof {
  verifiedByAdapter: string;
  adapterVerificationToken?: string;
  providerSignature?: string;
  verifiedAt: Date;
}

export interface RefundExternalEvidencePayload {
  provenance: RefundEvidenceProvenance;
  eventId: string;
  rawPayload: Record<string, unknown> | string;
  evidenceDigest: string;
  eventTimestamp: Date;
  sourceIp?: string | null;
  signatureValid?: boolean;
  verification?: RefundEvidenceVerificationProof;
}

export interface ProcessRefundEvidenceInput {
  attemptId?: string | null;
  obligationId?: string | null;
  provider: PaymentProviderName;
  merchantAccountId: string;
  parentPaymentReference?: string | null;
  providerRefundReference?: string | null;
  providerIdempotencyKey?: string | null;
  amount: number | string | Prisma.Decimal;
  currency: string;
  outcome: 'COMPLETED' | 'PENDING' | 'FAILED';
  httpStatusCode?: number | null;
  evidence: RefundExternalEvidencePayload;
}

export interface RefundEvidenceProcessingPolicy {
  allowSimulatedEvidence: boolean;
  trustedWebhookAdapters: string[];
  trustedStatusPollAdapters: string[];
}

export interface ProcessRefundEvidenceResult {
  applied: boolean;
  disposition: RefundEvidenceDisposition;
  attemptId?: string | null;
  refundId?: string | null;
  obligationId?: string | null;
  resultingAttemptStatus?: RefundAttemptStatus | null;
  resultingRefundStatus?: RefundStatus | null;
  resultingObligationStatus?: RefundObligationStatus | null;
  receiptId: string;
  attemptEventId?: string | null;
  outboxEventId?: string | null;
  quarantined: boolean;
  message: string;
}

export interface RecoverExpiredAttemptOutcome {
  attemptId: string;
  refundId: string;
  obligationId: string;
  transitioned: boolean;
  previousAttemptStatus?: RefundAttemptStatus;
  resultingAttemptStatus: RefundAttemptStatus;
  attemptEventId?: string;
  outboxEventId?: string;
  reason: string;
}

export interface RecoverExpiredLeasesSummary {
  scannedCount: number;
  quarantinedIds: string[];
  skippedCount: number;
  results: RecoverExpiredAttemptOutcome[];
}

export interface ReconcileRefundAttemptStatusResult {
  attemptId: string;
  outcome:
    | 'SKIPPED_LEASED_OR_INELIGIBLE'
    | 'COMPLETED'
    | 'PENDING'
    | 'FAILED'
    | 'CONFLICT_QUARANTINED'
    | 'DUPLICATE_IGNORED';
  evidenceResult?: ProcessRefundEvidenceResult;
  message: string;
}

export interface RefundOutboxPolicy {
  allowNotificationDispatch: boolean;
}

export interface RefundOutboxRecord {
  id: string;
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  logicalEventKey: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export type RefundOutboxConsumer = (event: RefundOutboxRecord) => Promise<void>;

export interface RefundOutboxDispatchResult {
  fetchedCount: number;
  publishedIds: string[];
  skippedAlreadyPublishedIds: string[];
  failed: Array<{ outboxId: string; logicalEventKey: string; message: string }>;
}
