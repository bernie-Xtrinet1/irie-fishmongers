import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';

import { RedisService } from '../../../common/redis/redis.service';
import { productIndexKey, productSuspectKey, productTotalKey } from '../../inventory/constants/inventory.constants';
import {
  EXECUTE_PRODUCT_SUSPECT_CLEARANCE_LUA,
  REGISTER_PRODUCT_SUSPECT_CLEARANCE_LUA,
  STAGE_PRODUCT_SUSPECT_CLEARANCE_LUA,
} from '../lua/product-suspect-clearance.lua';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { ReservationFenceRepository, transitionTuple } from '../repositories/reservation-fence.repository';
import { productControlKey } from '../types/product-reservation-restriction.types';
import {
  CLEARANCE_APPROVAL_TTL_DEFAULT_MS,
  CLEARANCE_APPROVAL_TTL_MAX_MS,
  CLEARANCE_APPROVAL_TTL_MIN_MS,
  CLEARANCE_PERMIT_TTL_DEFAULT_MS,
  CLEARANCE_PERMIT_TTL_MAX_MS,
  ClearanceApproveInput,
  ClearanceApproveResult,
  ClearanceExecuteInput,
  ClearanceExecuteResult,
  ClearanceObservationResult,
  ClearanceRejectInput,
  ClearanceRejectResult,
  ClearanceRequestInput,
  ClearanceRequestResult,
  clearancePermitKey,
  clearanceReceiptKey,
} from '../types/product-suspect-clearance.types';
import { FenceTuple, UUID_PATTERN } from '../types/reservation-fence.types';
import { persistClearanceOutcomeTx } from './product-suspect-clearance-completion.helper';
import {
  bestEffortUnstageAfterAbort,
  evaluateObservedClearance,
  observeClearanceRedisState,
} from './product-suspect-clearance-observation.helper';
import {
  approveClearanceTx,
  prepareClearanceExecutionTx,
  rejectClearanceTx,
  requestClearanceTx,
} from './product-suspect-clearance-preparation.helper';
import { ProductSuspectCrashEvidenceService } from './product-suspect-crash-evidence.service';

@Injectable()
export class ProductSuspectClearanceService {
  constructor(
    private readonly fences: ReservationFenceRepository,
    private readonly redis: RedisService,
    private readonly crashEvidence: ProductSuspectCrashEvidenceService,
  ) {}

  async requestClearance(input: ClearanceRequestInput): Promise<ClearanceRequestResult> {
    const requestId = input.requestId ?? randomUUID();
    const permitTtlMs = input.permitTtlMs ?? CLEARANCE_PERMIT_TTL_DEFAULT_MS;
    if (!UUID_PATTERN.test(requestId)) {
      return { ok: false, code: 'INVALID_REQUEST_ID', message: 'requestId must be a valid UUID' };
    }
    if (!input.requestReason.trim() || input.requestReason.length > 256) {
      return { ok: false, code: 'INVALID_REQUEST_REASON', message: 'Non-empty requestReason <= 256 chars required' };
    }
    if (!Number.isInteger(permitTtlMs) || permitTtlMs < 1 || permitTtlMs > CLEARANCE_PERMIT_TTL_MAX_MS) {
      return { ok: false, code: 'INVALID_PERMIT_TTL', message: 'permitTtlMs must be 1..5000 ms' };
    }
    return this.fences.locked((tx) =>
      requestClearanceTx({ tx, fences: this.fences, redis: this.redis, input, requestId, permitTtlMs }),
    );
  }

  async approveClearance(input: ClearanceApproveInput): Promise<ClearanceApproveResult> {
    const approvalTtlMs = input.approvalTtlMs ?? CLEARANCE_APPROVAL_TTL_DEFAULT_MS;
    if (
      !Number.isInteger(approvalTtlMs) ||
      approvalTtlMs < CLEARANCE_APPROVAL_TTL_MIN_MS ||
      approvalTtlMs > CLEARANCE_APPROVAL_TTL_MAX_MS
    ) {
      return { ok: false, code: 'INVALID_APPROVAL_TTL', message: 'Finite bounded approvalTtlMs required' };
    }
    if (!UUID_PATTERN.test(input.recoveryId)) {
      return { ok: false, code: 'INVALID_RECOVERY_ID', message: 'Invalid recoveryId' };
    }
    return this.fences.locked((tx) =>
      approveClearanceTx({ tx, fences: this.fences, redis: this.redis, input, approvalTtlMs }),
    );
  }

