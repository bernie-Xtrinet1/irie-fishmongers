import { ProductReservationRestriction, ProductSuspectRecovery } from '@prisma/client';

import { RedisService } from '../../../common/redis/redis.service';
import { productSuspectKey, productTotalKey } from '../../inventory/constants/inventory.constants';
import {
  OBSERVE_PRODUCT_SUSPECT_CLEARANCE_LUA,
  UNSTAGE_PRODUCT_SUSPECT_CLEARANCE_LUA,
} from '../lua/product-suspect-clearance.lua';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { clearancePermitKey, clearanceReceiptKey } from '../types/product-suspect-clearance.types';
import { ProductRestrictionControl, productControlKey } from '../types/product-reservation-restriction.types';
import {
  CrashEvidenceControlObservation,
  CrashEvidenceEvaluationResult,
  CrashEvidenceReceiptObservation,
} from '../types/product-suspect-recovery.types';
import { FenceTuple } from '../types/reservation-fence.types';
import { ProductSuspectCrashEvidenceService } from './product-suspect-crash-evidence.service';

export interface ObservedRedisSnapshot {
  infrastructureError: boolean;
  receipt: CrashEvidenceReceiptObservation;
  control: CrashEvidenceControlObservation;
  suspectPresent: boolean | null;
  storedTotal: number | null;
  storedTotalState: 'ABSENT' | 'VALID_INTEGER' | 'INVALID_OR_WRONG_TYPE';
  permitState: 'UNCONSUMED_PRESENT' | 'ABSENT' | 'UNKNOWN';
  rawReceipt: string | null;
  rawControl: string | null;
}

function parseControlPayload(raw: string | null): ProductRestrictionControl | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (
      Object.keys(rec).length !== 7 ||
      rec.version !== 1 ||
      typeof rec.productId !== 'string' ||
      (rec.state !== 'ALLOW' && rec.state !== 'RESTRICTED' && rec.state !== 'CLEARANCE_STAGED') ||
      (rec.restrictionId !== null && typeof rec.restrictionId !== 'string') ||
      !Number.isInteger(rec.restrictionRevision) ||
      typeof rec.incarnation !== 'string' ||
      !Number.isInteger(rec.epoch)
    ) {
      return null;
    }
    return parsed as unknown as ProductRestrictionControl;
  } catch {
    return null;
  }
}

export async function observeClearanceRedisState(
  redis: RedisService,
  recovery: Pick<ProductSuspectRecovery, 'requestId' | 'productId' | 'redisReceiptHash'>,
): Promise<ObservedRedisSnapshot> {
  try {
    const raw = await redis.eval(
      OBSERVE_PRODUCT_SUSPECT_CLEARANCE_LUA,
      [
        RESERVATION_FENCE_KEY,
        clearancePermitKey(recovery.requestId),
        clearanceReceiptKey(recovery.requestId),
        productControlKey(recovery.productId),
        productSuspectKey(recovery.productId),
        productTotalKey(recovery.productId),
      ],
      [],
    );
    const data = JSON.parse(String(raw)) as {
      permitPresent: boolean;
      permitPttlMs: number;
      receiptType: string;
      receiptPttlMs: number;
      receiptRaw: string | null;
      controlType: string;
      controlPttlMs: number;
      controlRaw: string | null;
      suspectPresent: boolean;
      suspectType: string;
      totalType: string;
      totalRaw: string | null;
    };

    let receipt: CrashEvidenceReceiptObservation;
    if (data.receiptType === 'none') {
      receipt = {
        keyState: recovery.redisReceiptHash !== null ? 'EXPIRED_OR_EVICTED' : 'ABSENT',
        raw: null,
      };
    } else if (data.receiptType !== 'string') {
      receipt = { keyState: 'WRONG_TYPE', raw: null };
    } else if (data.receiptPttlMs !== -1) {
      receipt = { keyState: 'MALFORMED', raw: data.receiptRaw };
    } else {
      let validJson = false;
      try {
        const parsed: unknown = data.receiptRaw ? JSON.parse(data.receiptRaw) : null;
        validJson = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
      } catch {
        validJson = false;
      }
      receipt = { keyState: validJson ? 'PRESENT' : 'MALFORMED', raw: data.receiptRaw };
    }

    let control: CrashEvidenceControlObservation;
    if (data.controlType === 'none') {
      control = { keyState: 'ABSENT', ttlMs: null, payload: null };
    } else if (data.controlType !== 'string') {
      control = { keyState: 'WRONG_TYPE', ttlMs: null, payload: null };
    } else {
      const payload = parseControlPayload(data.controlRaw);
      control = {
        keyState: payload ? 'PRESENT' : 'MALFORMED',
        ttlMs: data.controlPttlMs,
        payload,
      };
    }

    const suspectPresent =
      data.suspectType === 'none' ? false : data.suspectType === 'string' ? true : null;

    let storedTotalState: ObservedRedisSnapshot['storedTotalState'] = 'INVALID_OR_WRONG_TYPE';
    let storedTotal: number | null = null;
    if (data.totalType === 'none') {
      storedTotalState = 'ABSENT';
    } else if (data.totalType === 'string' && data.totalRaw !== null && /^(0|[1-9][0-9]*)$/.test(data.totalRaw)) {
      const num = Number(data.totalRaw);
      if (Number.isSafeInteger(num)) {
        storedTotalState = 'VALID_INTEGER';
        storedTotal = num;
      }
    }

    return {
      infrastructureError: false,
      receipt,
      control,
      suspectPresent,
      storedTotal,
      storedTotalState,
      permitState: data.permitPresent ? 'UNCONSUMED_PRESENT' : 'ABSENT',
      rawReceipt: data.receiptRaw,
      rawControl: data.controlRaw,
    };
  } catch {
    return {
      infrastructureError: true,
      receipt: { keyState: 'ABSENT', raw: null },
      control: { keyState: 'ABSENT', ttlMs: null, payload: null },
      suspectPresent: null,
      storedTotal: null,
      storedTotalState: 'INVALID_OR_WRONG_TYPE',
      permitState: 'UNKNOWN',
      rawReceipt: null,
      rawControl: null,
    };
  }
}

