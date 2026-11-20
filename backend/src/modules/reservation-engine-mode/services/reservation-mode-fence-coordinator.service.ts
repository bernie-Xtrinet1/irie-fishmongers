import { Injectable } from '@nestjs/common';
import { Prisma, ReservationEngineMode, ReservationEngineModeConfig, ReservationFenceTransition } from '@prisma/client';
import { randomUUID } from 'crypto';

import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { RESERVATION_FENCE_CONTROL_LUA, RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { ReservationFenceRepository, transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';
import {
  FENCE_PROTOCOL,
  FenceFailure,
  FenceTuple,
  MAX_FENCE_COUNTER,
  UUID_PATTERN,
  isFenceTuple,
  legalPair,
  sameTuple,
} from '../../reservation-fence/types/reservation-fence.types';
import { ReservationEngineModeConfigRepository } from '../repositories/reservation-engine-mode-config.repository';
import {
  CutoverAttestation,
  ReconcileModeFenceResult,
  SetReservationEngineModeInput,
  SetReservationEngineModeResult,
} from '../types/reservation-engine-mode.types';
import { VALID_COORDINATED_TRANSITIONS, nextCoordinatedFenceStep } from './reservation-mode-fence-steps.helper';

export const COORDINATED_TRANSITION_LOCK_KEY = 'reservation_engine_mode_transition';
export const COORDINATED_TX_TIMEOUT_MS = 5_000;

type ModeTransitionFailure = Extract<SetReservationEngineModeResult, { ok: false }>;
type PreparedStep = {
  row: ReservationFenceTransition;
  modeConfig: ReservationEngineModeConfig | null;
};

@Injectable()
export class ReservationModeFenceCoordinatorService {
  private readonly fences: ReservationFenceRepository;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    this.fences = new ReservationFenceRepository(prisma);
  }

  shouldCoordinate(
    prisma: PrismaService,
    repository: ReservationEngineModeConfigRepository,
    redis: RedisService,
  ): boolean {
    const prismaRecord = prisma as unknown as { reservationFenceTransition?: unknown };
    const redisRecord = redis as unknown as { eval?: unknown; getClient?: unknown };
    return (
      typeof prismaRecord?.reservationFenceTransition === 'object' &&
      prismaRecord.reservationFenceTransition !== null &&
      typeof redisRecord?.eval === 'function' &&
      typeof redisRecord?.getClient === 'function' &&
      repository instanceof ReservationEngineModeConfigRepository
    );
  }

  async lockCoordinated(tx: Prisma.TransactionClient): Promise<void> {
    // Global lock DAG: Level 1 (1380339280, 1) -> Level 2 TRANSITION_LOCK_KEY.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${COORDINATED_TRANSITION_LOCK_KEY})) FROM (SELECT pg_advisory_xact_lock(1380339280, 1)) AS _fence_lock`;
  }

  async checkConsistency(): Promise<boolean> {
    const status = await this.prisma.$transaction(async (tx) => {
      await this.lockCoordinated(tx);
      const current = await tx.reservationEngineModeConfig.findFirst({ orderBy: { revision: 'desc' } });
      const mode: ReservationEngineMode = current?.mode ?? 'LEGACY';
      const modeRevision = current?.revision ?? null;
      const latest = await this.fences.latest(tx);
      if (!latest) {
        if (mode !== 'LEGACY') return { ok: false as const };
        const read = await this.control('READ');
        const history = await this.historyExists();
        return { ok: read.code === 'MISSING_CONTROL' && !history };
      }
      if (
        latest.status !== 'ACKNOWLEDGED' ||
        latest.mode !== mode ||
        latest.modeRevision !== modeRevision ||
        !legalPair(mode, latest.phase, true)
      ) {
        return { ok: false as const };
      }
      if ((mode === 'CART_SCOPED' || mode === 'MIRROR') && latest.phase !== 'OPEN') {
        return { ok: false as const };
      }
      const observed = await this.control('READ');
      if (mode === 'LEGACY' && latest.phase === 'RETIRED' && observed.code === 'MISSING_CONTROL') {
        return { ok: !(await this.historyExists()) };
      }
      return { ok: observed.code === 'ACCEPTED' && !!observed.value && sameTuple(observed.value, transitionTuple(latest)) };
    }, { timeout: COORDINATED_TX_TIMEOUT_MS });
    return status.ok;
  }

  async reconcilePendingTransition(): Promise<ReconcileModeFenceResult> {
    const prepared = await this.prisma.$transaction(async (tx) => {
      await this.lockCoordinated(tx);
      const latest = await this.fences.latest(tx);
      const mode = await this.fences.mode(tx);
      if (!latest) {
        if (mode.mode !== 'LEGACY') {
          return { kind: 'FAIL' as const, reason: 'MISSING_CONTROL' };
        }
        const read = await this.control('READ');
        const history = await this.historyExists();
        if (read.code !== 'MISSING_CONTROL' || history) {
          return { kind: 'FAIL' as const, reason: 'DURABLE_REDIS_DISAGREEMENT' };
        }
        return { kind: 'NONE' as const, mode: mode.mode, modeRevision: mode.modeRevision };
      }
      if (latest.mode !== mode.mode || latest.modeRevision !== mode.modeRevision || !legalPair(latest.mode, latest.phase, true)) {
        return { kind: 'FAIL' as const, reason: 'DURABLE_REDIS_DISAGREEMENT' };
      }
      if (latest.status === 'ACKNOWLEDGED') {
        const observed = await this.control('READ');
        if (observed.code !== 'ACCEPTED' || !observed.value || !sameTuple(observed.value, transitionTuple(latest))) {
          return { kind: 'FAIL' as const, reason: observed.code === 'ACCEPTED' ? 'DURABLE_REDIS_DISAGREEMENT' : observed.code };
        }
        return { kind: 'ALREADY_ACK' as const, row: latest };
      }
      if (!latest.bootstrap && !isFenceTuple(latest.predecessor)) {
        return { kind: 'FAIL' as const, reason: 'PREDECESSOR_MISMATCH' };
      }
      return { kind: 'DRIVE_PREPARED' as const, row: latest };
    }, { timeout: COORDINATED_TX_TIMEOUT_MS });

    if (prepared.kind === 'FAIL') {
      return { ok: false, code: 'FENCE_DISAGREEMENT', reason: prepared.reason };
    }
    if (prepared.kind === 'NONE') {
      return { ok: true, mode: prepared.mode, modeRevision: prepared.modeRevision, phase: null, reconciled: false };
    }
    if (prepared.kind === 'ALREADY_ACK') {
      return { ok: true, mode: prepared.row.mode, modeRevision: prepared.row.modeRevision, phase: prepared.row.phase, reconciled: false };
    }

    const driven = await this.driveRedisAndAcknowledge(prepared.row);
    if (!driven.ok) return driven;
    return {
      ok: true,
      mode: prepared.row.mode,
      modeRevision: prepared.row.modeRevision,
      phase: prepared.row.phase,
      reconciled: true,
    };
  }

  async executeCoordinatedSetMode(
    input: SetReservationEngineModeInput,
    repository: ReservationEngineModeConfigRepository,
    verifyCutoverPreconditions: (
      tx: Prisma.TransactionClient,
      attestation: CutoverAttestation | undefined,
      postLockNow: number,
    ) => Promise<ModeTransitionFailure | null>,
    verifyRollbackSafe: () => Promise<{ clear: boolean; outstandingProductIds: string[]; structureDriftProductIds: string[] }>,
  ): Promise<SetReservationEngineModeResult> {
    const preReconciled = await this.ensurePreparedSettledForTarget(input.targetMode, repository);
    if (preReconciled) return preReconciled;

    const evidenceId = randomUUID();
    for (let stepIndex = 0; stepIndex < 2; stepIndex += 1) {
      const plan = await this.prepareNextStep(
        input,
        evidenceId,
        repository,
        verifyCutoverPreconditions,
        verifyRollbackSafe,
      );
      if (plan.kind === 'ERROR') {
        return plan.error;
      }

      const acked = await this.driveRedisAndAcknowledge(plan.step.row);
      if (!acked.ok) {
        return acked;
      }

      if (plan.step.modeConfig) {
        return {
          ok: true,
          id: plan.step.modeConfig.id,
          mode: plan.step.modeConfig.mode,
          createdAt: plan.step.modeConfig.createdAt,
        };
      }
    }

    return { ok: false, code: 'FENCE_DISAGREEMENT', reason: 'TRANSITION_STEP_LIMIT_EXCEEDED' };
  }

  private async ensurePreparedSettledForTarget(
    targetMode: ReservationEngineMode,
    repository: ReservationEngineModeConfigRepository,
  ): Promise<ModeTransitionFailure | null> {
    const inspect = await this.prisma.$transaction(async (tx) => {
      await this.lockCoordinated(tx);
      const current = await repository.findCurrent(tx);
      const currentMode: ReservationEngineMode = current?.mode ?? 'LEGACY';
      if (!VALID_COORDINATED_TRANSITIONS.has(`${currentMode}->${targetMode}`)) {
        return { action: 'RETURN' as const, error: { ok: false, code: 'INVALID_TRANSITION', from: currentMode, to: targetMode } as const };
      }
      const latest = await this.fences.latest(tx);
      if (!latest || latest.status !== 'PREPARED') {
        return { action: 'PROCEED' as const };
      }
      const currentRevision = current?.revision ?? null;
      if (latest.mode !== currentMode || latest.modeRevision !== currentRevision || !legalPair(latest.mode, latest.phase, true)) {
        return { action: 'RETURN' as const, error: { ok: false, code: 'FENCE_DISAGREEMENT', reason: 'DURABLE_REDIS_DISAGREEMENT' } as const };
      }
      return { action: 'RECONCILE' as const, row: latest };
    }, { timeout: COORDINATED_TX_TIMEOUT_MS });

    if (inspect.action === 'RETURN') return inspect.error;
    if (inspect.action === 'PROCEED') return null;
    const driven = await this.driveRedisAndAcknowledge(inspect.row);
    return driven.ok ? null : driven;
  }

  private async prepareNextStep(
    input: SetReservationEngineModeInput,
    evidenceId: string,
    repository: ReservationEngineModeConfigRepository,
    verifyCutoverPreconditions: (
      tx: Prisma.TransactionClient,
      attestation: CutoverAttestation | undefined,
      postLockNow: number,
    ) => Promise<ModeTransitionFailure | null>,
    verifyRollbackSafe: () => Promise<{ clear: boolean; outstandingProductIds: string[]; structureDriftProductIds: string[] }>,
  ): Promise<{ kind: 'ERROR'; error: ModeTransitionFailure } | { kind: 'STEP'; step: PreparedStep }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockCoordinated(tx);
      const postLockNow = Date.now();
      const current = await repository.findCurrent(tx);
      const currentMode: ReservationEngineMode = current?.mode ?? 'LEGACY';
      const currentRev = current?.revision ?? null;

      if (!VALID_COORDINATED_TRANSITIONS.has(`${currentMode}->${input.targetMode}`)) {
        return { kind: 'ERROR', error: { ok: false, code: 'INVALID_TRANSITION', from: currentMode, to: input.targetMode } };
      }
      if (!UUID_PATTERN.test(input.updatedById ?? '')) {
        return { kind: 'ERROR', error: { ok: false, code: 'FENCE_ACTOR_INVALID' } };
      }

      const latest = await this.fences.latest(tx);
      const agreementError = await this.verifyAgreementBeforePrepare(currentMode, currentRev, latest, input.targetMode);
      if (agreementError) {
        return { kind: 'ERROR', error: agreementError };
      }

      if (currentMode === 'DRAINING' && input.targetMode === 'LEGACY') {
        const verification = await verifyRollbackSafe();
        if (!verification.clear) {
          return {
            kind: 'ERROR',
            error:
              verification.structureDriftProductIds.length > 0
                ? { ok: false, code: 'ROLLBACK_STRUCTURE_DRIFT', structureDriftProductIds: verification.structureDriftProductIds }
                : { ok: false, code: 'ROLLBACK_BLOCKED', outstandingProductIds: verification.outstandingProductIds },
          };
        }
      }

      if (currentMode === 'MIRROR' && input.targetMode === 'CART_SCOPED') {
        const cutoverFailure = await verifyCutoverPreconditions(tx, input.cutoverAttestation, postLockNow);
        if (cutoverFailure) {
          return { kind: 'ERROR', error: cutoverFailure };
        }
      }

      if (latest && (latest.revision >= MAX_FENCE_COUNTER || latest.epoch >= MAX_FENCE_COUNTER)) {
        return { kind: 'ERROR', error: { ok: false, code: 'FENCE_DISAGREEMENT', reason: 'COUNTER_EXHAUSTED' } };
      }

      const spec = nextCoordinatedFenceStep(currentMode, input.targetMode, latest?.phase ?? null, evidenceId);
      let modeConfig: ReservationEngineModeConfig | null = null;
      if (spec.advanceMode) {
        modeConfig = await repository.create({ mode: spec.targetMode, updatedById: input.updatedById }, tx);
      }

      const row = await this.fences.insert(tx, {
        id: randomUUID(),
        incarnation: spec.bootstrap ? randomUUID() : latest!.incarnation,
        epoch: spec.bootstrap ? (latest ? latest.epoch + 1 : 1) : latest!.epoch,
        revision: (latest?.revision ?? 0) + 1,
        phase: spec.targetPhase,
        protocol: FENCE_PROTOCOL,
        predecessor: latest ? (transitionTuple(latest) as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        mode: spec.targetMode,
        modeRevision: spec.advanceMode ? modeConfig!.revision : currentRev,
        bootstrap: spec.bootstrap,
        endpointAcknowledgement: spec.evidenceId ?? undefined,
        actorId: input.updatedById,
        reason: spec.reason,
      });

      return { kind: 'STEP', step: { row, modeConfig } };
    }, { timeout: COORDINATED_TX_TIMEOUT_MS });
  }

  private async verifyAgreementBeforePrepare(
    currentMode: ReservationEngineMode,
    currentRev: number | null,
    latest: ReservationFenceTransition | null,
    targetMode: ReservationEngineMode,
  ): Promise<ModeTransitionFailure | null> {
    if (!latest) {
      if (currentMode !== 'LEGACY') {
        return { ok: false, code: 'FENCE_DISAGREEMENT', reason: 'MISSING_CONTROL' };
      }
      const read = await this.control('READ');
      const history = await this.historyExists();
      if (read.code !== 'MISSING_CONTROL' || history) {
        return { ok: false, code: 'FENCE_DISAGREEMENT', reason: 'DURABLE_REDIS_DISAGREEMENT' };
      }
      return null;
    }

    if (
      latest.status !== 'ACKNOWLEDGED' ||
      latest.mode !== currentMode ||
      latest.modeRevision !== currentRev ||
      !legalPair(currentMode, latest.phase, true)
    ) {
      return { ok: false, code: 'FENCE_DISAGREEMENT', reason: 'DURABLE_REDIS_DISAGREEMENT' };
    }

    if (latest.phase === 'RETIRED') {
      if (!(currentMode === 'LEGACY' && targetMode === 'MIRROR')) {
        return { ok: false, code: 'FENCE_DISAGREEMENT', reason: 'ILLEGAL_PHASE_TRANSITION' };
      }
      const read = await this.control('READ');
      const history = await this.historyExists();
      if (read.code !== 'MISSING_CONTROL' || history) {
        return { ok: false, code: 'FENCE_DISAGREEMENT', reason: 'DURABLE_REDIS_DISAGREEMENT' };
      }
      return null;
    }

    const observed = await this.control('READ');
    if (observed.code !== 'ACCEPTED' || !observed.value || !sameTuple(observed.value, transitionTuple(latest))) {
      return {
        ok: false,
        code: 'FENCE_DISAGREEMENT',
        reason: observed.code === 'ACCEPTED' ? 'DURABLE_REDIS_DISAGREEMENT' : observed.code,
      };
    }
    return null;
  }

  private async driveRedisAndAcknowledge(
    row: ReservationFenceTransition,
  ): Promise<{ ok: true } | { ok: false; code: 'FENCE_DISAGREEMENT'; reason: string }> {
    const target = transitionTuple(row);
    const predecessor = row.bootstrap ? undefined : (row.predecessor as unknown as FenceTuple);
    const result = await this.control(row.bootstrap ? 'BOOTSTRAP' : 'CAS', target, predecessor);
    if (result.code !== 'ACCEPTED') {
      return { ok: false, code: 'FENCE_DISAGREEMENT', reason: result.code };
    }
    await this.prisma.$transaction(async (tx) => {
      await this.lockCoordinated(tx);
      await tx.reservationFenceTransition.updateMany({
        where: { id: row.id, status: 'PREPARED' },
        data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date() },
      });
    }, { timeout: COORDINATED_TX_TIMEOUT_MS });
    return { ok: true };
  }

  private async control(
    command: 'READ' | 'BOOTSTRAP' | 'CAS',
    target?: FenceTuple,
    expected?: FenceTuple,
  ): Promise<{ code: 'ACCEPTED'; value?: FenceTuple } | { code: FenceFailure }> {
    const reply = (await this.redis.eval(RESERVATION_FENCE_CONTROL_LUA, [RESERVATION_FENCE_KEY], [
      command,
      target ? JSON.stringify(target) : '',
      expected ? JSON.stringify(expected) : '',
    ])) as string[];
    if (reply[0] !== 'ACCEPTED') {
      return { code: reply[0] as FenceFailure };
    }
    return { code: 'ACCEPTED', value: reply[1] ? (JSON.parse(reply[1]) as FenceTuple) : undefined };
  }

  private async historyExists(): Promise<boolean> {
    return (await this.redis.getClient().exists(MUTATION_HISTORY_KEY)) !== 0;
  }
}
