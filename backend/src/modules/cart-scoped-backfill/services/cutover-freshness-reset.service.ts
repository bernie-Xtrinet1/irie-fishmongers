import { Injectable, Logger } from '@nestjs/common';
import { CutoverFreshnessResetAudit } from '@prisma/client';

import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { ReservationFenceRepository } from '../../reservation-fence/repositories/reservation-fence.repository';
import { decodeMutationResult } from '../../reservation-fence/services/reservation-fenced-executor.service';
import { FenceTuple, UUID_PATTERN } from '../../reservation-fence/types/reservation-fence.types';
import { ResourceAuthority } from '../../reservation-fence/types/reservation-mutation.types';
import {
  EXECUTE_FRESHNESS_RESET_LUA,
  OBSERVE_FRESHNESS_RESET_LUA,
  REGISTER_FRESHNESS_RESET_LUA,
  freshnessPermitKey,
  freshnessReceiptKey,
} from '../lua/freshness-sweep-lua';
import {
  CutoverFreshnessResetAuditRepository,
  sha256Hex,
} from '../repositories/cutover-freshness-reset-audit.repository';
import {
  AuthorizedFreshnessResetInput,
  AuthorizedFreshnessResetResult,
} from '../types/cart-scoped-backfill.types';
import { PrepareTxResult, prepareAuthorizedFreshnessResetInTx } from './cutover-freshness-reset-prepare.helper';
import {
  classifyFreshnessFailureCode,
  freshnessFailure,
  parseVerifiedFreshnessReceipt,
  validateFreshnessResetInput,
} from './cutover-freshness-reset-validation.helper';

interface FreshnessPermitPayload {
  version: 1;
  effect: 'FRESHNESS_SWEEP';
  authorizationPhase: 'OPEN';
  tuple: FenceTuple;
  requestId: string;
  cutoverRunId: string;
  barrierRevision: number;
  target: ResourceAuthority;
  quantity: number;
  anchorNowMs: number;
  expiresAt: number;
  controlRevision?: number;
}

function isReceiptValue(v: unknown): v is { rawReceipt: string; replayed: boolean } {
  return !!v && typeof v === 'object' && typeof (v as { rawReceipt?: unknown }).rawReceipt === 'string';
}

function isObserveValue(v: unknown): v is { state: 'APPLIED' | 'NOT_APPLIED'; rawReceipt?: string } {
  if (!v || typeof v !== 'object') return false;
  const obj = v as { state?: unknown; rawReceipt?: unknown };
  return obj.state === 'NOT_APPLIED' || (obj.state === 'APPLIED' && typeof obj.rawReceipt === 'string');
}

