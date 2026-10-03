import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { CheckoutSettlementRepository, SettlementManifest } from '../../reservation-fence/repositories/checkout-settlement.repository';
import { ReservationFenceRepository, transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';
import { ordinaryHoldInstanceId } from '../../reservation-fence/ordinary-hold-instance-id';
import { legalPair, MAX_FENCE_COUNTER, UUID_PATTERN } from '../../reservation-fence/types/reservation-fence.types';
import { completionReceiptHash, SettlementCompletionEvidence, settlementOwnershipIdentity } from '../../reservation-fence/services/checkout-settlement-evidence';
import { CheckoutRecoveryAcquisitionEvidenceService } from '../services/checkout-recovery-acquisition-evidence.service';
import { StaleSettlementAuthorization, StaleSettlementCandidate } from '../types/checkout-recovery-settlement.types';

@Injectable()
export class CheckoutRecoverySettlementRepository {
  constructor(private readonly prisma: PrismaService, private readonly fences: ReservationFenceRepository,
    private readonly manifests: CheckoutSettlementRepository,
    private readonly acquisition: CheckoutRecoveryAcquisitionEvidenceService) {}

  async authorizeStaleRecoverySettlement(input: StaleSettlementCandidate): Promise<StaleSettlementAuthorization> {
    const dates = [input.observedHeartbeatAt, input.staleBefore, input.observedAt];
    if (!input.attemptId || !input.customerId || dates.some(d => !(d instanceof Date) || !Number.isFinite(d.getTime()))
      || input.observedHeartbeatAt >= input.staleBefore || input.staleBefore > input.observedAt) return { code: 'DEFERRED' };
    const candidate = { ...input, observedHeartbeatAt: new Date(input.observedHeartbeatAt),
      staleBefore: new Date(input.staleBefore), observedAt: new Date(input.observedAt) };
    try {
      return await this.fences.locked(async tx => {
        const reference = await tx.checkoutReservationSettlement.findUnique({ where: { attemptId: candidate.attemptId }, select: { id: true } });
        if (!reference) return { code: 'DEFERRED' };
        const m = await this.lockedManifest(tx, reference.id);
        if (!m || !await this.valid(tx, m) || m.operation.customerId !== candidate.customerId) return { code: 'DEFERRED' };
        if (m.attempt.status === 'COMMITTED' || m.attempt.orderId !== null || m.effect === 'CHECKOUT_FINALIZE')
          return { code: 'FINALIZATION_REQUIRED' };
        if (this.staleObligation(m)) return { code: 'AUTHORIZED', manifestId: m.id };
        const fence = await this.fences.latest(tx), mode = await this.fences.mode(tx);
        if (!fence || fence.status !== 'ACKNOWLEDGED' || fence.protocol !== 1
          || !['OPEN', 'DRAINING'].includes(fence.phase) || !['CART_SCOPED', 'DRAINING'].includes(mode.mode)
          || fence.mode !== mode.mode || fence.modeRevision !== mode.modeRevision || !legalPair(mode.mode, fence.phase, true)
          || fence.epoch !== m.reservationExecutionEpoch || fence.incarnation !== m.incarnation
          || m.attempt.status !== 'PROCESSING' || m.attempt.lastHeartbeatAt.getTime() !== candidate.observedHeartbeatAt.getTime()
          || m.attempt.lastHeartbeatAt >= candidate.staleBefore || m.effect !== null || m.settlementReplayId !== null
          || m.completionReceiptHash !== null || !['PREPARED', 'ACQUIRED'].includes(m.state)) return { code: 'DEFERRED' };
        if (m.state === 'PREPARED' && !await this.acquisition.provePreparedAcquired(m, transitionTuple(fence)))
          return { code: 'DEFERRED' };
        const failed = await tx.checkoutAttempt.updateMany({ where: { id: m.attemptId, customerId: candidate.customerId,
          status: 'PROCESSING', orderId: null, selectedPath: 'CART_SCOPED', reservationExecutionEpoch: m.reservationExecutionEpoch,
          lastHeartbeatAt: { equals: candidate.observedHeartbeatAt, lt: candidate.staleBefore } },
        data: { status: 'FAILED', failureCode: 'STALE_RECOVERY_FENCED', failureMessage: null, updatedAt: candidate.observedAt } });
        if (failed.count !== 1 || (await this.manifests.markRevertPending(tx, m.id, 'CHECKOUT_REVERT_DELETE_ONLY')).count !== 1)
          throw new Error('STALE_SETTLEMENT_TRANSITION_LOST');
        return { code: 'AUTHORIZED', manifestId: m.id };
      });
    } catch { return { code: 'UNRESOLVED' }; }
  }

  async findPendingStaleSettlementsPage(input: { afterManifestId: string | null; limit: number }): Promise<{ id: string }[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
      || (input.afterManifestId !== null && !UUID_PATTERN.test(input.afterManifestId))) throw new Error('INVALID_STALE_SETTLEMENT_PAGE');
    return this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT s.id FROM checkout_reservation_settlements s
      JOIN checkout_attempts a ON a.id=s."attemptId"
      JOIN checkout_operations o ON o.id=s."operationId"
      JOIN reservation_fence_transitions f ON f.id=s."captureTransitionId"
      WHERE s.sealed AND s.state='REVERT_PENDING' AND s.effect='CHECKOUT_REVERT_DELETE_ONLY'
        AND s."settlementReplayId" IS NOT NULL AND s."settlementReplayId"<>s."acquisitionReplayId"
        AND s."completionReceiptHash" IS NULL AND a.status='FAILED' AND a."failureCode"='STALE_RECOVERY_FENCED'
        AND a."orderId" IS NULL AND a."selectedPath"='CART_SCOPED' AND o."selectedPath"='CART_SCOPED'
        AND a."customerId"=o."customerId" AND a."cartId"=o."cartId" AND a."idempotencyKey"=o."operationKey"
        AND s."reservationExecutionEpoch">0 AND a."reservationExecutionEpoch"=s."reservationExecutionEpoch"
        AND o."reservationExecutionEpoch"=s."reservationExecutionEpoch"
        AND f.incarnation=s.incarnation AND f.epoch=s."reservationExecutionEpoch"
        AND f.status='ACKNOWLEDGED' AND f.phase='OPEN' AND f.protocol=1
        ${input.afterManifestId === null ? Prisma.empty : Prisma.sql`AND s.id>${input.afterManifestId}::uuid`}
      ORDER BY s.id LIMIT ${input.limit}`);
  }

  loadObligation(id: string): Promise<SettlementManifest | null> {
    if (!UUID_PATTERN.test(id)) return Promise.resolve(null);
    return this.fences.locked(async tx => {
      const m = await this.lockedManifest(tx, id);
      return m && await this.valid(tx, m) && this.staleObligation(m) ? m : null;
    });
  }

  acknowledge(original: SettlementManifest, evidence: SettlementCompletionEvidence): Promise<boolean> {
    return this.fences.locked(async tx => {
      const m = await this.lockedManifest(tx, original.id);
      if (!m || !await this.valid(tx, m) || !this.staleObligation(m)
        || settlementOwnershipIdentity(m) !== settlementOwnershipIdentity(original)
        || m.settlementReplayId !== original.settlementReplayId) return false;
      if (m.state === 'SETTLED') return m.completionReceiptHash === completionReceiptHash(evidence, m);
      return (await this.manifests.acknowledgeSettled(tx, m.id, evidence)).count === 1;
    });
  }

  private staleObligation(m: SettlementManifest): boolean {
    return m.attempt.status === 'FAILED' && m.attempt.failureCode === 'STALE_RECOVERY_FENCED' && m.attempt.orderId === null
      && m.effect === 'CHECKOUT_REVERT_DELETE_ONLY' && m.settlementReplayId !== null
      && m.settlementReplayId !== m.acquisitionReplayId
      && ((m.state === 'REVERT_PENDING' && m.completionReceiptHash === null)
        || (m.state === 'SETTLED' && m.completionReceiptHash !== null));
  }

  private async lockedManifest(tx: Prisma.TransactionClient, id: string) {
    const reference = await tx.checkoutReservationSettlement.findUnique({ where: { id }, select: { operationId: true, attemptId: true } });
    if (!reference) return null;
    await tx.$queryRaw`SELECT id FROM checkout_operations WHERE id=${reference.operationId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM checkout_attempts WHERE id=${reference.attemptId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM checkout_reservation_settlements WHERE id=${id}::uuid FOR UPDATE`;
    return this.manifests.find(id, tx);
  }

  private async valid(tx: Prisma.TransactionClient, m: SettlementManifest): Promise<boolean> {
    const op = m.operation, a = m.attempt;
    if (!m.sealed || op.selectedPath !== 'CART_SCOPED' || a.selectedPath !== 'CART_SCOPED'
      || m.operationId !== op.id || m.attemptId !== a.id || op.customerId !== a.customerId || op.cartId !== a.cartId
      || op.operationKey !== a.idempotencyKey || !Number.isInteger(m.reservationExecutionEpoch) || m.reservationExecutionEpoch < 1
      || op.reservationExecutionEpoch !== m.reservationExecutionEpoch || a.reservationExecutionEpoch !== m.reservationExecutionEpoch
      || !m.resources.length || m.resources.length > 100 || new Set(m.resources.map(r => r.markerId)).size !== m.resources.length
      || new Set(m.resources.map(r => r.productId)).size !== m.resources.length) return false;
    if (m.resources.some(r => r.settlementId !== m.id || !Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > MAX_FENCE_COUNTER
      || !Number.isInteger(r.generation) || r.generation < 0 || r.generation > MAX_FENCE_COUNTER
      || !UUID_PATTERN.test(r.markerId) || r.holdInstanceId !== ordinaryHoldInstanceId(r.markerId, r.generation))) return false;
    const capture = await tx.reservationFenceTransition.findUnique({ where: { id: m.captureTransitionId } });
    return !!capture && capture.status === 'ACKNOWLEDGED' && capture.phase === 'OPEN' && capture.protocol === 1
      && capture.incarnation === m.incarnation && capture.epoch === m.reservationExecutionEpoch;
  }
}
