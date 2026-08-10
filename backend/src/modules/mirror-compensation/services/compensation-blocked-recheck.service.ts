import { Injectable } from '@nestjs/common';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { CompensationRepository } from '../repositories/compensation.repository';
import { ReconcileOneResult } from '../types/compensation-reconciliation.types';
import { BLOCKED_RECHECK_INTERVAL_SECONDS } from './compensation-reconciliation.service';

// Phase 16A.0-C4.3 (see ADR-007). The BLOCKED-precondition recheck - a
// distinct entry point from CompensationReconciliationService.attemptRecovery
// (claimForRecoveryAttempt never matches a BLOCKED row, so there is no
// "claim" step here). Branches on the row's persisted blockReason, not
// reasonCode - the two are deliberately separate fields, see the schema
// comment. desiredQuantity is always re-derived fresh from current
// CartItem truth first: a release-shaped desired state (0) is never
// blocked by either cause and unblocks immediately without even
// consulting product accounting or mode.
//
// Additive and unwired - nothing outside this unit's own tests calls
// recheckBlocked yet. No C4.4 batching, no C4.5 scheduler.
@Injectable()
export class CompensationBlockedRecheckService {
  constructor(
    private readonly repository: CompensationRepository,
    private readonly cartRepository: CartRepository,
    private readonly inventoryReservations: InventoryReservationsService,
    private readonly modeService: ReservationEngineModeService,
  ) {}

  async recheckBlocked(compensationId: string, now: Date): Promise<ReconcileOneResult> {
    const row = await this.repository.findById(compensationId);
    if (!row) {
      return { outcome: 'NOT_FOUND', compensationId };
    }
    if (row.status === 'RESOLVED' || row.status === 'PERMANENT_FAILURE') {
      return { outcome: 'ALREADY_RESOLVED', compensationId };
    }
    if (row.status !== 'BLOCKED') {
      return { outcome: 'NOT_DUE', compensationId };
    }
    if (row.blockReason === null) {
      // Structurally unreachable - blockIfGenerationMatches always sets
      // blockReason in the same write that sets status to BLOCKED.
      throw new Error(`Invariant violation: BLOCKED compensation ${compensationId} has no blockReason`);
    }

    // Captured before any I/O - a slow check (a Redis round trip to
    // reconcileProductReservedTotal, or getCurrentMode) must judge itself
    // against the generation it started with, never one read later.
    const observedGeneration = row.generation;

    const item = await this.cartRepository.findItemByCartAndProduct(row.cartId, row.productId);
    const desiredQuantity = item?.quantity ?? 0;

    if (desiredQuantity === 0) {
      // A release-shaped desired state is never blocked by either cause.
      return this.unblock(compensationId, observedGeneration, now);
    }

    if (row.blockReason === 'MODE_NOT_ADMITTING') {
      const mode = await this.modeService.getCurrentMode();
      if (mode === 'DRAINING') {
        return this.rescheduleBlocked(compensationId, observedGeneration, now, 'BLOCKED_MODE_NOT_ADMITTING');
      }
      return this.unblock(compensationId, observedGeneration, now);
    }

    // PRODUCT_SUSPECT
    const reconciliation = await this.inventoryReservations.reconcileProductReservedTotal(row.productId);
    if (reconciliation.admissionSuspended) {
      return this.rescheduleBlocked(compensationId, observedGeneration, now, 'BLOCKED_PRODUCT_SUSPECT');
    }
    return this.unblock(compensationId, observedGeneration, now);
  }

  private async unblock(
    compensationId: string,
    observedGeneration: number,
    now: Date,
  ): Promise<ReconcileOneResult> {
    const { count } = await this.repository.unblockIfGenerationMatches(compensationId, observedGeneration, now);
    if (count === 0) {
      return { outcome: 'STALE_BLOCKED_CHECK', compensationId };
    }
    return { outcome: 'UNBLOCKED_PENDING', compensationId };
  }

  private async rescheduleBlocked(
    compensationId: string,
    observedGeneration: number,
    now: Date,
    outcome: 'BLOCKED_PRODUCT_SUSPECT' | 'BLOCKED_MODE_NOT_ADMITTING',
  ): Promise<ReconcileOneResult> {
    const nextAttemptAt = new Date(now.getTime() + BLOCKED_RECHECK_INTERVAL_SECONDS * 1000);
    const { count } = await this.repository.rescheduleBlockedCheckIfGenerationMatches(
      compensationId,
      observedGeneration,
      nextAttemptAt,
    );
    if (count === 0) {
      return { outcome: 'STALE_BLOCKED_CHECK', compensationId };
    }
    return { outcome, compensationId };
  }
}
