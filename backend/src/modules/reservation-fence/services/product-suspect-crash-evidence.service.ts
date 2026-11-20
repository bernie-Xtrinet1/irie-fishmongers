import { createHash } from 'crypto';

import { Injectable } from '@nestjs/common';

import { UUID_PATTERN } from '../types/reservation-fence.types';
import {
  CrashEvidenceEvaluationInput,
  CrashEvidenceEvaluationResult,
  ProductSuspectClearanceReceipt,
} from '../types/product-suspect-recovery.types';

function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseClearanceReceipt(raw: string | null): ProductSuspectClearanceReceipt | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObjectRecord(parsed)) return null;
    if (
      parsed.version !== 1 ||
      parsed.effect !== 'PRODUCT_SUSPECT_CLEARANCE' ||
      parsed.status !== 'APPLIED' ||
      !(
        typeof parsed.requestId === 'string' &&
        UUID_PATTERN.test(parsed.requestId) &&
        typeof parsed.productId === 'string' &&
        typeof parsed.incarnation === 'string' &&
        UUID_PATTERN.test(parsed.incarnation)
      ) ||
      !Number.isInteger(parsed.epoch) ||
      (parsed.epoch as number) <= 0 ||
      !Number.isInteger(parsed.clearedControlRevision) ||
      (parsed.clearedControlRevision as number) < 2 ||
      (parsed.clearedControlRevision as number) % 2 !== 0 ||
      typeof parsed.reconciliationDigest !== 'string' ||
      typeof parsed.approvalDigest !== 'string' ||
      !Number.isInteger(parsed.targetTotal) ||
      (parsed.targetTotal as number) < 0
    ) {
      return null;
    }
    return parsed as unknown as ProductSuspectClearanceReceipt;
  } catch {
    return null;
  }
}

function matchesRecoveryReceipt(
  receipt: ProductSuspectClearanceReceipt,
  input: CrashEvidenceEvaluationInput,
  rawHash: string,
): boolean {
  const r = input.recovery;
  if (r.redisReceiptHash && r.redisReceiptHash !== rawHash) return false;
  return (
    receipt.requestId === r.requestId &&
    receipt.productId === r.productId &&
    receipt.incarnation === r.incarnation &&
    receipt.epoch === r.fenceEpoch &&
    receipt.clearedControlRevision === r.clearedControlRevision &&
    receipt.reconciliationDigest === r.reconciliationDigest &&
    receipt.approvalDigest === r.approvalDigest &&
    receipt.targetTotal === r.targetReconciledTotal
  );
}

function isPreStateControlIntact(input: CrashEvidenceEvaluationInput): boolean {
  const { recovery, control } = input;
  if (control.keyState !== 'PRESENT' || control.ttlMs !== -1 || !control.payload) return false;
  const p = control.payload;
  if (p.productId !== recovery.productId || p.incarnation !== recovery.incarnation || p.epoch !== recovery.fenceEpoch) {
    return false;
  }
  if (recovery.restrictionId !== null) {
    if (p.state === 'RESTRICTED') {
      return p.restrictionId === recovery.restrictionId && p.restrictionRevision === recovery.targetRestrictionRevision;
    }
    if (p.state === 'CLEARANCE_STAGED' && recovery.stagedControlRevision !== null) {
      return p.restrictionId === recovery.restrictionId && p.restrictionRevision === recovery.stagedControlRevision;
    }
    return false;
  }
  if (p.state === 'CLEARANCE_STAGED' && recovery.stagedControlRevision !== null) {
    return p.restrictionRevision === recovery.stagedControlRevision;
  }
  return p.state === 'ALLOW' && p.restrictionId === null && p.restrictionRevision < recovery.clearedControlRevision;
}

function isPreStateTotalIntact(input: CrashEvidenceEvaluationInput): boolean {
  if (input.recovery.priorStoredTotal === null) {
    return input.storedTotalState === 'ABSENT' && input.storedTotal === null;
  }
  return input.storedTotalState === 'VALID_INTEGER' && input.storedTotal === input.recovery.priorStoredTotal;
}

/**
 * Pure read-only classifier for interrupted PRODUCT_SUSPECT clearance attempts.
 * Never executes Redis clearance, repairs inventory accounting, or advances products to ALLOW.
 */
