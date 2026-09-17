import { OrdinaryReservationOwner, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ordinaryHoldInstanceId } from '../ordinary-hold-instance-id';
import { OrdinaryMarkerTransaction, OrdinaryOwnerIssuance } from '../types/ordinary-reservation-provenance.types';

// Intentionally unwired. A row records issued provenance, not physical existence.
export class OrdinaryReservationOwnerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async locked<T>(markerId: string, work: (context: OrdinaryMarkerTransaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => work(await this.lockMarker(tx, markerId)), { timeout: 10000 });
  }

  async lockMarker(tx: Prisma.TransactionClient, markerId: string): Promise<OrdinaryMarkerTransaction> {
    await tx.$queryRaw`SELECT id FROM cart_reservation_sync_states WHERE id=${markerId} FOR UPDATE`;
    const marker = await tx.cartReservationSyncState.findUniqueOrThrow({ where: { id: markerId } });
    if (marker.ordinaryProvenanceState === 'HISTORICAL_UNVERIFIED') throw new Error('ORDINARY_HISTORICAL_UNVERIFIED');
    await tx.$queryRaw`SELECT id FROM ordinary_reservation_owners WHERE "markerId"=${markerId} ORDER BY generation,id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM ordinary_reservation_commands WHERE "markerId"=${markerId} ORDER BY "queueOrdinal",id FOR UPDATE`;
    return { tx, marker };
  }

  async create(context: OrdinaryMarkerTransaction, input: OrdinaryOwnerIssuance) {
    if (input.markerId !== context.marker.id) throw new Error('ORDINARY_MARKER_MISMATCH');
    // The marker is already locked. A deleting cart can hold the FK parent
    // while waiting for this marker. Never wait backward: acquire FK stability
    // NOWAIT or abort the entire issuance/allocation transaction unchanged.
    await context.tx.$queryRaw`SELECT id FROM carts WHERE id=${input.cartId} FOR KEY SHARE NOWAIT`;
    await context.tx.$queryRaw`SELECT id FROM reservation_fence_transitions WHERE id=${input.issuanceTransitionId}::uuid FOR KEY SHARE NOWAIT`;
    // The deferred DB guard requires a W1 command in this SAME transaction.
    return context.tx.ordinaryReservationOwner.create({ data: {
      ...input, holdInstanceId: ordinaryHoldInstanceId(input.markerId, input.generation),
    } });
  }

  async loadAuthority(id: string, tx: Prisma.TransactionClient = this.prisma): Promise<OrdinaryReservationOwner> {
    const row = await tx.ordinaryReservationOwner.findUniqueOrThrow({ where: { id } });
    if (row.holdInstanceId !== ordinaryHoldInstanceId(row.markerId, row.generation)) throw new Error('ORDINARY_NONCANONICAL_OWNER');
    const marker = await tx.cartReservationSyncState.findUniqueOrThrow({ where: { id: row.markerId } });
    if (marker.ordinaryProvenanceState === 'HISTORICAL_UNVERIFIED') throw new Error('ORDINARY_HISTORICAL_UNVERIFIED');
    return row;
  }

  async issuedCandidates(markerId: string) {
    const rows = await this.prisma.ordinaryReservationOwner.findMany({ where: { markerId }, orderBy: [{ generation: 'asc' }, { id: 'asc' }] });
    return Promise.all(rows.map(row => this.loadAuthority(row.id)));
  }

  // Metadata only: no acquisition is executed here. Manifest parent is locked
  // before marker/owners/commands; FK checks cannot reverse that order.
  async markTransferPending(markerId: string, ownerId: string, checkoutManifestId: string) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM checkout_reservation_settlements WHERE id=${checkoutManifestId}::uuid FOR UPDATE`;
      await this.lockMarker(tx, markerId);
      const owner = await this.loadAuthority(ownerId, tx);
      if (owner.markerId !== markerId || owner.state !== 'ACTIVE') throw new Error('ORDINARY_TRANSFER_REJECTED');
      return tx.ordinaryReservationOwner.update({ where: { id: ownerId }, data: { state: 'TRANSFER_PENDING', checkoutManifestId } });
    });
  }

  async markTransferred(markerId: string, ownerId: string) {
    return this.locked(markerId, async ({ tx }) => {
      const owner = await this.loadAuthority(ownerId, tx);
      if (owner.markerId !== markerId || owner.state !== 'TRANSFER_PENDING') throw new Error('ORDINARY_TRANSFER_REJECTED');
      // Deferred DB checks require the exact sealed, acquired manifest.
      return tx.ordinaryReservationOwner.update({ where: { id: ownerId }, data: { state: 'TRANSFERRED' } });
    });
  }

  async revokeNeverExecuted(markerId: string, ownerId: string) {
    return this.locked(markerId, async ({ tx }) => {
      const owner = await this.loadAuthority(ownerId, tx);
      if (owner.markerId !== markerId || owner.state !== 'ISSUED') throw new Error('ORDINARY_REVOCATION_REJECTED');
      const commands = await tx.ordinaryReservationCommand.findMany({ where: { ownerId, effect: 'W1' } });
      if (!commands.length || commands.some(c => !['WAITING', 'REVOKED', 'CANCELLED'].includes(c.state))) throw new Error('ORDINARY_UNRESOLVED_EXECUTION');
      await tx.ordinaryReservationCommand.updateMany({ where: { ownerId, effect: 'W1', state: 'WAITING' }, data: { state: 'REVOKED' } });
      return tx.ordinaryReservationOwner.update({ where: { id: ownerId }, data: { state: 'REVOKED', closedAt: new Date() } });
    });
  }
}
