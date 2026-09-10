import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { RedisService } from '../../../common/redis/redis.service';
import { ReservationFenceRepository, transitionTuple } from '../repositories/reservation-fence.repository';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { RESERVATION_METADATA_LUA } from '../lua/reservation-metadata.lua';
import { REGISTER_MUTATION_PERMIT_LUA } from '../lua/reservation-mutation-guard.lua';
import { executionGateKey, MUTATION_HISTORY_KEY, mutationPermitKey, resourceGuardKey } from '../lua/reservation-mutation-common.lua';
import { FenceTuple, legalPair, UUID_PATTERN } from '../types/reservation-fence.types';
import { MutationEffect, MutationPermit, MutationResult, ResourceAuthority, MUTATION_EFFECTS,
  MAX_PERMIT_RESOURCES, MAX_PERMIT_TTL_MS, IssuerPurpose, MutationAuthorization,
  DRAINING_MUTATION_EFFECTS } from '../types/reservation-mutation.types';
import { decodeMutationResult } from './reservation-fenced-executor.service';

const deny = (reason: 'UNKNOWN_CAPABILITY' | 'DURABLE_REDIS_DISAGREEMENT' | 'PERMIT_SCOPE_MISMATCH' | 'EFFECT_MISMATCH' | 'PHASE_DENIED') =>
  ({ code: 'FENCE_REJECTED', reason }) as const;
const isTrue = (value: unknown): value is true => value === true;
const cartEffects: MutationEffect[] = ['RESERVE', 'RENEW', 'REDUCTION_RECREATE', 'RELEASE'];
const executionEffects: MutationEffect[] = ['CHECKOUT_MARK', 'CHECKOUT_LEASE_EXTEND'];
const settlementEffects: MutationEffect[] = ['CHECKOUT_REVERT_RESTORE_ACTIVE', 'CHECKOUT_REVERT_DELETE_ONLY', 'CHECKOUT_FINALIZE'];

@Injectable()
export class ReservationMutationAuthorityService {
  constructor(private readonly repository: ReservationFenceRepository, private readonly redis: RedisService) {}

  private async acknowledged(tx: Prisma.TransactionClient): Promise<FenceTuple | null> {
    const row = await this.repository.latest(tx);
    const mode = await this.repository.mode(tx);
    if (!row || row.status !== 'ACKNOWLEDGED' || row.mode !== mode.mode || row.modeRevision !== mode.modeRevision ||
      !legalPair(mode.mode, row.phase, true)) return null;
    return transitionTuple(row);
  }

  private async metadata(tuple: FenceTuple, action: string, key: string, record: object): Promise<MutationResult<true>> {
    try {
      return decodeMutationResult(await this.redis.eval(RESERVATION_METADATA_LUA,
        [RESERVATION_FENCE_KEY, MUTATION_HISTORY_KEY, key],
        [JSON.stringify(tuple), action, JSON.stringify(record)]), isTrue);
    } catch { return { code: 'INFRASTRUCTURE_FAILURE', outcome: 'UNCERTAIN' }; }
  }

  // Gate identity is fixed to the durable operation ID, not selected by callers.
  initializeExecutionGate(operationId: string, customerId: string): Promise<MutationResult<true>> {
    return this.repository.locked(async tx => {
      const tuple = await this.acknowledged(tx);
      if (!tuple) return deny('DURABLE_REDIS_DISAGREEMENT');
      if ((await this.repository.mode(tx)).mode !== 'CART_SCOPED') return deny('DURABLE_REDIS_DISAGREEMENT');
      const op = await tx.checkoutOperation.findFirst({ where: { id: operationId, customerId } });
      if (!op || op.selectedPath !== 'CART_SCOPED' || op.reservationCapabilityState !== 'ACTIVE' ||
        op.reservationExecutionEpoch !== tuple.epoch) return deny('UNKNOWN_CAPABILITY');
      return this.metadata(tuple, 'GATE_INIT', executionGateKey(op.id), {
        incarnation: tuple.incarnation, epoch: tuple.epoch, operationId: op.id, gateId: op.id, state: 'ENABLED',
      });
    });
  }