  async rejectClearance(input: ClearanceRejectInput): Promise<ClearanceRejectResult> {
    if (!UUID_PATTERN.test(input.recoveryId)) {
      return { ok: false, code: 'INVALID_RECOVERY_ID', message: 'Invalid recoveryId' };
    }
    if (!input.rejectionReason.trim() || input.rejectionReason.length > 256) {
      return { ok: false, code: 'INVALID_REJECTION_REASON', message: 'Non-empty rejectionReason <= 256 chars required' };
    }
    return this.fences.locked((tx) => rejectClearanceTx(tx, input));
  }

  async executeClearance(input: ClearanceExecuteInput): Promise<ClearanceExecuteResult> {
    if (!UUID_PATTERN.test(input.recoveryId)) {
      return { ok: false, code: 'INVALID_RECOVERY_ID', message: 'Invalid recoveryId' };
    }
    const prep = await this.fences.locked((tx) =>
      prepareClearanceExecutionTx({ tx, fences: this.fences, redis: this.redis, input }),
    );
    if (prep.kind === 'RETURN') return prep.result;
    if (prep.kind === 'RECOVER') return this.recoverClearance(prep.recoveryId);

    const { permit, tuple, recoveryId } = prep;
    const keys = [
      RESERVATION_FENCE_KEY,
      clearancePermitKey(permit.requestId),
      clearanceReceiptKey(permit.requestId),
      productControlKey(permit.productId),
      productSuspectKey(permit.productId),
      productTotalKey(permit.productId),
      productIndexKey(permit.productId),
    ];

    try {
      const regRaw = await this.redis.eval(REGISTER_PRODUCT_SUSPECT_CLEARANCE_LUA, keys, [JSON.stringify(permit)]);
      const regParsed = JSON.parse(String(regRaw)) as { code: string; value?: unknown };
      if (regParsed.code !== 'ACCEPTED') return this.recoverClearance(recoveryId, true, tuple);

      const stageArg = JSON.stringify(regParsed.value);
      const stageRaw = await this.redis.eval(STAGE_PRODUCT_SUSPECT_CLEARANCE_LUA, keys, [stageArg]);
      const stageParsed = JSON.parse(String(stageRaw)) as { code: string };
      if (stageParsed.code !== 'ACCEPTED') return this.recoverClearance(recoveryId, true, tuple);

      const execRaw = await this.redis.eval(EXECUTE_PRODUCT_SUSPECT_CLEARANCE_LUA, keys, [stageArg]);
      const execParsed = JSON.parse(String(execRaw)) as { code: string };
      if (execParsed.code !== 'ACCEPTED') return this.recoverClearance(recoveryId, true, tuple);

      return this.recoverClearance(recoveryId, false, tuple);
    } catch {
      return this.recoverClearance(recoveryId, false, tuple);
    }
  }

