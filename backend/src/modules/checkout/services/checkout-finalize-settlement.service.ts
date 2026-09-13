import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutSettlementRepository, SettlementManifest } from '../../reservation-fence/repositories/checkout-settlement.repository';
import { ReservationFenceRepository } from '../../reservation-fence/repositories/reservation-fence.repository';
import { CheckoutSettlementAuthorityService } from '../../reservation-fence/services/checkout-settlement-authority.service';
import { completionReceiptHash, readSettlementCompletion, SettlementCompletionEvidence, settlementOwnershipIdentity } from '../../reservation-fence/services/checkout-settlement-evidence';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { CHECKOUT_SETTLEMENT_FINALIZE_SCRIPT } from '../../inventory/lua/checkout-settlement-finalize-lua-scripts';

export type FinalizeSettlementResult = { code: 'SETTLED' | 'FINALIZE_REJECTED' | 'FINALIZE_UNCERTAIN' | 'ORDER_OUTCOME_UNRESOLVED' };
function accepted(raw: unknown): boolean {
  const r: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (r && typeof r === 'object' && 'code' in r) {
    if (r.code === 'FENCE_REJECTED') return false;
    if (r.code === 'ACCEPTED' && 'value' in r && (r.value === true ||
      (r.value && typeof r.value === 'object' && 'completed' in r.value && r.value.completed === true))) return true;
  }
  throw new Error('SETTLEMENT_RESPONSE_UNCERTAIN');
}

// Inactive dispatcher only. Continues a durable committed obligation; cannot
// create an order, choose terminal intent or convert a committed attempt to FAILED.
@Injectable()
export class CheckoutFinalizeSettlementService {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService,
    private readonly manifests: CheckoutSettlementRepository,
    private readonly fences: ReservationFenceRepository, private readonly authority: CheckoutSettlementAuthorityService) {}

  // Restart entry: reads only an already-authorized obligation; cannot prepare a
  // manifest, fail an attempt, select an action, or allocate a replay identity.
  async continue(customerId: string, operationId: string): Promise<FinalizeSettlementResult> {
    if (!customerId || !operationId) return { code: 'FINALIZE_REJECTED' };
    try {
      const row = await this.prisma.checkoutReservationSettlement.findFirst({ where: { operationId,
        operation: { customerId } }, select: { id: true } });
      const m = row ? await this.manifests.find(row.id) : null;
      if (!m || !this.valid(m) || m.operationId !== operationId || m.operation.customerId !== customerId ||
        m.attempt.status !== 'COMMITTED' || !m.attempt.orderId ||
        m.effect !== 'CHECKOUT_FINALIZE' || !m.settlementReplayId ||
        m.settlementReplayId === m.acquisitionReplayId || !['FINALIZE_PENDING', 'SETTLED'].includes(m.state))
        return { code: 'ORDER_OUTCOME_UNRESOLVED' };
      if (!await this.prisma.order.findFirst({ where: { id: m.attempt.orderId, customerId } }))
        return { code: 'ORDER_OUTCOME_UNRESOLVED' };
      // Observe before issuing/repeating any physical command, including restart
      // after a lost execution response. Missing evidence is not success.
      if (await this.acknowledge(m)) return { code: 'SETTLED' };
      if (m.state === 'SETTLED') return { code: 'FINALIZE_UNCERTAIN' };
      let grant: Awaited<ReturnType<CheckoutSettlementAuthorityService['register']>>;
      try { grant = await this.authority.register(m.id, 'CHECKOUT_FINALIZE'); }
      catch (error) {
        if (error instanceof Error && ['SETTLEMENT_AUTHORITY_DENIED', 'SETTLEMENT_PHASE_DENIED', 'SETTLEMENT_ORDER_MISMATCH'].includes(error.message))
          return { code: 'FINALIZE_REJECTED' };
        throw error;
      }
      if (!accepted(grant.result)) return { code: 'FINALIZE_REJECTED' };
      if (!accepted(await this.redis.eval(CHECKOUT_SETTLEMENT_FINALIZE_SCRIPT,
        [RESERVATION_FENCE_KEY, grant.key], []))) return { code: 'FINALIZE_REJECTED' };
      return { code: await this.acknowledge(m) ? 'SETTLED' : 'FINALIZE_UNCERTAIN' };
    } catch { return { code: 'FINALIZE_UNCERTAIN' }; }
  }

  private async acknowledge(m: SettlementManifest): Promise<boolean> {
    // Receipt absence/mismatch and transport loss both leave the obligation
    // pending. Any retry still has to pass the full physical fenced protocol.
    let evidence: SettlementCompletionEvidence;
    try { evidence = await readSettlementCompletion(this.redis, m); }
    catch { return false; }
    return this.fences.locked(async tx => {
      const current = await this.lockedManifest(tx, m);
      if (!current || current.attempt.status !== 'COMMITTED' || current.attempt.orderId !== m.attempt.orderId ||
        current.effect !== 'CHECKOUT_FINALIZE' || current.settlementReplayId !== m.settlementReplayId)
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