  // Internal lifecycle boundary: caller must hold the existing fence/operation
  // locks. Missing gate remains denied; this method never creates one.
  async restrictExecutionInTransaction(tx: Prisma.TransactionClient, operationId: string, customerId: string,
    state: 'CLOSED' | 'REVOKED'): Promise<MutationResult<true>> {
    const tuple = await this.acknowledged(tx);
    if (!tuple) return deny('DURABLE_REDIS_DISAGREEMENT');
    const op = await tx.checkoutOperation.findFirst({ where: { id: operationId, customerId } });
    if (!op || op.selectedPath !== 'CART_SCOPED' || op.reservationExecutionEpoch !== tuple.epoch)
      return deny('UNKNOWN_CAPABILITY');
    return this.metadata(tuple, state === 'CLOSED' ? 'GATE_CLOSE' : 'GATE_REVOKE', executionGateKey(op.id), {
      incarnation: tuple.incarnation, epoch: tuple.epoch, operationId: op.id, gateId: op.id, state,
    });
  }

  closeExecutionGate(operationId: string, customerId: string): Promise<MutationResult<true>> {
    return this.repository.locked(tx => this.restrictExecutionInTransaction(tx, operationId, customerId, 'CLOSED'));
  }

  initializeResource(markerId: string, customerId: string, generation: number, holdInstanceId: string,
    advance = false): Promise<MutationResult<ResourceAuthority>> {
    return this.repository.locked(async tx => {
      if (!UUID_PATTERN.test(holdInstanceId)) return deny('PERMIT_SCOPE_MISMATCH');
      const tuple = await this.acknowledged(tx);
      if (!tuple) return deny('DURABLE_REDIS_DISAGREEMENT');
      const marker = await tx.cartReservationSyncState.findFirst({ where: { id: markerId, generation } });
      const cart = marker && await tx.cart.findFirst({ where: { id: marker.cartId, customerId } });
      if (!marker || !cart) return deny('PERMIT_SCOPE_MISMATCH');
      const resource = { markerId, generation, customerId, cartId: marker.cartId, productId: marker.productId, holdInstanceId };
      const result = await this.metadata(tuple, advance ? 'RESOURCE_ADVANCE' : 'RESOURCE_INIT', resourceGuardKey(markerId),
        { incarnation: tuple.incarnation, epoch: tuple.epoch, resource });
      return result.code === 'ACCEPTED' ? { code: 'ACCEPTED', value: resource } : result;
    });
  }

  registerCart(authorization: MutationAuthorization, resources: ResourceAuthority[], replayId: string) {
    if (!cartEffects.includes(authorization.effect)) return Promise.resolve(deny('EFFECT_MISMATCH'));
    return this.register('CART_CONVERGENCE', authorization, resources, replayId);
  }
  registerCheckout(authorization: MutationAuthorization, resources: ResourceAuthority[], replayId: string,
    operationId: string, attemptId: string) {
    const { effect } = authorization;
    const purpose = executionEffects.includes(effect) ? 'CHECKOUT_EXECUTION' :
      settlementEffects.includes(effect) ? 'CHECKOUT_SETTLEMENT' : null;
    if (!purpose) return Promise.resolve(deny('EFFECT_MISMATCH'));
    return this.register(purpose, authorization, resources, replayId, { operationId, attemptId });
  }
  registerRepair(authorization: MutationAuthorization, resources: ResourceAuthority[], replayId: string) {
    // Other administrative effect predicates belong to caller integration.
    // Representing a class does not grant an unimplemented authority path.
    if (!['MALFORMED_SUSPECT', 'RECONCILE_NONINCREASING', 'RECONCILE_POSITIVE'].includes(authorization.effect))
      return Promise.resolve(deny('EFFECT_MISMATCH'));
    return this.register('RESOURCE_REPAIR', authorization, resources, replayId);
  }

