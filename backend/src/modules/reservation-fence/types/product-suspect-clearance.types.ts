import { createHash } from 'crypto';
import {
  ProductSuspectExecutionEvidence,
  ProductSuspectRecoveryStatus,
} from '@prisma/client';

import { FenceTuple } from './reservation-fence.types';
import {
  CrashEvidenceEvaluationResult,
} from './product-suspect-recovery.types';

export const CLEARANCE_APPROVAL_TTL_MIN_MS = 60_000;
export const CLEARANCE_APPROVAL_TTL_MAX_MS = 86_400_000;
export const CLEARANCE_APPROVAL_TTL_DEFAULT_MS = 900_000;
export const CLEARANCE_PERMIT_TTL_DEFAULT_MS = 5_000;
export const CLEARANCE_PERMIT_TTL_MAX_MS = 5_000;
export const RECONCILIATION_SCAN_MAX_KEYS = 2_000;
export const RECONCILIATION_SCAN_MAX_ITERATIONS = 500;

export const clearancePermitKey = (requestId: string): string =>
  `reservation:fence:w1-clearance:permit:${requestId}`;

export const clearanceReceiptKey = (requestId: string): string =>
  `reservation:fence:w1-clearance:receipt:${requestId}`;

export interface ClearanceActiveCartSnapshot {
  cartId: string;
  customerId: string;
  markerId: string | null;
  syncStateId: string | null;
  expectedGeneration: number | null;
  quantity: number;
  expiresAt: number;
  absoluteExpiresAt: number;
}

export interface ClearanceTargetManifestEntry {
  targetKind: 'COMPENSATION' | 'SYNC_STATE';
  id: string;
  cartId: string;
  expectedGeneration: number;
  priorAttemptCount: number;
}

export interface ClearanceReconciliationSnapshot {
  version: 1;
  productId: string;
  restrictionId: string;
  targetRestrictionRevision: number;
  clearedControlRevision: number;
  quantityAvailable: number;
  priorStoredTotal: number | null;
  targetReconciledTotal: number;
  priorSuspectPresent: boolean;
  activeReservations: ClearanceActiveCartSnapshot[];
  redisObservedCartIds: string[];
  expectedCartIds: string[];
  markerIds: string[];
  unblockedTargets: ClearanceTargetManifestEntry[];
  driftAfter: 0;
}

export interface ClearanceApprovalDigestInput {
  version: 1;
  requestId: string;
  productId: string;
  restrictionId: string;
  targetRestrictionRevision: number;
  clearedControlRevision: number;
  fenceTransitionId: string;
  incarnation: string;
  fenceEpoch: number;
  fenceRevision: number;
  authorizationPhase: 'OPEN' | 'DRAINING';
  modeRevision: number;
  observationDigest: string;
  reconciliationDigest: string;
  targetReconciledTotal: number;
  affectedMarkerCount: number;
  affectedCompensationCount: number;
}

export interface ClearanceLuaPermitActiveItem {
  cartId: string;
  markerId: string | null;
  quantity: number;
}

export interface ClearanceLuaPermit {
  version: 1;
  effect: 'PRODUCT_SUSPECT_CLEARANCE';
  authorizationPhase: 'OPEN' | 'DRAINING';
  tuple: FenceTuple;
  requestId: string;
  productId: string;
  restrictionId: string;
  targetRestrictionRevision: number;
  stagedControlRevision: number;
  clearedControlRevision: number;
  reconciliationDigest: string;
  approvalDigest: string;
  priorStoredTotal: number | null;
  targetReconciledTotal: number;
  priorSuspectPresent: boolean;
  permitTtlMs: number;
  activeReservations: ClearanceLuaPermitActiveItem[];
  expectedCartIds: string[];
  markerIds: string[];
  expiresAt: number;
}

export interface ClearanceRequestInput {
  requestId?: string;
  productId: string;
  requestedById: string;
  requestReason: string;
  permitTtlMs?: number;
}

export interface ClearanceApproveInput {
  recoveryId: string;
  approvedById: string;
  approvalTtlMs?: number;
}

export interface ClearanceRejectInput {
  recoveryId: string;
  rejectedById: string;
  rejectionReason: string;
}

export interface ClearanceExecuteInput {
  recoveryId: string;
  executorAdminId?: string;
  nowMs?: number;
}

export interface ClearanceOperationFailure {
  ok: false;
  code: string;
  message: string;
  status?: ProductSuspectRecoveryStatus;
  recoveryId?: string;
}

export type ClearanceRequestResult =
  | {
      ok: true;
      recoveryId: string;
      requestId: string;
      status: 'REQUESTED';
      targetRestrictionRevision: number;
      clearedControlRevision: number;
      reconciliationDigest: string;
      targetReconciledTotal: number;
      affectedMarkerCount: number;
      affectedCompensationCount: number;
    }
  | ClearanceOperationFailure;

export type ClearanceApproveResult =
  | {
      ok: true;
      recoveryId: string;
      status: 'APPROVED';
      approvedAt: Date;
      approvalExpiresAt: Date;
      approvalDigest: string;
    }
  | ClearanceOperationFailure;

export type ClearanceRejectResult =
  | {
      ok: true;
      recoveryId: string;
      status: 'REJECTED';
      rejectedAt: Date;
    }
  | ClearanceOperationFailure;

export type ClearanceExecuteResult =
  | {
      ok: true;
      recoveryId: string;
      status: 'COMPLETED';
      replayed: boolean;
      clearedControlRevision: number;
      targetReconciledTotal: number;
      receiptHash: string;
      unblockedSyncCount: number;
      unblockedCompCount: number;
      skippedTargetCount: number;
    }
  | ClearanceOperationFailure;

export interface ClearanceObservationResult {
  found: boolean;
  recoveryId: string;
  status?: ProductSuspectRecoveryStatus;
  restrictionState?: string | null;
  targetRestrictionRevision?: number;
  clearedControlRevision?: number;
  redisControlRaw?: string | null;
  redisReceiptRaw?: string | null;
  redisSuspectPresent?: boolean;
  redisStoredTotal?: number | null;
  crashEvaluation?: CrashEvidenceEvaluationResult | null;
  evidenceSummary?: ProductSuspectExecutionEvidence | null;
}

export function canonicalClearanceJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalClearanceJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalClearanceJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function clearanceSha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function computeClearanceApprovalDigest(input: ClearanceApprovalDigestInput): string {
  return clearanceSha256Hex(canonicalClearanceJson(input));
}
