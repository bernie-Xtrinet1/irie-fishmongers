import { Injectable, Logger } from '@nestjs/common';
import { CompensationBlockReason, CompensationReasonCode } from '@prisma/client';

import { sanitizeErrorMessage } from '../../../common/utils/sanitize-error-message.util';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { CompensationRepository } from '../repositories/compensation.repository';
import { ReconcileOneResult } from '../types/compensation-reconciliation.types';
import { MAX_LAST_ERROR_LENGTH } from './compensation.service';

export const MAX_RECOVERY_ATTEMPTS = 5;

// Delay in seconds before attempts 2-5 respectively (index 0 = delay
// before attempt 2, ... index 3 = delay before attempt 5). Frozen per the
// approved C4.3 contract - no jitter/growth beyond this fixed schedule.
const RECOVERY_ATTEMPT_BACKOFF_SECONDS: readonly number[] = [30, 120, 600, 1800];

// Frozen per the approved C4.3 contract - no jitter/backoff growth.
// Exported for reuse by CompensationBlockedRecheckService, which uses the
// same cadence for its own reschedule writes.
export const BLOCKED_RECHECK_INTERVAL_SECONDS = 60;

// Phase 16A.0-C4.3 (see ADR-007). attemptRecovery is the single-row
// desired-state convergence entry point: it claims a due/stale row,
// re-derives desired state from current Cart/CartItem truth (never from
// the row's own operation/customerId/desiredQuantity, which are
// diagnostics only), and converges the cart-scoped mirror to that truth.
// recheckBlocked (the BLOCKED-precondition recheck) lives in the sibling
// CompensationBlockedRecheckService - a distinct entry point, since
// claimForRecoveryAttempt never matches a BLOCKED row.
//
// Additive and unwired - nothing outside this unit's own tests calls
// attemptRecovery yet. No C4.4 batching, no C4.5 scheduler, no
// CartService/ProductsService/OrdersService dependency of any kind.
@Injectable()
export class CompensationReconciliationService {
  private readonly logger = new Logger(CompensationReconciliationService.name);

  constructor(
    private readonly repository: CompensationRepository,
    private readonly cartRepository: CartRepository,
    private readonly inventoryReservations: InventoryReservationsService,
    private readonly modeService: ReservationEngineModeService,
  ) {}

  async attemptRecovery(compensationId: string, now: Date): Promise<ReconcileOneResult> {
    const claim = await this.repository.claimForRecoveryAttempt(compensationId, now);
    if (claim.count === 0) {
      return this.classifyUnclaimable(compensationId);
    }

    const row = await this.repository.findById(compensationId);
    if (!row) {
      // Structurally unreachable - the row we just claimed by this exact
      // id cannot have vanished (nothing deletes compensation rows).
      return { outcome: 'NOT_FOUND', compensationId };
    }
    const { generation, cartId, productId, attemptCount } = row;

    const cart = await this.cartRepository.findById(cartId);
    if (!cart) {
      // Guaranteed non-null by Cart's onDelete: Restrict FK from this
      // table (see the schema comment) - a genuine invariant violation,
      // not a normal outcome to branch on.
      throw new Error(
        `Invariant violation: cart ${cartId} not found for compensation ${compensationId}`,
      );
    }
    const item = await this.cartRepository.findItemByCartAndProduct(cartId, productId);
    const desiredQuantity = item?.quantity ?? 0;

    const mode = await this.modeService.getCurrentMode();

    if (mode === 'LEGACY') {
      // Mode is retired - always clean up the mirror regardless of
      // desired quantity, never reinstate a cart-scoped reservation.
      return this.attemptRelease(compensationId, generation, cartId, productId, attemptCount, now, true);
    }

    if (mode === 'DRAINING' && desiredQuantity > 0) {
      // Never reserve/renew while DRAINING - no write is attempted at all.
      return this.enterBlocked(compensationId, generation, 'MODE_NOT_ADMITTING', undefined, null, now);
    }

    if (mode === 'CART_SCOPED') {
      this.logger.warn('Unresolved compensation row found while engine is in CART_SCOPED mode', {
        compensationId,
        cartId,
        productId,
      });
    }

    if (desiredQuantity > 0) {
      return this.attemptReserve(
        compensationId,
        generation,
        cartId,
        productId,
        cart.customerId,
        desiredQuantity,
        attemptCount,
        now,
      );
    }
    return this.attemptRelease(compensationId, generation, cartId, productId, attemptCount, now, false);
  }

  private async classifyUnclaimable(compensationId: string): Promise<ReconcileOneResult> {
    const row = await this.repository.findById(compensationId);
    if (!row) {
      return { outcome: 'NOT_FOUND', compensationId };
    }
    if (row.status === 'RESOLVED' || row.status === 'PERMANENT_FAILURE') {
      return { outcome: 'ALREADY_RESOLVED', compensationId };
    }
    return { outcome: 'NOT_DUE', compensationId };
  }