export function evaluateObservedClearance(
  crashEvidence: ProductSuspectCrashEvidenceService,
  recovery: ProductSuspectRecovery,
  restriction: ProductReservationRestriction | null,
  obs: ObservedRedisSnapshot,
  preWriteAbortVerified?: boolean,
): CrashEvidenceEvaluationResult {
  return crashEvidence.evaluate({
    recovery: {
      id: recovery.id,
      requestId: recovery.requestId,
      productId: recovery.productId,
      restrictionId: recovery.restrictionId,
      targetRestrictionRevision: recovery.targetRestrictionRevision,
      stagedControlRevision: recovery.stagedControlRevision,
      clearedControlRevision: recovery.clearedControlRevision,
      incarnation: recovery.incarnation,
      fenceEpoch: recovery.fenceEpoch,
      reconciliationDigest: recovery.reconciliationDigest,
      approvalDigest: recovery.approvalDigest,
      priorStoredTotal: recovery.priorStoredTotal,
      targetReconciledTotal: recovery.targetReconciledTotal,
      priorSuspectPresent: recovery.priorSuspectPresent,
      status: recovery.status,
      redisReceiptHash: recovery.redisReceiptHash,
    },
    durableRestrictionState: restriction ? restriction.state : 'ABSENT',
    durableRestrictionId: restriction?.id ?? null,
    durableRestrictionRevision: restriction?.restrictionRevision ?? null,
    durableClearedByRecoveryId: restriction?.clearedByRecoveryId ?? null,
    infrastructureError: obs.infrastructureError,
    receipt: obs.receipt,
    control: obs.control,
    suspectPresent: obs.suspectPresent,
    storedTotal: obs.storedTotal,
    storedTotalState: obs.storedTotalState,
    permitState: obs.permitState,
    preWriteAbortVerified,
  });
}

export async function bestEffortUnstageAfterAbort(
  redis: RedisService,
  recovery: ProductSuspectRecovery,
  fence: FenceTuple | null,
): Promise<void> {
  if (!recovery.restrictionId || recovery.stagedControlRevision === null || !fence) return;
  if (fence.incarnation !== recovery.incarnation || fence.epoch !== recovery.fenceEpoch) return;
  try {
    await redis.eval(
      UNSTAGE_PRODUCT_SUSPECT_CLEARANCE_LUA,
      [
        RESERVATION_FENCE_KEY,
        clearanceReceiptKey(recovery.requestId),
        productControlKey(recovery.productId),
      ],
      [
        JSON.stringify({
          tuple: fence,
          requestId: recovery.requestId,
          productId: recovery.productId,
          restrictionId: recovery.restrictionId,
          targetRestrictionRevision: recovery.targetRestrictionRevision,
          stagedControlRevision: recovery.stagedControlRevision,
        }),
      ],
    );
  } catch {
    // Non-fatal: CLEARANCE_STAGED still denies all W1/availability mutations.
  }
}
