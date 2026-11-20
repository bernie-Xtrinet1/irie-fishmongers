import {
  ProductReservationRestrictionState,
  ProductSuspectExecutionEvidence,
  ProductSuspectRecoveryStatus,
} from '@prisma/client';

import { ProductRestrictionControl } from './product-reservation-restriction.types';

export interface ProductSuspectRecoveryRecordSnapshot {
  id: string;
  requestId: string;
  productId: string;
  restrictionId: string | null;
  targetRestrictionRevision: number;
  clearedControlRevision: number;
  stagedControlRevision: number | null;
  incarnation: string;
  fenceEpoch: number;
  reconciliationDigest: string;
  approvalDigest: string | null;
  priorStoredTotal: number | null;
  targetReconciledTotal: number;
  priorSuspectPresent: boolean;
  status: ProductSuspectRecoveryStatus;
  redisReceiptHash: string | null;
}

export interface ProductSuspectClearanceReceipt {
  version: 1;
  effect: 'PRODUCT_SUSPECT_CLEARANCE';
  status: 'APPLIED';
  requestId: string;
  productId: string;
  incarnation: string;
  epoch: number;
  clearedControlRevision: number;
  reconciliationDigest: string;
  approvalDigest: string;
  targetTotal: number;
}

export interface CrashEvidenceControlObservation {
  keyState: 'ABSENT' | 'PRESENT' | 'WRONG_TYPE' | 'MALFORMED';
  ttlMs: number | null;
  payload: ProductRestrictionControl | null;
}

export interface CrashEvidenceReceiptObservation {
  keyState: 'ABSENT' | 'EXPIRED_OR_EVICTED' | 'PRESENT' | 'WRONG_TYPE' | 'MALFORMED';
  raw: string | null;
}

export interface CrashEvidenceEvaluationInput {
  recovery: ProductSuspectRecoveryRecordSnapshot;
  durableRestrictionState: ProductReservationRestrictionState | 'ABSENT';
  durableRestrictionId: string | null;
  durableRestrictionRevision: number | null;
  durableClearedByRecoveryId: string | null;
  infrastructureError: boolean;
  receipt: CrashEvidenceReceiptObservation;
  control: CrashEvidenceControlObservation;
  suspectPresent: boolean | null;
  storedTotal: number | null;
  storedTotalState: 'ABSENT' | 'VALID_INTEGER' | 'INVALID_OR_WRONG_TYPE';
  permitState: 'UNCONSUMED_PRESENT' | 'ABSENT' | 'UNKNOWN';
  preWriteAbortVerified?: boolean;
}

export interface CrashEvidenceEvaluationResult {
  classification: ProductSuspectExecutionEvidence;
  nextStatus: 'COMPLETED' | 'ABORTED' | 'AMBIGUOUS_QUARANTINED';
  canComplete: boolean;
  quarantineRequired: boolean;
  reasonCode: string;
  detail: string;
  receiptHash: string | null;
}
