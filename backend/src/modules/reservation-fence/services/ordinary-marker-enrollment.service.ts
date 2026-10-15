import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { legalPair } from '../types/reservation-fence.types';
import { OrdinaryMarkerEnrollmentResult } from '../types/ordinary-marker-enrollment.types';

// Inactive dormant service: explicit transaction-local marker enrollment.
// Zero Redis operations; zero NestJS module registration.
export class OrdinaryMarkerEnrollmentService {
  private readonly fences: ReservationFenceRepository;

  constructor(private readonly prisma: PrismaService) {
    this.fences = new ReservationFenceRepository(prisma);
  }

  async enroll(markerId: string): Promise<OrdinaryMarkerEnrollmentResult> {
    return this.prisma.$transaction(async tx => {
      // 1. Advisory locks
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1380339280, 1)`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('reservation_engine_mode_transition'))`;
      return this.enrollInTransaction(tx, markerId);
    }, { timeout: 5000 });
  }

  async enrollInTransaction(tx: Prisma.TransactionClient, markerId: string): Promise<OrdinaryMarkerEnrollmentResult> {
    // 2. Marker existence and row locking
    const marker = await tx.cartReservationSyncState.findUnique({ where: { id: markerId } });
    if (!marker) return { status: 'REJECTED', reason: 'MARKER_NOT_FOUND' };

    const cart = await tx.cart.findUnique({ where: { id: marker.cartId } });
    if (!cart) return { status: 'REJECTED', reason: 'CART_NOT_FOUND' };

    // Hierarchical FOR UPDATE locking
    await tx.$queryRaw(Prisma.sql`SELECT id FROM carts WHERE id = ${marker.cartId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM cart_reservation_sync_states WHERE id = ${markerId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT scope FROM ordinary_invalidation_heads WHERE scope = 'GLOBAL' FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT scope FROM ordinary_invalidation_heads WHERE scope = ${'MARKER:' + markerId} FOR UPDATE`);

    // 3. Fence and mode verification
    const fence = await this.fences.latest(tx);
    const mode = await this.fences.mode(tx);
    if (!fence || fence.status !== 'ACKNOWLEDGED' || fence.phase !== 'OPEN' || fence.protocol !== 1
      || fence.mode !== mode.mode || fence.modeRevision !== mode.modeRevision
      || !legalPair(mode.mode, fence.phase, true)) {
      return { status: 'REJECTED', reason: 'FENCE_REJECTED' };
    }

    // 4. Global head prerequisites
    const global = await tx.ordinaryInvalidationHead.findUnique({ where: { scope: 'GLOBAL' } });
    if (!global) return { status: 'REJECTED', reason: 'GLOBAL_HEAD_MISSING' };
    if (global.pendingIntentId !== null) return { status: 'REJECTED', reason: 'GLOBAL_INVALIDATION_PENDING' };
    if (!global.ready) return { status: 'REJECTED', reason: 'GLOBAL_HEAD_NOT_READY' };
    if (global.incarnation !== fence.incarnation || global.epoch !== fence.epoch) {
      return { status: 'REJECTED', reason: 'GLOBAL_EPOCH_MISMATCH' };
    }

    // 5. Marker provenance verification
    if (!['NEW', 'TRACKED'].includes(marker.ordinaryProvenanceState)) {
      return { status: 'REJECTED', reason: 'INELIGIBLE_PROVENANCE' };
    }

    // 6. Existing marker head verification (idempotent find-or-create)
    const existing = await tx.ordinaryInvalidationHead.findUnique({ where: { scope: `MARKER:${markerId}` } });
    if (existing) {
      if (existing.incarnation === fence.incarnation && existing.epoch === fence.epoch) {
        return { status: 'ALREADY_ENROLLED', head: existing };
      }
      return { status: 'REJECTED', reason: 'STALE_MARKER_HEAD' };
    }

    // 7. Unresolved commands verification
    const unresolved = await tx.ordinaryReservationCommand.count({
      where: { markerId, state: { in: ['PENDING', 'WAITING', 'UNCERTAIN', 'REVOCATION_PENDING'] } },
    });
    if (unresolved > 0) return { status: 'REJECTED', reason: 'UNRESOLVED_COMMANDS_EXIST' };

    // 8. Invalidation history verification
    const history = await tx.ordinaryInvalidationScope.count({ where: { scope: `MARKER:${markerId}` } });
    if (history > 0) return { status: 'REJECTED', reason: 'INVALIDATION_HISTORY_EXISTS' };

    // 9. Insert new head with proven readiness
    const head = await tx.ordinaryInvalidationHead.create({
      data: {
        scope: `MARKER:${markerId}`,
        incarnation: fence.incarnation,
        epoch: fence.epoch,
        publishedRevision: 0,
        allocatedRevision: 0,
        ready: false,
        pendingIntentId: null,
      },
    });

    return { status: 'ENROLLED', head };
  }
}
