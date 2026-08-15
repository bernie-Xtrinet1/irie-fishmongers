import { Injectable, Logger } from '@nestjs/common';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { CartReservationSyncStateRepository } from '../repositories/cart-reservation-sync-state.repository';
import { ReconcileOneOutcome } from '../types/cart-reservation-sync-recovery.types';

export const BLOCKED_RECHECK_INTERVAL_MS = 60_000;

// Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen plan). The
// BLOCKED-precondition recheck - a distinct entry point from
// CartReservationSyncRecoveryService.reconcileOne, split into its own
// service both to respect the 400-line file cap and to mirror
// CompensationReconciliationService/CompensationBlockedRecheckService's own
// established precedent (see the C4-boundary comment on
// CartReservationSyncRecoveryService for why the two recovery domains are
// NOT unified despite the structural similarity). claimForRecovery never
// matches a BLOCKED row, so there is no "claim" step here - a recheck
// consumes zero recovery attempts (attemptCount is untouched by every
// method this service calls).
//
// A BLOCKED row is not a queued command: desired state is always re-read
// fresh from the current CartItem first, never replayed from the reason
// that originally caused the block. A release-shaped desired state (no
// CartItem) is never blocked by either cause and unblocks immediately.
@Injectable()
export class CartReservationSyncBlockedRecheckService {
  private readonly logger = new Logger(CartReservationSyncBlockedRecheckService.name);

  constructor(
    private readonly syncState: CartReservationSyncStateRepository,
    private readonly cartRepository: CartRepository,
    private readonly inventoryReservations: InventoryReservationsService,
    private readonly modeService: ReservationEngineModeService,
  ) {}

  async recheckBlocked(markerId: string, now: Date): Promise<ReconcileOneOutcome> {
    const row = await this.syncState.findById(markerId);
    if (!row) {
      return { outcome: 'NOT_FOUND', markerId };
    }
    if (row.resolvedAt !== null) {
      return { outcome: 'ALREADY_RESOLVED', markerId };
    }
    if (row.status !== 'BLOCKED') {
      return { outcome: 'NOT_DUE', markerId };
    }

    // Captured before any I/O - a slow check (a Redis round trip, or
    // getCurrentMode) must judge itself against the generation it started
    // with, never one read later.
    const observedGeneration = row.generation;

    const item = await this.cartRepository.findItemByCartAndProduct(row.cartId, row.productId);
    const desiredQuantity = item?.quantity ?? null;

    if (desiredQuantity === null) {
      return this.unblock(markerId, observedGeneration);
    }

    if (row.blockReason === 'MODE_NOT_ADMITTING') {
      const mode = await this.modeService.getCurrentMode();
      if (mode === 'DRAINING') {
        return this.rescheduleBlocked(markerId, observedGeneration, now, 'BLOCKED_MODE_NOT_ADMITTING');
      }
      return this.unblock(markerId, observedGeneration);
    }

    if (row.blockReason === 'PRODUCT_SUSPECT') {
      const reconciliation = await this.inventoryReservations.reconcileProductReservedTotal(row.productId);
      if (reconciliation.admissionSuspended) {
        return this.rescheduleBlocked(markerId, observedGeneration, now, 'BLOCKED_PRODUCT_SUSPECT');
      }
      return this.unblock(markerId, observedGeneration);
    }

    // Structurally unreachable - blockIfGenerationMatches always sets
    // blockReason in the same write that sets status to BLOCKED.
    throw new Error(`Invariant violation: BLOCKED marker ${markerId} has no recognized blockReason`);
  }

  private async unblock(markerId: string, observedGeneration: number): Promise<ReconcileOneOutcome> {
    const { count } = await this.syncState.unblockIfGenerationMatches(markerId, observedGeneration);
    if (count === 0) {
      return { outcome: 'STALE_BLOCKED_CHECK', markerId };
    }
    this.logger.log('Blocked recovery marker unblocked', { markerId });
    return { outcome: 'UNBLOCKED_PENDING', markerId };
  }

  private async rescheduleBlocked(
    markerId: string,
    observedGeneration: number,
    now: Date,
    outcome: 'BLOCKED_PRODUCT_SUSPECT' | 'BLOCKED_MODE_NOT_ADMITTING',
  ): Promise<ReconcileOneOutcome> {
    const nextAttemptAt = new Date(now.getTime() + BLOCKED_RECHECK_INTERVAL_MS);
    const { count } = await this.syncState.rescheduleBlockedCheckIfGenerationMatches(
      markerId,
      observedGeneration,
      nextAttemptAt,
    );
    if (count === 0) {
      return { outcome: 'STALE_BLOCKED_CHECK', markerId };
    }
    return { outcome, markerId };
  }
}
