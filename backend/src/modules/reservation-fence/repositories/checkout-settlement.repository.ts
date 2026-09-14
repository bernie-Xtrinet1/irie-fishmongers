import { Injectable } from '@nestjs/common';
import { CheckoutSettlementEffect, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../database/prisma.service';
import { ReservationFenceRepository, transitionTuple } from './reservation-fence.repository';
import { legalPair } from '../types/reservation-fence.types';
import { completionReceiptHash, SettlementCompletionEvidence } from '../services/checkout-settlement-evidence';
import { ordinaryHoldInstanceId } from '../ordinary-hold-instance-id';

const include = { resources: { orderBy: { markerId: 'asc' as const } }, operation: true, attempt: true };
export type SettlementManifest = Prisma.CheckoutReservationSettlementGetPayload<{ include: typeof include }>;

// Inactive: no coordinator, admission or worker imports this repository.
@Injectable()
export class CheckoutSettlementRepository {
  constructor(private readonly prisma: PrismaService, private readonly fences: ReservationFenceRepository) {}

  // Captures canonical identity from locked PostgreSQL intent, never Redis.
  // Physical W4 must prove the existing entry and guard match this manifest.
  prepare(operationId: string, attemptId: string, customerId: string) {
    return this.fences.locked(async tx => {
      await tx.$queryRaw`SELECT id FROM checkout_operations WHERE id = ${operationId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM checkout_attempts WHERE id = ${attemptId} FOR UPDATE`;
      const op = await tx.checkoutOperation.findUnique({ where: { id: operationId } });
      const a = await tx.checkoutAttempt.findUnique({ where: { id: attemptId } });
      const f = await this.fences.latest(tx);
      const mode = await this.fences.mode(tx);
      if (!op || !a || !f || f.status !== 'ACKNOWLEDGED' || f.phase !== 'OPEN' || mode.mode !== 'CART_SCOPED' ||
        f.mode !== mode.mode || f.modeRevision !== mode.modeRevision || op.customerId !== customerId ||
        op.selectedPath !== 'CART_SCOPED' || a.selectedPath !== 'CART_SCOPED' ||
        op.reservationCapabilityState !== 'ACTIVE' || a.status !== 'PROCESSING' ||
        op.reservationExecutionEpoch !== f.epoch || a.reservationExecutionEpoch !== f.epoch ||
        op.operationKey !== a.idempotencyKey || op.customerId !== a.customerId || op.cartId !== a.cartId)
        throw new Error('SETTLEMENT_AUTHORITY_DENIED');
      const existing = await tx.checkoutReservationSettlement.findUnique({ where: { attemptId }, include });
      if (existing) return existing; // Never recapture a newer generation on retry.
      const markers = await tx.$queryRaw<{ id: string; productId: string; generation: number; expectedQuantity: number }[]>`
        SELECT id, "productId", generation, "expectedQuantity" FROM cart_reservation_sync_states
        WHERE "cartId" = ${op.cartId} AND "expectedQuantity" > 0 ORDER BY id FOR UPDATE`;
      if (!markers.length || markers.length > 100) throw new Error('SETTLEMENT_RESOURCE_LIMIT');
      const row = await tx.checkoutReservationSettlement.create({ data: { operationId, attemptId,
        incarnation: f.incarnation, reservationExecutionEpoch: f.epoch, captureTransitionId: f.id,
        acquisitionReplayId: randomUUID(), resources: { create: markers.map(m => ({ markerId: m.id,
          productId: m.productId, generation: m.generation, quantity: m.expectedQuantity,
          holdInstanceId: ordinaryHoldInstanceId(m.id, m.generation) })) } } });
      return tx.checkoutReservationSettlement.update({ where: { id: row.id }, data: { sealed: true }, include });
    });
  }

  find(id: string, tx: Prisma.TransactionClient = this.prisma) {
    return tx.checkoutReservationSettlement.findUnique({ where: { id }, include });
  }

  markAcquired(tx: Prisma.TransactionClient, id: string) {
    return tx.checkoutReservationSettlement.updateMany({ where: { id, state: 'PREPARED', sealed: true },
      data: { state: 'ACQUIRED' } });
  }

  // Use the order/FAILED transaction. Action and its NEW replay ID are selected
  // together once; acquisition identity cannot authorize terminal settlement.
  markFinalizePending(tx: Prisma.TransactionClient, id: string) {
    return tx.checkoutReservationSettlement.updateMany({ where: { id, state: 'ACQUIRED', sealed: true, effect: null },
      data: { state: 'FINALIZE_PENDING', effect: 'CHECKOUT_FINALIZE', settlementReplayId: randomUUID() } });
  }

  markRevertPending(tx: Prisma.TransactionClient, id: string,
    effect: 'CHECKOUT_REVERT_DELETE_ONLY' | 'CHECKOUT_REVERT_RESTORE_ACTIVE') {
    if (!['CHECKOUT_REVERT_DELETE_ONLY', 'CHECKOUT_REVERT_RESTORE_ACTIVE'].includes(effect))
      throw new Error('SETTLEMENT_EFFECT_DENIED');
    return tx.checkoutReservationSettlement.updateMany({ where: { id, state: { in: ['PREPARED', 'ACQUIRED'] }, sealed: true, effect: null },
      data: { state: 'REVERT_PENDING', effect, settlementReplayId: randomUUID() } });
  }

  async acknowledgeSettled(tx: Prisma.TransactionClient, id: string, evidence: SettlementCompletionEvidence) {
    const m = await this.find(id, tx);
    if (!m) throw new Error('SETTLEMENT_AUTHORITY_DENIED');
    const hash = completionReceiptHash(evidence, m);
    return tx.checkoutReservationSettlement.updateMany({ where: { id, state: { in: ['FINALIZE_PENDING', 'REVERT_PENDING'] },
      effect: m.effect, settlementReplayId: m.settlementReplayId, sealed: true },
    data: { state: 'SETTLED', completionReceiptHash: hash } });
  }

  discover(state: 'PREPARED' | 'FINALIZE_PENDING' | 'REVERT_PENDING', limit: number, afterId?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('SETTLEMENT_DISCOVERY_LIMIT');
    return this.prisma.checkoutReservationSettlement.findMany({ where: { state, sealed: true,
      ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: 'asc' }, take: limit, select: { id: true } });
  }

  // Separate durable predicate. Ordinary ReservationMutationAuthorityService
  // current-generation checks remain untouched. No caller-supplied resources.
  async authority(tx: Prisma.TransactionClient, id: string, action: 'ACQUIRE' | CheckoutSettlementEffect) {
    const s = await this.find(id, tx);
    const f = await this.fences.latest(tx);
    const mode = await this.fences.mode(tx);
    if (!s || !s.sealed || !f || f.status !== 'ACKNOWLEDGED' || f.mode !== mode.mode ||
      f.modeRevision !== mode.modeRevision || !legalPair(mode.mode, f.phase, true) ||
      !['OPEN', 'DRAINING'].includes(f.phase) || !['CART_SCOPED', 'DRAINING'].includes(mode.mode) ||
      s.incarnation !== f.incarnation || s.reservationExecutionEpoch !== f.epoch)
      throw new Error('SETTLEMENT_AUTHORITY_DENIED');
    const { operation: op, attempt: a } = s;
    if (op.selectedPath !== 'CART_SCOPED' || a.selectedPath !== 'CART_SCOPED' ||
      op.reservationExecutionEpoch !== s.reservationExecutionEpoch || a.reservationExecutionEpoch !== s.reservationExecutionEpoch ||
      op.operationKey !== a.idempotencyKey || op.customerId !== a.customerId || op.cartId !== a.cartId)
      throw new Error('SETTLEMENT_AUTHORITY_DENIED');
    if (action === 'ACQUIRE') {
      if (s.state !== 'PREPARED' || f.phase !== 'OPEN' || a.status !== 'PROCESSING' || op.reservationCapabilityState !== 'ACTIVE')
        throw new Error('SETTLEMENT_AUTHORITY_DENIED');
    } else {
      if (s.effect !== action || (action === 'CHECKOUT_FINALIZE'
        ? s.state !== 'FINALIZE_PENDING' || a.status !== 'COMMITTED' || !a.orderId
        : s.state !== 'REVERT_PENDING' || a.status !== 'FAILED' || a.orderId !== null))
        throw new Error('SETTLEMENT_AUTHORITY_DENIED');
      if (action === 'CHECKOUT_FINALIZE') {
        const order = await tx.order.findFirst({ where: { id: a.orderId!, customerId: op.customerId },
          include: { vendorOrders: { include: { items: true } } } });
        const quantities = new Map<string, number>();
        for (const item of order?.vendorOrders.flatMap(v => v.items) ?? [])
          quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
        if (!order || quantities.size !== s.resources.length ||
          s.resources.some(r => quantities.get(r.productId) !== r.quantity)) throw new Error('SETTLEMENT_ORDER_MISMATCH');
      }
    }
    if (action === 'ACQUIRE' || action === 'CHECKOUT_REVERT_RESTORE_ACTIVE') {
      if (f.phase !== 'OPEN') throw new Error('SETTLEMENT_PHASE_DENIED');
      for (const r of s.resources) {
        if (!await tx.cartReservationSyncState.findFirst({ where: { id: r.markerId, cartId: op.cartId,
          productId: r.productId, generation: r.generation, expectedQuantity: r.quantity } }))
          throw new Error('SETTLEMENT_CURRENT_INTENT_MISMATCH');
      }
    }
    return { manifest: s, tuple: transitionTuple(f), action };
  }
}