@Injectable()
export class CutoverFreshnessResetService {
  private readonly logger = new Logger(CutoverFreshnessResetService.name);
  private readonly fences: ReservationFenceRepository;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly auditRepo: CutoverFreshnessResetAuditRepository,
  ) {
    this.fences = new ReservationFenceRepository(prisma);
  }

  async executeAuthorizedFreshnessReset(input: AuthorizedFreshnessResetInput): Promise<AuthorizedFreshnessResetResult> {
    const inputErr = validateFreshnessResetInput(input);
    if (inputErr) return inputErr;

    let prepared: PrepareTxResult;
    try {
      prepared = await this.fences.locked((tx) =>
        prepareAuthorizedFreshnessResetInTx(tx, { fences: this.fences, redis: this.redis, auditRepo: this.auditRepo }, input),
      );
    } catch (error) {
      return freshnessFailure('INFRA', 'PREPARE_TX_FAILED', error instanceof Error ? error.message : String(error));
    }

    if (prepared.action === 'REJECTED') {
      return freshnessFailure(prepared.category, prepared.code, prepared.detail, prepared.auditId ?? null, prepared.requestId ?? null);
    }
    if (prepared.action === 'REPLAY_COMPLETED') return this.verifiedCompletedResult(prepared.row, true);
    if (prepared.action === 'REPLAY_ABORTED') return this.abortedResult(prepared.row);
    if (prepared.action === 'RECOVER_PREPARED') return this.recoverPreparedRow(prepared.row, prepared.tuple);

    return this.executePreparedRow(prepared.row, prepared.tuple, prepared.controlRevision);
  }

  async recoverPreparedReset(auditIdOrRequestId: string): Promise<AuthorizedFreshnessResetResult> {
    if (!UUID_PATTERN.test(auditIdOrRequestId ?? '')) {
      return freshnessFailure('UNAUTHORIZED', 'INVALID_AUDIT_IDENTIFIER', 'Audit record id or requestId must be a valid UUID');
    }
    const existing =
      (await this.auditRepo.findById(auditIdOrRequestId)) ??
      (await this.auditRepo.findByRequestId(auditIdOrRequestId));
    if (!existing) {
      return freshnessFailure('UNAUTHORIZED', 'AUDIT_RECORD_NOT_FOUND', `No freshness audit record found for ${auditIdOrRequestId}`);
    }
    if (existing.status === 'COMPLETED') return this.verifiedCompletedResult(existing, true);
    if (existing.status === 'ABORTED') return this.abortedResult(existing);

    const rowTuple: FenceTuple = {
      incarnation: existing.incarnation,
      epoch: existing.fenceEpoch,
      revision: existing.fenceRevision,
      phase: 'OPEN',
      protocol: 1,
      transitionId: existing.fenceTransitionId,
    };
    return this.recoverPreparedRow(existing, rowTuple);
  }

  private buildPermit(row: CutoverFreshnessResetAudit, tuple: FenceTuple, controlRevision: number): FreshnessPermitPayload {
    return {
      version: 1,
      effect: 'FRESHNESS_SWEEP',
      authorizationPhase: 'OPEN',
      tuple,
      requestId: row.requestId,
      cutoverRunId: row.cutoverRunId,
      barrierRevision: row.barrierRevision,
      target: {
        customerId: row.customerId,
        cartId: row.cartId,
        productId: row.productId,
        markerId: row.markerId,
        generation: row.generation,
        holdInstanceId: row.holdInstanceId,
      },
      quantity: row.quantity,
      anchorNowMs: Number(row.anchorNowMs),
      expiresAt: 1,
      controlRevision,
    };
  }

  private async executePreparedRow(
    row: CutoverFreshnessResetAudit,
    tuple: FenceTuple,
    controlRevision: number,
  ): Promise<AuthorizedFreshnessResetResult> {
    const initialPermit = this.buildPermit(row, tuple, controlRevision);
    let registeredPermit: FreshnessPermitPayload;
    try {
      const regRaw = await this.redis.eval(
        REGISTER_FRESHNESS_RESET_LUA,
        [RESERVATION_FENCE_KEY, freshnessPermitKey(row.requestId)],
        [JSON.stringify(initialPermit)],
      );
      const reg = decodeMutationResult(regRaw, (v): v is FreshnessPermitPayload => !!v && typeof v === 'object' && 'requestId' in v);
      if (reg.code !== 'ACCEPTED') {
        const reason = reg.code === 'FENCE_REJECTED' ? reg.reason : reg.code === 'DOMAIN_FAILURE' ? reg.reason : 'REGISTER_PERMIT_FAILED';
        const { row: aborted } = await this.auditRepo.markAborted(row.id, reason, `Freshness permit registration rejected: ${reason}`);
        return this.abortedResult(aborted);
      }
      registeredPermit = reg.value;
    } catch {
      return this.recoverPreparedRow(row, tuple);
    }

    try {
      const execRaw = await this.redis.eval(
        EXECUTE_FRESHNESS_RESET_LUA,
        [RESERVATION_FENCE_KEY, freshnessPermitKey(row.requestId), freshnessReceiptKey(row.requestId)],
        [JSON.stringify(registeredPermit)],
      );
      const exec = decodeMutationResult(execRaw, isReceiptValue);
      if (exec.code === 'INFRASTRUCTURE_FAILURE') {
        return this.recoverPreparedRow(row, tuple);
      }
      if (exec.code !== 'ACCEPTED') {
        const reason = exec.code === 'FENCE_REJECTED' ? exec.reason : exec.code === 'DOMAIN_FAILURE' ? exec.reason : 'FRESHNESS_EXECUTION_FAILED';
        const { row: aborted } = await this.auditRepo.markAborted(row.id, reason, `Redis freshness execution rejected before write: ${reason}`);
        return this.abortedResult(aborted);
      }
      return await this.completeFromRawReceipt(row, exec.value.rawReceipt, exec.value.replayed);
    } catch {
      return this.recoverPreparedRow(row, tuple);
    }
  }

  private async recoverPreparedRow(row: CutoverFreshnessResetAudit, tuple: FenceTuple): Promise<AuthorizedFreshnessResetResult> {
    const observeArg = {
      version: 1,
      requestId: row.requestId,
      cutoverRunId: row.cutoverRunId,
      barrierRevision: row.barrierRevision,
      tuple,
      target: {
        customerId: row.customerId,
        cartId: row.cartId,
        productId: row.productId,
        markerId: row.markerId,
        generation: row.generation,
        holdInstanceId: row.holdInstanceId,
      },
      quantity: row.quantity,
      anchorNowMs: Number(row.anchorNowMs),
    };

    try {
      const raw = await this.redis.eval(
        OBSERVE_FRESHNESS_RESET_LUA,
        [RESERVATION_FENCE_KEY, freshnessReceiptKey(row.requestId)],
        [JSON.stringify(observeArg)],
      );
      const obs = decodeMutationResult(raw, isObserveValue);
      if (obs.code === 'ACCEPTED' && obs.value.state === 'APPLIED' && obs.value.rawReceipt) {
        return await this.completeFromRawReceipt(row, obs.value.rawReceipt, true);
      }
      if (obs.code === 'INFRASTRUCTURE_FAILURE') {
        this.logger.error('FRESHNESS_RECOVERY_ESCALATION_REQUIRED: Redis observation returned uncertain infrastructure', {
          auditId: row.id, requestId: row.requestId, cutoverRunId: row.cutoverRunId,
        });
        return freshnessFailure('ESCALATED', 'UNCERTAIN_EXECUTION_EVIDENCE', 'Uncertain Redis observation for PREPARED freshness record', row.id, row.requestId);
      }
      const code =
        obs.code === 'ACCEPTED' ? 'MISSING_EXECUTION_EVIDENCE' :
        obs.code === 'DOMAIN_FAILURE' ? obs.reason :
        obs.code === 'FENCE_REJECTED' ? obs.reason : 'AMBIGUOUS_EXECUTION_EVIDENCE';
      const escalationCode = code === 'MISSING_EXECUTION_EVIDENCE' ? 'MISSING_EXECUTION_EVIDENCE' : 'AMBIGUOUS_EXECUTION_EVIDENCE';
      this.logger.error('FRESHNESS_RECOVERY_ESCALATION_REQUIRED: fail-closed on interrupted PREPARED record', {
        auditId: row.id, requestId: row.requestId, cutoverRunId: row.cutoverRunId, observedCode: code,
      });
      const { row: aborted } = await this.auditRepo.markAborted(
        row.id,
        escalationCode,
        `Interrupted PREPARED record aborted without re-extension (${code})`,
      );
      if (aborted.status === 'COMPLETED') return this.verifiedCompletedResult(aborted, true);
      return this.abortedResult(aborted);
    } catch (error) {
      this.logger.error('FRESHNESS_RECOVERY_ESCALATION_REQUIRED: Redis unreachable during PREPARED recovery', {
        auditId: row.id, requestId: row.requestId, error: error instanceof Error ? error.message : String(error),
      });
      return freshnessFailure('ESCALATED', 'UNCERTAIN_EXECUTION_EVIDENCE', 'Redis observation failed for PREPARED freshness record', row.id, row.requestId);
    }
  }

  private async completeFromRawReceipt(
    row: CutoverFreshnessResetAudit,
    rawReceipt: string,
    replayed: boolean,
  ): Promise<AuthorizedFreshnessResetResult> {
    const receipt = parseVerifiedFreshnessReceipt(rawReceipt, row);
    if (!receipt) {
      const { row: aborted } = await this.auditRepo.markAborted(row.id, 'AMBIGUOUS_EXECUTION_EVIDENCE', 'Invalid Redis execution receipt payload');
      if (aborted.status === 'COMPLETED') return this.verifiedCompletedResult(aborted, true);
      return this.abortedResult(aborted);
    }
    try {
      const { row: saved } = await this.auditRepo.markCompleted(row.id, {
        priorCreatedAtMs: BigInt(receipt.priorCreatedAtMs),
        priorLastRenewedAtMs: receipt.priorLastRenewedAtMs !== null ? BigInt(receipt.priorLastRenewedAtMs) : null,
        priorExpiresAtMs: receipt.priorExpiresAtMs !== null ? BigInt(receipt.priorExpiresAtMs) : null,
        priorAbsoluteExpiresAtMs: BigInt(receipt.priorAbsoluteExpiresAtMs),
        newCreatedAtMs: BigInt(receipt.newCreatedAtMs),
        newLastRenewedAtMs: BigInt(receipt.newLastRenewedAtMs),
        newExpiresAtMs: BigInt(receipt.newExpiresAtMs),
        newAbsoluteExpiresAtMs: BigInt(receipt.newAbsoluteExpiresAtMs),
        redisReceipt: rawReceipt,
        redisReceiptHash: sha256Hex(rawReceipt),
      });
      if (saved.status !== 'COMPLETED') return this.abortedResult(saved);
      return this.verifiedCompletedResult(saved, replayed);
    } catch (error) {
      this.logger.error('FRESHNESS_AUDIT_COMPLETION_FAILED: Redis applied freshness reset but Postgres COMPLETED failed; PREPARED retained for recovery', {
        auditId: row.id, requestId: row.requestId, error: error instanceof Error ? error.message : String(error),
      });
      return freshnessFailure(
        'ESCALATED',
        'POST_REDIS_AUDIT_COMPLETION_FAILED',
        error instanceof Error ? error.message : String(error),
        row.id,
        row.requestId,
      );
    }
  }

  private verifiedCompletedResult(row: CutoverFreshnessResetAudit, replayed: boolean): AuthorizedFreshnessResetResult {
    if (!row.redisReceipt || !row.redisReceiptHash || sha256Hex(row.redisReceipt) !== row.redisReceiptHash ||
      row.newExpiresAtMs === null || row.newAbsoluteExpiresAtMs === null) {
      return freshnessFailure('ESCALATED', 'AUDIT_EVIDENCE_CORRUPTED', 'Stored COMPLETED audit receipt failed verification', row.id, row.requestId);
    }
    return {
      ok: true,
      status: 'COMPLETED',
      auditId: row.id,
      requestId: row.requestId,
      markerId: row.markerId,
      generation: row.generation,
      expiresAt: Number(row.newExpiresAtMs),
      absoluteExpiresAt: Number(row.newAbsoluteExpiresAtMs),
      replayed,
    };
  }

  private abortedResult(row: CutoverFreshnessResetAudit): AuthorizedFreshnessResetResult {
    const code = row.failureCode ?? 'ABORTED';
    return freshnessFailure(classifyFreshnessFailureCode(code), code, row.failureDetail ?? code, row.id, row.requestId);
  }
}