  async recoverClearance(
    recoveryId: string,
    preWriteAbortVerified = false,
    hintTuple?: FenceTuple,
  ): Promise<ClearanceExecuteResult> {
    if (!UUID_PATTERN.test(recoveryId)) {
      return { ok: false, code: 'INVALID_RECOVERY_ID', message: 'Invalid recoveryId' };
    }
    const initial = await this.fences.locked(async (tx) => {
      const recovery = await tx.productSuspectRecovery.findUnique({ where: { id: recoveryId } });
      if (!recovery) return null;
      const restriction = recovery.restrictionId
        ? await tx.productReservationRestriction.findUnique({ where: { id: recovery.restrictionId } })
        : null;
      return { recovery, restriction };
    });

    if (!initial) return { ok: false, code: 'RECOVERY_NOT_FOUND', message: 'Recovery record not found' };
    if (initial.recovery.status === 'COMPLETED') {
      return {
        ok: true, recoveryId: initial.recovery.id, status: 'COMPLETED', replayed: true,
        clearedControlRevision: initial.recovery.clearedControlRevision,
        targetReconciledTotal: initial.recovery.targetReconciledTotal,
        receiptHash: initial.recovery.redisReceiptHash ?? '',
        unblockedSyncCount: 0, unblockedCompCount: 0, skippedTargetCount: 0,
      };
    }
    if (initial.recovery.status !== 'EXECUTING') {
      return {
        ok: false, code: 'INVALID_STATE',
        message: `Recovery is in non-executable state ${initial.recovery.status}`,
        status: initial.recovery.status, recoveryId: initial.recovery.id,
      };
    }

    const obs = await observeClearanceRedisState(this.redis, initial.recovery);
    let abortedFence: FenceTuple | null = hintTuple ?? null;

    const result = await this.fences.locked(async (tx) => {
      const recovery = await tx.productSuspectRecovery.findUnique({ where: { id: recoveryId } });
      if (!recovery) return { ok: false as const, code: 'RECOVERY_NOT_FOUND', message: 'Recovery not found' };
      if (recovery.status === 'COMPLETED') {
        return {
          ok: true as const, recoveryId: recovery.id, status: 'COMPLETED' as const, replayed: true,
          clearedControlRevision: recovery.clearedControlRevision, targetReconciledTotal: recovery.targetReconciledTotal,
          receiptHash: recovery.redisReceiptHash ?? '', unblockedSyncCount: 0, unblockedCompCount: 0, skippedTargetCount: 0,
        };
      }
      if (recovery.status !== 'EXECUTING') {
        return {
          ok: false as const, code: 'INVALID_STATE',
          message: `State changed to ${recovery.status}`, status: recovery.status, recoveryId: recovery.id,
        };
      }
      const restriction = recovery.restrictionId
        ? await tx.productReservationRestriction.findUnique({ where: { id: recovery.restrictionId } })
        : null;
      if (!abortedFence) {
        const latestFence = await this.fences.latest(tx);
        if (latestFence) abortedFence = transitionTuple(latestFence);
      }
      const evaluation = evaluateObservedClearance(this.crashEvidence, recovery, restriction, obs, preWriteAbortVerified);
      return persistClearanceOutcomeTx({ tx, recovery, restriction, evaluation, rawReceipt: obs.rawReceipt, now: new Date() });
    });

    if (!result.ok && result.status === 'ABORTED') {
      await bestEffortUnstageAfterAbort(this.redis, initial.recovery, abortedFence);
    }
    return result;
  }

  async observeClearance(recoveryId: string): Promise<ClearanceObservationResult> {
    if (!UUID_PATTERN.test(recoveryId)) return { found: false, recoveryId };
    const record = await this.fences.locked(async (tx) => {
      const recovery = await tx.productSuspectRecovery.findUnique({ where: { id: recoveryId } });
      if (!recovery) return null;
      const restriction = recovery.restrictionId
        ? await tx.productReservationRestriction.findUnique({ where: { id: recovery.restrictionId } })
        : null;
      return { recovery, restriction };
    });

    if (!record) return { found: false, recoveryId };
    const { recovery, restriction } = record;
    const obs = await observeClearanceRedisState(this.redis, recovery);
    const evaluation =
      recovery.status === 'EXECUTING' || recovery.status === 'COMPLETED' || recovery.status === 'AMBIGUOUS_QUARANTINED'
        ? evaluateObservedClearance(this.crashEvidence, recovery, restriction, obs)
        : null;

    return {
      found: true, recoveryId: recovery.id, status: recovery.status,
      restrictionState: restriction?.state ?? null, targetRestrictionRevision: recovery.targetRestrictionRevision,
      clearedControlRevision: recovery.clearedControlRevision, redisControlRaw: obs.rawControl,
      redisReceiptRaw: obs.rawReceipt, redisSuspectPresent: obs.suspectPresent ?? undefined,
      redisStoredTotal: obs.storedTotal, crashEvaluation: evaluation, evidenceSummary: recovery.executionEvidence,
    };
  }
}