  private register(purpose: IssuerPurpose, authorization: MutationAuthorization, resources: ResourceAuthority[], replayId: string,
    execution?: { operationId: string; attemptId: string }): Promise<MutationResult<MutationPermit>> {
    return this.repository.locked(async tx => {
      const { effect, authorizationPhase, constraint } = authorization;
      if (!UUID_PATTERN.test(replayId) || !MUTATION_EFFECTS.includes(effect) || !resources.length ||
        resources.length > MAX_PERMIT_RESOURCES) return deny('PERMIT_SCOPE_MISMATCH');
      const tuple = await this.acknowledged(tx);
      if (!tuple || tuple.phase !== authorizationPhase) return deny('DURABLE_REDIS_DISAGREEMENT');
      if (authorizationPhase !== 'OPEN' &&
        (authorizationPhase !== 'DRAINING' || !DRAINING_MUTATION_EFFECTS.includes(effect))) return deny('PHASE_DENIED');
      const normalized: ResourceAuthority[] = [];
      for (const r of resources) {
        if (![r.customerId, r.cartId, r.productId, r.markerId, r.holdInstanceId].every(id => UUID_PATTERN.test(id)) ||
          !Number.isInteger(r.generation) || r.generation < 0) return deny('PERMIT_SCOPE_MISMATCH');
        const marker = await tx.cartReservationSyncState.findFirst({ where: { id: r.markerId,
          cartId: r.cartId, productId: r.productId, generation: r.generation } });
        if (!marker || !await tx.cart.findFirst({ where: { id: r.cartId, customerId: r.customerId } }))
          return deny('PERMIT_SCOPE_MISMATCH');
        normalized.push({ customerId: r.customerId, cartId: r.cartId, productId: r.productId,
          markerId: r.markerId, generation: r.generation, holdInstanceId: r.holdInstanceId });
      }
      if (execution) {
        const mode = (await this.repository.mode(tx)).mode;
        if (mode !== 'CART_SCOPED' && !(mode === 'DRAINING' && authorizationPhase === 'DRAINING'))
          return deny('DURABLE_REDIS_DISAGREEMENT');
        const op = await tx.checkoutOperation.findUnique({ where: { id: execution.operationId } });
        const attempt = await tx.checkoutAttempt.findUnique({ where: { id: execution.attemptId } });
        if (!op || !attempt || op.selectedPath !== 'CART_SCOPED' || attempt.selectedPath !== 'CART_SCOPED' ||
          op.reservationExecutionEpoch !== tuple.epoch || attempt.reservationExecutionEpoch !== tuple.epoch ||
          attempt.idempotencyKey !== op.operationKey || attempt.customerId !== op.customerId || attempt.cartId !== op.cartId ||
          normalized.some(r => r.customerId !== op.customerId || r.cartId !== op.cartId)) return deny('UNKNOWN_CAPABILITY');
        if (purpose === 'CHECKOUT_EXECUTION' &&
          (op.reservationCapabilityState !== 'ACTIVE' || attempt.status !== 'PROCESSING')) return deny('UNKNOWN_CAPABILITY');
        if (purpose === 'CHECKOUT_SETTLEMENT' && (effect === 'CHECKOUT_FINALIZE'
          ? attempt.status !== 'COMMITTED' || !attempt.orderId : attempt.status !== 'FAILED')) return deny('UNKNOWN_CAPABILITY');
      }
      // Copy only contract fields. Lua strictly validates the discriminant and
      // constraint shape before registration; caller extras cannot add authority.
      const permit = { tuple, effect, authorizationPhase, constraint, purpose, resources: normalized,
        family: execution ? 'CHECKOUT_EXECUTION_OR_SETTLEMENT' : purpose === 'CART_CONVERGENCE' ? 'PRE_CHECKOUT_CART' : 'ADMIN_OR_RECOVERY',
        execution: execution ? { operationId: execution.operationId, attemptId: execution.attemptId, gateId: execution.operationId } : null,
        replayId, permitId: randomUUID(), expiresAt: 1 } as MutationPermit;
      try {
        return decodeMutationResult(await this.redis.eval(REGISTER_MUTATION_PERMIT_LUA,
          [RESERVATION_FENCE_KEY, mutationPermitKey(permit.permitId)], [JSON.stringify(permit), String(MAX_PERMIT_TTL_MS)]),
        (v): v is MutationPermit => !!v && typeof v === 'object' &&
          (v as MutationPermit).permitId === permit.permitId && Number.isFinite((v as MutationPermit).expiresAt));
      } catch { return { code: 'INFRASTRUCTURE_FAILURE', outcome: 'UNCERTAIN' }; }
    });
  }
}
