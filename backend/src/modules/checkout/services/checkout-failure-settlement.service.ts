import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { OrderWithDetails } from '../../orders/repositories/orders.repository';
import { CheckoutSettlementRepository, SettlementManifest } from '../../reservation-fence/repositories/checkout-settlement.repository';
import { ReservationFenceRepository } from '../../reservation-fence/repositories/reservation-fence.repository';
import { CheckoutSettlementAuthorityService } from '../../reservation-fence/services/checkout-settlement-authority.service';
import { completionReceiptHash, readSettlementCompletion, SettlementCompletionEvidence, settlementOwnershipIdentity } from '../../reservation-fence/services/checkout-settlement-evidence';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { CHECKOUT_SETTLEMENT_REVERT_SCRIPT } from '../../inventory/lua/checkout-settlement-revert-lua-scripts';
import { acquiredManifest, CheckoutAcquisitionEvidence } from './checkout-acquisition.service';

export type FailureSettlementResult = { code: 'SETTLED' | 'REVERT_REJECTED' | 'REVERT_UNCERTAIN' };
type OrderOutcome = { kind: 'CREATED'; order: OrderWithDetails } |
  { kind: 'COMMITTED'; attemptId: string; orderId: string } |
  { kind: 'UNRESOLVED' } | { kind: 'FAILED'; settlement: FailureSettlementResult };
const unresolved = { kind: 'UNRESOLVED' } as const;
function accepted(raw: unknown): boolean {
  const r: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (r && typeof r === 'object' && 'code' in r) {
    if (r.code === 'FENCE_REJECTED') return false;
    if (r.code === 'ACCEPTED' && 'value' in r && (r.value === true ||
      (r.value && typeof r.value === 'object' && 'completed' in r.value && r.value.completed === true))) return true;
  }
  throw new Error('SETTLEMENT_RESPONSE_UNCERTAIN');
}