  private async attemptReserve(
    compensationId: string,
    generation: number,
    cartId: string,
    productId: string,
    customerId: string,
    desiredQuantity: number,
    attemptCount: number,
    now: Date,
  ): Promise<ReconcileOneResult> {
    try {
      const outcome = await this.inventoryReservations.reserveOrRenew(cartId, productId, customerId, desiredQuantity);
      if (!outcome.ok) {
        if (outcome.code === 'RESERVATION_PRODUCT_SUSPENDED') {
          return this.enterBlocked(compensationId, generation, 'PRODUCT_SUSPECT', 'PRODUCT_SUSPENDED', null, now);
        }
        // RESERVATION_CHECKOUT_IN_PROGRESS - never routed through the
        // product-suspect BLOCKED checker.
        return this.scheduleRetryOrFail(
          compensationId,
          generation,
          attemptCount,
          'CHECKOUT_IN_PROGRESS',
          null,
          now,
        );
      }
      if (outcome.result.underflow !== null) {
        return this.enterBlocked(compensationId, generation, 'PRODUCT_SUSPECT', 'ACCOUNTING_UNDERFLOW', null, now);
      }
      return this.resolve(compensationId, generation, now, false);
    } catch (error) {
      return this.scheduleRetryOrFail(
        compensationId,
        generation,
        attemptCount,
        'UNKNOWN_INFRA_FAILURE',
        CompensationReconciliationService.errorMessage(error),
        now,
      );
    }
  }

  private async attemptRelease(
    compensationId: string,
    generation: number,
    cartId: string,
    productId: string,
    attemptCount: number,
    now: Date,
    legacyCleanup: boolean,
  ): Promise<ReconcileOneResult> {
    try {
      const result = await this.inventoryReservations.releaseReservation(cartId, productId);
      if (result.underflow !== null) {
        return this.enterBlocked(compensationId, generation, 'PRODUCT_SUSPECT', 'ACCOUNTING_UNDERFLOW', null, now);
      }
      return this.resolve(compensationId, generation, now, legacyCleanup);
    } catch (error) {
      return this.scheduleRetryOrFail(
        compensationId,
        generation,
        attemptCount,
        'UNKNOWN_INFRA_FAILURE',
        CompensationReconciliationService.errorMessage(error),
        now,
      );
    }
  }

  private async resolve(
    compensationId: string,
    generation: number,
    now: Date,
    legacyCleanup: boolean,
  ): Promise<ReconcileOneResult> {
    const { count } = await this.repository.resolveIfGenerationMatches(compensationId, generation, now);
    if (count === 0) {
      return this.releaseStaleClaim(compensationId, now);
    }
    this.logger.log('Compensation row converged', { compensationId, legacyCleanup });
    return { outcome: legacyCleanup ? 'RESOLVED_NO_LONGER_NEEDED_LEGACY' : 'RESOLVED_CONVERGED', compensationId };
  }

  private async enterBlocked(
    compensationId: string,
    generation: number,
    blockReason: CompensationBlockReason,
    reasonCode: CompensationReasonCode | undefined,
    rawLastError: string | null,
    now: Date,
  ): Promise<ReconcileOneResult> {
    const nextAttemptAt = new Date(now.getTime() + BLOCKED_RECHECK_INTERVAL_SECONDS * 1000);
    const { count } = await this.repository.blockIfGenerationMatches(compensationId, generation, {
      blockReason,
      ...(reasonCode !== undefined ? { reasonCode } : {}),
      lastError: sanitizeErrorMessage(rawLastError, MAX_LAST_ERROR_LENGTH),
      nextAttemptAt,
    });
    if (count === 0) {
      return this.releaseStaleClaim(compensationId, now);
    }
    this.logger.warn('Compensation row blocked', { compensationId, blockReason, reasonCode });
    return {
      outcome: blockReason === 'PRODUCT_SUSPECT' ? 'BLOCKED_PRODUCT_SUSPECT' : 'BLOCKED_MODE_NOT_ADMITTING',
      compensationId,
    };
  }

  private async scheduleRetryOrFail(
    compensationId: string,
    generation: number,
    attemptCount: number,
    reasonCode: CompensationReasonCode,
    rawLastError: string | null,
    now: Date,
  ): Promise<ReconcileOneResult> {
    const sanitizedLastError = sanitizeErrorMessage(rawLastError, MAX_LAST_ERROR_LENGTH);

    if (attemptCount >= MAX_RECOVERY_ATTEMPTS) {
      const { count } = await this.repository.markPermanentFailureIfGenerationMatches(
        compensationId,
        generation,
        now,
      );
      if (count === 0) {
        return this.releaseStaleClaim(compensationId, now);
      }
      this.logger.warn('Compensation row permanently failed', { compensationId, attemptCount, reasonCode });
      return { outcome: 'PERMANENT_FAILURE', compensationId };
    }

    const delaySeconds = RECOVERY_ATTEMPT_BACKOFF_SECONDS[attemptCount - 1]!;
    const nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000);
    const { count } = await this.repository.requeueAfterAttemptIfGenerationMatches(compensationId, generation, {
      reasonCode,
      lastError: sanitizedLastError,
      nextAttemptAt,
    });
    if (count === 0) {
      return this.releaseStaleClaim(compensationId, now);
    }
    return { outcome: 'RETRY_SCHEDULED', compensationId, nextAttemptAt };
  }

  // The safe generation-superseded release: the row is provably still
  // PROCESSING (a concurrent recordMirrorDivergence arrival advanced
  // generation via advanceGenerationPreservingStatus, which never touches
  // status), so releasing it immediately - via the ungated
  // releaseStaleClaim, never requeueAfterAttemptIfGenerationMatches -
  // makes it claimable again right away rather than waiting out the
  // 5-minute stale-PROCESSING reclaim window. This makes no claim about
  // convergence and does not touch generation/reasonCode/lastError; the
  // newer arrival already wrote the correct diagnostic snapshot.
  private async releaseStaleClaim(compensationId: string, now: Date): Promise<ReconcileOneResult> {
    await this.repository.releaseStaleClaim(compensationId, now);
    this.logger.log('Compensation recovery attempt superseded by a newer divergence', { compensationId });
    return { outcome: 'REQUEUED_NEWER_DIVERGENCE', compensationId };
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
