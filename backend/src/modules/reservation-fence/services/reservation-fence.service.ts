import { Injectable } from '@nestjs/common';
import { Prisma, ReservationEngineMode, ReservationFenceTransition } from '@prisma/client';
import { randomUUID } from 'crypto';
import { RedisService } from '../../../common/redis/redis.service';
import { ReservationFenceRepository, transitionTuple } from '../repositories/reservation-fence.repository';
import { RESERVATION_FENCE_CONTROL_LUA, RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { accepted, FenceFailure, FencePhase, FenceResult, FenceTuple, FENCE_PROTOCOL,
  isFenceTuple, legalPair, MAX_FENCE_COUNTER, phaseTransition, sameTuple, UUID_PATTERN } from '../types/reservation-fence.types';

export interface InfrastructureAcknowledgement {
  // Opaque references to operator evidence, never URLs, credentials or payloads.
  evidenceId: string;
  actorId: string;
  endpointQuarantined: true;
  oldPrimaryFenced: true;
  controlledPromotion: true;
}

@Injectable()
export class ReservationFenceService {
  constructor(private readonly repository: ReservationFenceRepository, private readonly redis: RedisService) {}

  private async control(command: 'READ' | 'BOOTSTRAP' | 'CAS', target?: FenceTuple, expected?: FenceTuple): Promise<FenceResult<FenceTuple | undefined>> {
    const reply = await this.redis.eval(RESERVATION_FENCE_CONTROL_LUA, [RESERVATION_FENCE_KEY],
      [command, target ? JSON.stringify(target) : '', expected ? JSON.stringify(expected) : '']) as string[];
    if (reply[0] !== 'ACCEPTED') return { code: reply[0] as FenceFailure };
    return accepted(reply[1] ? JSON.parse(reply[1]) as FenceTuple : undefined);
  }

  // Explicit operator admission only. These acknowledgements cannot prove the
  // infrastructure actions happened; production activation must establish them.
  // A fresh incarnation is ALWAYS closed; no adoption of restored OPEN.
  async allocateIncarnation(ack: InfrastructureAcknowledgement): Promise<FenceResult<FenceTuple>> {
    if (!ack || !UUID_PATTERN.test(ack.evidenceId ?? '') || !UUID_PATTERN.test(ack.actorId ?? '') ||
        ack.endpointQuarantined !== true || ack.oldPrimaryFenced !== true || ack.controlledPromotion !== true)
      return { code: 'INFRASTRUCTURE_ACK_REQUIRED' };
    return this.repository.locked(async tx => {
      const previous = await this.repository.latest(tx);
      if (previous && (previous.revision >= MAX_FENCE_COUNTER || previous.epoch >= MAX_FENCE_COUNTER))
        return { code: 'COUNTER_EXHAUSTED' };
      const mode = await this.repository.mode(tx);
      const row = await this.repository.insert(tx, {
        id: randomUUID(), incarnation: randomUUID(), epoch: previous ? previous.epoch + (previous.phase === 'RETIRED' ? 1 : 0) : 1,
        revision: (previous?.revision ?? 0) + 1, phase: 'FROZEN', protocol: FENCE_PROTOCOL,
        predecessor: previous ? transitionTuple(previous) as unknown as Prisma.InputJsonValue : Prisma.DbNull,
        ...mode, bootstrap: true, endpointAcknowledgement: ack.evidenceId, actorId: ack.actorId, reason: 'BOOTSTRAP',
      });
      return accepted(transitionTuple(row));
    });
  }

  async prepare(expected: FenceTuple, phase: FencePhase, actorId: string,
    targetMode?: ReservationEngineMode): Promise<FenceResult<FenceTuple>> {
    if (!isFenceTuple(expected) || !UUID_PATTERN.test(actorId ?? '')) return { code: 'MALFORMED_CONTROL' };
    return this.repository.locked(async tx => {
      const row = await this.repository.latest(tx);
      if (!row || !sameTuple(transitionTuple(row), expected)) return { code: 'PREDECESSOR_MISMATCH' };
      if (row.status !== 'ACKNOWLEDGED') return { code: 'DURABLE_REDIS_DISAGREEMENT' };
      const mode = await this.repository.mode(tx);
      if (mode.mode !== row.mode || mode.modeRevision !== row.modeRevision) return { code: 'DURABLE_REDIS_DISAGREEMENT' };
      if (targetMode && targetMode !== row.mode) {
        return { code: row.mode === 'DRAINING' && targetMode === 'LEGACY'
          ? 'FUTURE_CERTIFICATE_REQUIRED' : 'MODE_BOUNDARY_REQUIRED' };
      }
      // LEGACY/FROZEN is also a bootstrap pair, not proof of a completed drain.
      // No runtime retirement can be authorized until G.4b.4 supplies evidence.
      if (phase === 'RETIRED') return { code: 'FUTURE_CERTIFICATE_REQUIRED' };
      if (!phaseTransition(row.phase, phase) || !legalPair(row.mode, phase, true)) return { code: 'ILLEGAL_PHASE_TRANSITION' };
      if (row.revision === MAX_FENCE_COUNTER) return { code: 'COUNTER_EXHAUSTED' };
      const observed = await this.control('READ');
      if (observed.code !== 'ACCEPTED') return observed;
      if (!observed.value || !sameTuple(observed.value, expected)) return { code: 'DURABLE_REDIS_DISAGREEMENT' };
      const next = await this.repository.insert(tx, {
        ...mode, id: randomUUID(), incarnation: row.incarnation, epoch: row.epoch, revision: row.revision + 1,
        phase, protocol: FENCE_PROTOCOL, predecessor: expected as unknown as Prisma.InputJsonValue,
        actorId, reason: phase === 'OPEN' ? 'OPEN' :
          row.phase === 'FROZEN' && phase === 'DRAINING' ? 'ABORT_FREEZE' : 'RESTRICT',
      });
      return accepted(transitionTuple(next));
    });
  }

  // PREPARED was committed in a separate transaction before any Redis write.
  // Crash after CAS is replayable; only the latest exact durable authorization
  // may be driven. Timeouts leave intent blocking issuance, never reopen it.
  async reconcile(): Promise<FenceResult<FenceTuple>> {
    return this.repository.locked(async tx => {
      const row = await this.repository.latest(tx);
      if (!row) return { code: 'MISSING_CONTROL' };
      const mode = await this.repository.mode(tx);
      if (mode.mode !== row.mode || mode.modeRevision !== row.modeRevision || !legalPair(row.mode, row.phase, true))
        return { code: 'DURABLE_REDIS_DISAGREEMENT' };
      const target = transitionTuple(row);
      if (row.status === 'ACKNOWLEDGED') {
        const observed = await this.control('READ');
        if (observed.code !== 'ACCEPTED') return observed;
        return observed.value && sameTuple(observed.value, target) ? accepted(target) : { code: 'DURABLE_REDIS_DISAGREEMENT' };
      }
      if (!row.bootstrap && !isFenceTuple(row.predecessor)) return { code: 'PREDECESSOR_MISMATCH' };
      const result = await this.control(row.bootstrap ? 'BOOTSTRAP' : 'CAS', target,
        row.bootstrap ? undefined : row.predecessor as unknown as FenceTuple);
      if (result.code !== 'ACCEPTED') return result;
      await this.repository.acknowledge(tx, row.id);
      return accepted(target);
    });
  }

  // An inactive permit check, not a Redis mutation authorization. G.4b.2 must
  // check the physical tuple atomically inside EVERY mutation script.
  async checkIssuance(tx: Prisma.TransactionClient): Promise<FenceResult<ReservationFenceTransition>> {
    const invalidation = await tx.ordinaryInvalidationHead.findUnique({ where: { scope: 'GLOBAL' } });
    if (invalidation && (!invalidation.ready || invalidation.pendingIntentId)) return { code: 'DURABLE_REDIS_DISAGREEMENT' };
    const row = await this.repository.latest(tx);
    const mode = await this.repository.mode(tx);
    if (!row || row.status !== 'ACKNOWLEDGED' || row.phase !== 'OPEN' || row.mode !== 'CART_SCOPED' ||
      row.mode !== mode.mode || row.modeRevision !== mode.modeRevision) return { code: 'DURABLE_REDIS_DISAGREEMENT' };
    const observed = await this.control('READ');
    if (observed.code !== 'ACCEPTED') return observed;
    return observed.value && sameTuple(observed.value, transitionTuple(row)) ? accepted(row) : { code: 'DURABLE_REDIS_DISAGREEMENT' };
  }
}