// Inactive dispatcher only. No scheduler/legacy recovery ownership. The callback
// performs only the existing PostgreSQL order transaction, never external work.
@Injectable()
export class CheckoutFailureSettlementService {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService,
    private readonly attempts: CheckoutAttemptRepository, private readonly manifests: CheckoutSettlementRepository,
    private readonly fences: ReservationFenceRepository, private readonly authority: CheckoutSettlementAuthorityService) {}

  async runOrder(evidence: CheckoutAcquisitionEvidence,
    work: (tx: Prisma.TransactionClient) => Promise<OrderWithDetails>): Promise<OrderOutcome> {
    const original = acquiredManifest(evidence);
    let callbackAborted = false;
    try {
      const order = await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(1380339280, 1)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('reservation_engine_mode_transition'))`;
        const m = await this.lockedManifest(tx, original);
        const fence = await this.fences.latest(tx), mode = await this.fences.mode(tx);
        if (!m || m.state !== 'ACQUIRED' || m.settlementReplayId !== null || m.attempt.status !== 'PROCESSING' ||
          m.attempt.orderId !== null || m.operation.reservationCapabilityState !== 'ACTIVE' ||
          !fence || fence.status !== 'ACKNOWLEDGED' || fence.phase !== 'OPEN' || fence.mode !== 'CART_SCOPED' ||
          mode.mode !== 'CART_SCOPED' || fence.modeRevision !== mode.modeRevision ||
          fence.epoch !== m.reservationExecutionEpoch || fence.incarnation !== m.incarnation)
          throw new Error('ACQUISITION_ORDER_BOUNDARY_UNRESOLVED');
        try {
          const created = await work(tx);
          // The order, attempt and terminal obligation commit together. Failure
          // here is a callback rejection, so the existing W5 proof still applies.
          if ((await this.manifests.markFinalizePending(tx, m.id)).count !== 1)
            throw new Error('FINALIZE_INTENT_UNRESOLVED');
          return created;
        }
        catch (error) { callbackAborted = true; throw error; }
      });
      return { kind: 'CREATED', order };
    } catch {
      // Callback rejection means Prisma cannot submit COMMIT for this callback.
      // It is NOT sufficient alone: acquiring the same PG locks below must wait
      // for its transaction to finish, then re-read durable state. A rejection
      // after a fulfilled callback (including lost COMMIT response) is ambiguous.
      try {
        const outcome = await this.fences.locked(async tx => {
          const m = await this.lockedManifest(tx, original);
          if (!m) return unresolved;
          if (m.attempt.status === 'COMMITTED' || m.attempt.orderId !== null) {
            if (m.attempt.status !== 'COMMITTED' || !['FINALIZE_PENDING', 'SETTLED'].includes(m.state) ||
              m.effect !== 'CHECKOUT_FINALIZE' || !m.settlementReplayId || m.settlementReplayId === m.acquisitionReplayId ||
              !m.attempt.orderId || !await tx.order.findFirst({ where: {
              id: m.attempt.orderId, customerId: m.operation.customerId } })) return unresolved;
            return { kind: 'COMMITTED', attemptId: m.attemptId, orderId: m.attempt.orderId } as const;
          }
          if (m.attempt.status === 'FAILED' && m.effect === 'CHECKOUT_REVERT_DELETE_ONLY' &&
            ['REVERT_PENDING', 'SETTLED'].includes(m.state)) return { kind: 'PENDING' } as const;
          if (!callbackAborted || m.attempt.status !== 'PROCESSING' || m.state !== 'ACQUIRED' ||
            m.effect !== null || m.settlementReplayId !== null || m.operation.reservationCapabilityState !== 'ACTIVE')
            return unresolved;
          // Under the same locks used by every acquired order transaction, no
          // old transaction remains in flight and no later one can pass FAILED.
          if ((await this.attempts.markFailedInTransaction(tx, m.attemptId, m.operation.customerId,
            m.reservationExecutionEpoch, new Date())).count !== 1 ||
            (await this.manifests.markRevertPending(tx, m.id, 'CHECKOUT_REVERT_DELETE_ONLY')).count !== 1)
            throw new Error('FAILURE_INTENT_UNRESOLVED');
          return { kind: 'PENDING' } as const;
        });
        if (outcome.kind !== 'PENDING') return outcome;
        return { kind: 'FAILED', settlement: await this.continue(original.operation.customerId, original.operationId) };
      } catch { return unresolved; }
    }
  }

  // Restart entry: reads only an already-authorized obligation; cannot prepare a
  // manifest, fail an attempt, select an action, or allocate a replay identity.
  async continue(customerId: string, operationId: string): Promise<FailureSettlementResult> {
    if (!customerId || !operationId) return { code: 'REVERT_REJECTED' };
    try {
      const row = await this.prisma.checkoutReservationSettlement.findFirst({ where: { operationId,
        operation: { customerId } }, select: { id: true } });
      const m = row ? await this.manifests.find(row.id) : null;
      if (!m || !this.valid(m) || m.operationId !== operationId || m.operation.customerId !== customerId ||
        m.attempt.status !== 'FAILED' || m.attempt.orderId !== null ||
        m.attempt.failureCode !== 'ORDER_TRANSACTION_ROLLED_BACK' ||
        m.effect !== 'CHECKOUT_REVERT_DELETE_ONLY' || !m.settlementReplayId ||
        m.settlementReplayId === m.acquisitionReplayId || !['REVERT_PENDING', 'SETTLED'].includes(m.state))
        return { code: 'REVERT_REJECTED' };
      // Observe before issuing/repeating any physical command, including restart
      // after a lost execution response. Missing evidence is not success.
      if (await this.acknowledge(m)) return { code: 'SETTLED' };
      if (m.state === 'SETTLED') return { code: 'REVERT_UNCERTAIN' };
      let grant: Awaited<ReturnType<CheckoutSettlementAuthorityService['register']>>;
      try { grant = await this.authority.register(m.id, 'CHECKOUT_REVERT_DELETE_ONLY'); }
      catch (error) {
        if (error instanceof Error && ['SETTLEMENT_AUTHORITY_DENIED', 'SETTLEMENT_PHASE_DENIED'].includes(error.message))
          return { code: 'REVERT_REJECTED' };
        throw error;
      }
      if (!accepted(grant.result)) return { code: 'REVERT_REJECTED' };
      if (!accepted(await this.redis.eval(CHECKOUT_SETTLEMENT_REVERT_SCRIPT,
        [RESERVATION_FENCE_KEY, grant.key], []))) return { code: 'REVERT_REJECTED' };
      return { code: await this.acknowledge(m) ? 'SETTLED' : 'REVERT_UNCERTAIN' };
    } catch { return { code: 'REVERT_UNCERTAIN' }; }
  }

  private async acknowledge(m: SettlementManifest): Promise<boolean> {
    // Receipt absence/mismatch and transport loss both leave the obligation
    // pending. Any retry still has to pass the full physical fenced protocol.
    let evidence: SettlementCompletionEvidence;
    try { evidence = await readSettlementCompletion(this.redis, m); }
    catch { return false; }
    return this.fences.locked(async tx => {
      const current = await this.lockedManifest(tx, m);
      if (!current || current.attempt.status !== 'FAILED' || current.attempt.orderId !== null ||
        current.effect !== 'CHECKOUT_REVERT_DELETE_ONLY' || current.settlementReplayId !== m.settlementReplayId)
        return false;
      if (current.state === 'SETTLED') return current.completionReceiptHash === completionReceiptHash(evidence, current);
      return (await this.manifests.acknowledgeSettled(tx, current.id, evidence)).count === 1;
    });
  }

  private valid(m: SettlementManifest): boolean {
    return m.sealed && m.operation.selectedPath === 'CART_SCOPED' && m.attempt.selectedPath === 'CART_SCOPED' &&
      m.reservationExecutionEpoch > 0 && m.operation.reservationExecutionEpoch === m.reservationExecutionEpoch &&
      m.attempt.reservationExecutionEpoch === m.reservationExecutionEpoch && m.operationId === m.operation.id &&
      m.attemptId === m.attempt.id && m.operation.operationKey === m.attempt.idempotencyKey &&
      m.operation.customerId === m.attempt.customerId && m.operation.cartId === m.attempt.cartId;
  }

  private async lockedManifest(tx: Prisma.TransactionClient, original: SettlementManifest) {
    await tx.$queryRaw`SELECT id FROM checkout_operations WHERE id = ${original.operationId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM checkout_attempts WHERE id = ${original.attemptId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM checkout_reservation_settlements WHERE id = ${original.id}::uuid FOR UPDATE`;
    const m = await this.manifests.find(original.id, tx);
    return m && this.valid(m) && settlementOwnershipIdentity(m) === settlementOwnershipIdentity(original) ? m : null;
  }
}