@Injectable()
export class ProductSuspectCrashEvidenceService {
  evaluate(input: CrashEvidenceEvaluationInput): CrashEvidenceEvaluationResult {
    const r = input.recovery;

    if (input.infrastructureError) {
      return {
        classification: 'UNKNOWN',
        nextStatus: 'AMBIGUOUS_QUARANTINED',
        canComplete: false,
        quarantineRequired: true,
        reasonCode: 'EVIDENCE_COLLECTION_INCOMPLETE',
        detail: 'Redis or PostgreSQL evidence read failed; quarantine without assuming non-execution.',
        receiptHash: null,
      };
    }

    if (r.status !== 'EXECUTING' && r.status !== 'COMPLETED' && r.status !== 'AMBIGUOUS_QUARANTINED') {
      return {
        classification: 'UNKNOWN',
        nextStatus: 'AMBIGUOUS_QUARANTINED',
        canComplete: false,
        quarantineRequired: true,
        reasonCode: 'INVALID_RECOVERY_PHASE_FOR_EVIDENCE',
        detail: `Recovery status ${r.status} cannot establish APPLIED or NOT_APPLIED clearance evidence.`,
        receiptHash: null,
      };
    }

    if (input.receipt.keyState === 'WRONG_TYPE' || input.receipt.keyState === 'MALFORMED') {
      return {
        classification: 'AMBIGUOUS',
        nextStatus: 'AMBIGUOUS_QUARANTINED',
        canComplete: false,
        quarantineRequired: true,
        reasonCode: 'CORRUPT_EXECUTION_RECEIPT',
        detail: 'Execution receipt key exists with invalid type or corrupt JSON payload.',
        receiptHash: null,
      };
    }

    if (input.control.keyState === 'WRONG_TYPE' || input.control.keyState === 'MALFORMED') {
      return {
        classification: 'AMBIGUOUS',
        nextStatus: 'AMBIGUOUS_QUARANTINED',
        canComplete: false,
        quarantineRequired: true,
        reasonCode: 'CORRUPT_PRODUCT_CONTROL',
        detail: 'Product control key is malformed or has unexpected Redis type.',
        receiptHash: null,
      };
    }

    if (
      input.control.keyState === 'PRESENT' &&
      (input.control.ttlMs !== -1 ||
        !input.control.payload ||
        input.control.payload.productId !== r.productId ||
        input.control.payload.incarnation !== r.incarnation ||
        input.control.payload.epoch !== r.fenceEpoch ||
        input.control.payload.restrictionRevision > r.clearedControlRevision)
    ) {
      return {
        classification: 'AMBIGUOUS',
        nextStatus: 'AMBIGUOUS_QUARANTINED',
        canComplete: false,
        quarantineRequired: true,
        reasonCode: 'CONTRADICTORY_PRODUCT_CONTROL',
        detail: 'Product control payload, TTL, fence binding, or revision contradicts expected clearance window.',
        receiptHash: null,
      };
    }

    if (input.receipt.keyState === 'PRESENT') {
      const parsedReceipt = parseClearanceReceipt(input.receipt.raw);
      const receiptHash = input.receipt.raw ? sha256Hex(input.receipt.raw) : null;
      if (!parsedReceipt || !receiptHash || !matchesRecoveryReceipt(parsedReceipt, input, receiptHash)) {
        return {
          classification: 'AMBIGUOUS',
          nextStatus: 'AMBIGUOUS_QUARANTINED',
          canComplete: false,
          quarantineRequired: true,
          reasonCode: 'RECEIPT_IDENTITY_MISMATCH',
          detail: 'Execution receipt schema, digest, or identity binding contradicts durable recovery record.',
          receiptHash: null,
        };
      }

      const durableValid =
        r.restrictionId === null
          ? input.durableRestrictionState === 'ABSENT' || input.durableRestrictionState === 'CLEARED'
          : input.durableRestrictionId === r.restrictionId &&
            input.durableRestrictionRevision === r.targetRestrictionRevision &&
            (input.durableRestrictionState === 'CLEARING' ||
              input.durableRestrictionState === 'ENFORCED' ||
              input.durableRestrictionState === 'PREPARED' ||
              (input.durableRestrictionState === 'CLEARED' && input.durableClearedByRecoveryId === r.id));

      const physicalApplied =
        input.control.keyState === 'PRESENT' &&
        input.control.ttlMs === -1 &&
        input.control.payload?.state === 'ALLOW' &&
        input.control.payload.restrictionId === null &&
        input.control.payload.restrictionRevision === r.clearedControlRevision &&
        input.suspectPresent === false &&
        input.storedTotalState === 'VALID_INTEGER' &&
        input.storedTotal === r.targetReconciledTotal &&
        durableValid;

      if (!physicalApplied) {
        return {
          classification: 'AMBIGUOUS',
          nextStatus: 'AMBIGUOUS_QUARANTINED',
          canComplete: false,
          quarantineRequired: true,
          reasonCode: 'RECEIPT_PHYSICAL_CONTRADICTION',
          detail: 'Valid receipt conflicts with live Redis product control, suspect flag, total, or durable state.',
          receiptHash: null,
        };
      }

      return {
        classification: 'APPLIED',
        nextStatus: 'COMPLETED',
        canComplete: true,
        quarantineRequired: false,
        reasonCode: 'VERIFIED_APPLIED',
        detail: 'Durable recovery, cryptographic receipt, and physical Redis state establish APPLIED clearance.',
        receiptHash,
      };
    }

    // No valid receipt is present ('ABSENT' or 'EXPIRED_OR_EVICTED').
    if (
      input.control.keyState === 'PRESENT' &&
      input.control.payload?.state === 'ALLOW' &&
      input.control.payload.restrictionRevision >= r.clearedControlRevision
    ) {
      return {
        classification: 'AMBIGUOUS',
        nextStatus: 'AMBIGUOUS_QUARANTINED',
        canComplete: false,
        quarantineRequired: true,
        reasonCode: 'PHYSICAL_APPLIED_WITHOUT_RECEIPT',
        detail: 'Redis control already reflects cleared revision without a valid verifiable receipt.',
        receiptHash: null,
      };
    }

    if (r.priorSuspectPresent && input.suspectPresent === false) {
      return {
        classification: 'AMBIGUOUS',
        nextStatus: 'AMBIGUOUS_QUARANTINED',
        canComplete: false,
        quarantineRequired: true,
        reasonCode: 'SUSPECT_FLAG_CLEARED_WITHOUT_RECEIPT',
        detail: 'Product suspect flag disappeared without a verified execution receipt.',
        receiptHash: null,
      };
    }

    if (input.receipt.keyState === 'EXPIRED_OR_EVICTED' || r.redisReceiptHash !== null) {
      return {
        classification: 'UNKNOWN',
        nextStatus: 'AMBIGUOUS_QUARANTINED',
        canComplete: false,
        quarantineRequired: true,
        reasonCode: 'EXPIRED_OR_MISSING_RECEIPT',
        detail: 'Missing or expired receipt alone cannot establish non-execution; quarantine required.',
        receiptHash: null,
      };
    }

    // Positively establish NOT_APPLIED only when pre-state is completely intact AND
    // either an unconsumed permit/pre-write abort is confirmed OR an irreducible
    // durable restriction/staged control still stands untouched in Redis.
    const positiveNonExecutionProven =
      isPreStateControlIntact(input) &&
      isPreStateTotalIntact(input) &&
      input.suspectPresent === r.priorSuspectPresent &&
      (input.permitState === 'UNCONSUMED_PRESENT' || input.preWriteAbortVerified === true);

    if (positiveNonExecutionProven) {
      return {
        classification: 'NOT_APPLIED',
        nextStatus: 'ABORTED',
        canComplete: false,
        quarantineRequired: false,
        reasonCode: 'POSITIVELY_ESTABLISHED_NOT_APPLIED',
        detail: 'Unconsumed permit/pre-write abort and completely intact pre-execution Redis state establish NOT_APPLIED.',
        receiptHash: null,
      };
    }

    return {
      classification: 'UNKNOWN',
      nextStatus: 'AMBIGUOUS_QUARANTINED',
      canComplete: false,
      quarantineRequired: true,
      reasonCode: 'INSUFFICIENT_NON_EXECUTION_PROOF',
      detail: 'Non-execution could not be positively proven; missing receipt alone is insufficient.',
      receiptHash: null,
    };
  }
}
