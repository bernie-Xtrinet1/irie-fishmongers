import { Injectable } from '@nestjs/common';

import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { ReservationEngineModeSnapshot } from '../../reservation-engine-mode/types/reservation-engine-mode.types';
import {
  DirectCartScopedConvergenceResult,
  ReservationRecoveryConvergenceInput,
  ReservationRecoveryConvergenceResult,
  ReservationRecoveryTarget,
} from '../types/reservation-recovery.types';

// Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen plan). The mode-aware
// write-routing/classification authority for recovery - the frozen
// four-mode matrix, and nothing else. Owns exactly one job: given a
// caller-derived desired state, resolve the current mode ONCE, pick the
// correct write, perform it, and classify the outcome. Never touches
// CartRepository, marker persistence, claim fencing, or retry/backoff
// bookkeeping - those stay entirely owned by CartReservationSyncRecoveryService
// (the recovery worker), which is also solely responsible for the terminal
// mode-identity re-validation (under the shared advisory lock) before ever
// treating a CONVERGED result as resolved - see that service's own comment.
//
// LEGACY/MIRROR both route to legacy Redis (reserve/release) - MIRROR's
// primary/authoritative target has not moved; the cart-scoped mirror is
// repaired independently by the C4 mirror-compensation subsystem (see
// CartReservationSyncRecoveryService's own C4-boundary comment). CART_SCOPED
// routes to the cart-scoped engine (reserveOrRenew/releaseReservation).
// DRAINING: release-shaped recovery is always allowed (full cleanup remains
// permitted while draining, matching C3's own precedent); reserve-shaped
// recovery is BLOCKED(MODE_NOT_ADMITTING), never written through - recovery
// must never create a second admission path around DRAINING merely because
// a CartItem already exists (frozen policy; see the DA.4B design review).
@Injectable()
export class ReservationRecoveryConvergenceService implements ReservationRecoveryTarget {
  constructor(
    private readonly modeService: ReservationEngineModeService,
    private readonly inventoryReservations: InventoryReservationsService,
  ) {}

  async converge(input: ReservationRecoveryConvergenceInput): Promise<ReservationRecoveryConvergenceResult> {
    const snapshot = await this.modeService.getCurrentModeSnapshot();

    if (snapshot.mode === 'LEGACY' || snapshot.mode === 'MIRROR') {
      return this.convergeLegacy(input, snapshot);
    }

    if (snapshot.mode === 'DRAINING' && input.desiredQuantity !== null) {
      return { outcome: 'BLOCKED', blockReason: 'MODE_NOT_ADMITTING', observedMode: snapshot };
    }

    // CART_SCOPED (reserve or release), or DRAINING with a release-shaped
    // target (allowed unconditionally).
    return this.convergeCartScoped(input, snapshot);
  }

  private async convergeLegacy(
    input: ReservationRecoveryConvergenceInput,
    snapshot: ReservationEngineModeSnapshot,
  ): Promise<ReservationRecoveryConvergenceResult> {
    try {
      if (input.desiredQuantity === null) {
        await this.inventoryReservations.release(input.productId, input.cartId);
      } else {
        await this.inventoryReservations.reserve(input.productId, input.cartId, input.desiredQuantity);
      }
      return { outcome: 'CONVERGED', observedMode: snapshot };
    } catch (error) {
      return {
        outcome: 'RETRY',
        reasonCode: 'UNKNOWN_INFRA_FAILURE',
        lastError: ReservationRecoveryConvergenceService.errorMessage(error),
        observedMode: snapshot,
      };
    }
  }

  private async convergeCartScoped(
    input: ReservationRecoveryConvergenceInput,
    snapshot: ReservationEngineModeSnapshot,
  ): Promise<ReservationRecoveryConvergenceResult> {
    const core = await this.convergeCartScopedCore(input);
    return { ...core, observedMode: snapshot };
  }

  // CART_SCOPED activation-boundary gate (see the gate design review's
  // direct-backfill design). The pre-cutover backfill/freshness sweep's
  // sole entry point - bypasses the mode read entirely (mode is still
  // MIRROR the whole time this runs; converge()'s own mode-branching logic
  // would incorrectly route through convergeLegacy) and calls the exact
  // same underlying convergeCartScopedCore logic convergeCartScoped
  // itself uses, so PRODUCT_SUSPECT/CHECKOUT_IN_PROGRESS/underflow
  // classification is never duplicated. No observedMode - see
  // DirectCartScopedConvergenceResult's own comment for why.
  async convergeCartScopedDirect(
    input: ReservationRecoveryConvergenceInput,
  ): Promise<DirectCartScopedConvergenceResult> {
    return this.convergeCartScopedCore(input);
  }

  private async convergeCartScopedCore(
    input: ReservationRecoveryConvergenceInput,
  ): Promise<DirectCartScopedConvergenceResult> {
    if (input.desiredQuantity === null) {
      try {
        const result = await this.inventoryReservations.releaseReservation(input.cartId, input.productId);
        if (result.underflow !== null) {
          return { outcome: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT' };
        }
        return { outcome: 'CONVERGED' };
      } catch (error) {
        return {
          outcome: 'RETRY',
          reasonCode: 'UNKNOWN_INFRA_FAILURE',
          lastError: ReservationRecoveryConvergenceService.errorMessage(error),
        };
      }
    }

    if (input.customerId === null) {
      // Structurally unreachable given this port's own contract (customerId
      // is required whenever desiredQuantity is non-null) - a genuine
      // invariant violation in the caller, not a normal outcome to branch
      // on.
      throw new Error('Invariant violation: customerId is required to converge a reserve-shaped target');
    }

    try {
      const outcome = await this.inventoryReservations.reserveOrRenew(
        input.cartId,
        input.productId,
        input.customerId,
        input.desiredQuantity,
      );
      if (!outcome.ok) {
        if (outcome.code === 'RESERVATION_PRODUCT_SUSPENDED') {
          return { outcome: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT' };
        }
        // RESERVATION_CHECKOUT_IN_PROGRESS - an active checkout is
        // currently consuming this reservation; back off and retry rather
        // than force-overwrite it.
        return { outcome: 'RETRY', reasonCode: 'CHECKOUT_IN_PROGRESS', lastError: null };
      }
      if (outcome.result.underflow !== null) {
        return { outcome: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT' };
      }
      return { outcome: 'CONVERGED' };
    } catch (error) {
      return {
        outcome: 'RETRY',
        reasonCode: 'UNKNOWN_INFRA_FAILURE',
        lastError: ReservationRecoveryConvergenceService.errorMessage(error),
      };
    }
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
