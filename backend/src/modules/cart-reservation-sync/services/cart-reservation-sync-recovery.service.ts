import { Injectable, Logger } from '@nestjs/common';

import { sanitizeErrorMessage } from '../../../common/utils/sanitize-error-message.util';
import { PrismaService } from '../../../database/prisma.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { ReservationRecoveryConvergenceService } from '../../reservation-recovery/services/reservation-recovery-convergence.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { CartReservationSyncStateRepository } from '../repositories/cart-reservation-sync-state.repository';
import {
  ReconcileOneOutcome,
  RunBatchCounters,
  RunBatchInput,
  RunBatchReconciliationResult,
  RunBatchResult,
} from '../types/cart-reservation-sync-recovery.types';
import { BLOCKED_RECHECK_INTERVAL_MS, CartReservationSyncBlockedRecheckService } from './cart-reservation-sync-blocked-recheck.service';

export const MAX_LAST_ERROR_LENGTH = 500;
export const DEFAULT_RECOVERY_BATCH_SIZE = 50;
export const MAX_RECOVERY_BATCH_SIZE = 200;

// Phase 16A.0-DA, Unit DA.1B (see the DA.1B claim-fencing review), extended
// in Unit DA.4B (see the DA.4B frozen plan) to become mode-aware. The
// recovery worker for CartReservationSyncState rows left unresolved by
// DA.1A's own synchronous convergence protocol. Owns unresolved-marker
// recovery only: it never mutates CartItem, never replays
// marker.expectedQuantity/expectedMutationVersion as instructions (Section
// 3 of the DA.1B review - they are diagnostic/ordering context only), and
// re-derives the desired Redis state from the CURRENT CartItem every time.
// customerId (for a reserve-shaped target) is likewise always re-derived
// from CURRENT durable cart ownership (Cart.customerId), never from a
// stale marker diagnostic - CartReservationSyncState has no customerId
// column, deliberately.
//
// Phase 16A.0-DA, Unit DA.4B: writes now go through
// ReservationRecoveryConvergenceService (the mode-aware recovery-authority
// port - see its own doc comment for why this is NOT ReservationGateway),
// never InventoryReservationsService directly. This is this unit's core
// job: LEGACY/MIRROR still resolve to legacy Redis (unchanged from DA.1B/
// DA.3 - MIRROR's primary authority has not moved); CART_SCOPED now
// resolves to the cart-scoped engine; DRAINING blocks a reserve-shaped
// target and allows a release-shaped one. A CONVERGED write is never
// treated as resolved until verifyModeRevisionUnchanged proves, under the
// same advisory lock setMode() holds exclusively, that the mode identity
// the write was chosen against is still current - see reconcileOne's own
// comment for the exact three-condition predicate.
//
// C4 boundary (do not conflate the two recovery domains): this worker
// repairs the AUTHORITATIVE reservation-target for a (cartId, productId)
// pair, whichever system that currently is. The mirror-compensation
// subsystem (CompensationReconciliationService/CompensationBlockedRecheckService,
// Phase C4) repairs MIRROR mode's own SECONDARY, non-authoritative
// cart-scoped mirror - a structurally similar but independently-owned
// concern, against a different durable record
// (CartReservationCompensation, not CartReservationSyncState). The two
// share a superficially similar mode-branch shape by necessity (both
// respect the same underlying Redis/mode invariants) but are deliberately
// not unified - see the DA.4B design review.
//
// No @Cron, no AppModule wiring - invocation cadence is entirely external
// to this unit.
@Injectable()
export class CartReservationSyncRecoveryService {
  private readonly logger = new Logger(CartReservationSyncRecoveryService.name);

  constructor(
    private readonly syncState: CartReservationSyncStateRepository,
    private readonly cartRepository: CartRepository,
    private readonly recoveryTarget: ReservationRecoveryConvergenceService,
    private readonly modeService: ReservationEngineModeService,
    private readonly prisma: PrismaService,
    private readonly blockedRecheck: CartReservationSyncBlockedRecheckService,
  ) {}

  // Claim -> read CURRENT CartItem (and, for a reserve-shaped target,
  // CURRENT Cart.customerId) -> converge via the mode-aware recovery
  // target -> classify the outcome. A CONVERGED outcome is resolved only
  // inside one Postgres transaction that (a) re-verifies, under the shared
  // advisory lock, that the mode identity the write was chosen against is
  // still current, and (b) resolves the claim, fenced by generation +
  // attemptCount exactly as before - both conditions must hold in the same
  // transaction, or nothing is treated as resolved.
  async reconcileOne(markerId: string, now: Date): Promise<ReconcileOneOutcome> {
    const claimed = await this.syncState.claimForRecovery(markerId, now);
    if (!claimed) {
      return this.classifyUnclaimable(markerId);
    }

    const { cartId, productId, generation: claimedGeneration, attemptCount: claimedAttemptCount } = claimed;
    const item = await this.cartRepository.findItemByCartAndProduct(cartId, productId);
    const desiredQuantity = item?.quantity ?? null;
    const customerId = item ? await this.resolveCurrentCustomerId(cartId, markerId) : null;

    const converged = await this.recoveryTarget.converge({ cartId, productId, customerId, desiredQuantity });

    if (converged.outcome === 'BLOCKED') {
      return this.enterBlocked(markerId, cartId, productId, claimedGeneration, claimedAttemptCount, converged.blockReason, now);
    }

    if (converged.outcome === 'RETRY') {
      const message =
        converged.reasonCode === 'CHECKOUT_IN_PROGRESS'
          ? 'cart-scoped reservation has an active checkout in progress'
          : sanitizeErrorMessage(converged.lastError, MAX_LAST_ERROR_LENGTH);
      return this.handleRetry(markerId, claimedGeneration, claimedAttemptCount, message);
    }

    // CONVERGED
    const { modeChanged, resolvedCount } = await this.prisma.$transaction(async (tx) => {
      const stillCurrent = await this.modeService.verifyModeRevisionUnchanged(tx, {
        revisionId: converged.observedMode.revisionId,
        revision: converged.observedMode.revision,
      });
      if (!stillCurrent) {
        await this.syncState.releaseClaimIfCurrent(
          markerId,
          claimedGeneration,
          claimedAttemptCount,
          'reservation-engine mode identity changed during recovery',
          tx,
        );
        return { modeChanged: true, resolvedCount: 0 };
      }
      const resolved = await this.syncState.resolveClaimIfCurrent(markerId, claimedGeneration, claimedAttemptCount, now, tx);
      return { modeChanged: false, resolvedCount: resolved.count };
    });

    if (modeChanged) {
      this.logger.warn('Recovery converged but the reservation-engine mode changed before resolution could be confirmed', {
        markerId,
      });
      return { outcome: 'REQUEUED_MODE_CHANGED', markerId };
    }
    if (resolvedCount > 0) {
      return { outcome: 'RESOLVED_CONVERGED', markerId };
    }
    return this.classifySupersededOrFenced(markerId, cartId, productId, claimedGeneration);
  }

  // Snapshots candidates exactly once, then processes each at most once -
  // never re-queries mid-run (Section 7 of the DA.1B review: a row
  // released back to PENDING by this very run must wait for the NEXT
  // invocation, or a persistently-failing candidate would hot-loop inside
  // one call, since there is no persisted backoff to space out retries for
  // that case). Phase 16A.0-DA, Unit DA.4B: dispatches each candidate to
  // reconcileOne or the sibling blocked-recheck service by its own
  // just-read status - mirroring CompensationBatchService's own dispatch.
  async runBatch(input: RunBatchInput): Promise<RunBatchResult> {
    const validationFailure = CartReservationSyncRecoveryService.validateInput(input);
    if (validationFailure) {
      return { ok: false, code: 'INVALID_INPUT', ...validationFailure };
    }
    const limit = input.limit ?? DEFAULT_RECOVERY_BATCH_SIZE;

    const startedAt = Date.now();
    const candidates = await this.syncState.findRecoveryCandidateIds(input.now, limit);

    const counters: RunBatchCounters = {
      resolvedConverged: 0,
      requeuedRetryableFailure: 0,
      requeuedSuperseded: 0,
      requeuedModeChanged: 0,
      blocked: 0,
      unblocked: 0,
      staleBlockedCheck: 0,
      staleClaim: 0,
      skipped: 0,
    };
    const errors: RunBatchReconciliationResult['errors'] = [];
    let attempted = 0;

    for (const candidate of candidates) {
      attempted += 1;
      try {
        const outcome =
          candidate.status === 'BLOCKED'
            ? await this.blockedRecheck.recheckBlocked(candidate.id, input.now)
            : await this.reconcileOne(candidate.id, input.now);
        CartReservationSyncRecoveryService.tallyOutcome(counters, outcome);
      } catch (error) {
        const sanitizedMessage = sanitizeErrorMessage(
          CartReservationSyncRecoveryService.errorMessage(error),
          MAX_LAST_ERROR_LENGTH,
        );
        this.logger.warn('Recovery batch candidate threw unexpectedly', {
          markerId: candidate.id,
          message: sanitizedMessage,
        });
        errors.push({ markerId: candidate.id, message: sanitizedMessage });
      }
    }

    const result: RunBatchReconciliationResult = {
      candidatesFound: candidates.length,
      attempted,
      counters,
      errors,
      durationMs: Date.now() - startedAt,
    };
    this.logger.log('Recovery batch run complete', result);
    return { ok: true, result };
  }

  // Frozen customerId authority (DA.4B): always the CURRENT Cart's owner,
  // never a stale marker diagnostic - CartReservationSyncState has no
  // customerId column, deliberately.
  private async resolveCurrentCustomerId(cartId: string, markerId: string): Promise<string> {
    const cart = await this.cartRepository.findById(cartId);
    if (!cart) {
      // Guaranteed non-null by Cart's onDelete: Restrict FK from this
      // table - a genuine invariant violation, not a normal outcome.
      throw new Error(`Invariant violation: cart ${cartId} not found for marker ${markerId}`);
    }
    return cart.customerId;
  }

  private async enterBlocked(
    markerId: string,
    cartId: string,
    productId: string,
    claimedGeneration: number,
    claimedAttemptCount: number,
    blockReason: 'PRODUCT_SUSPECT' | 'MODE_NOT_ADMITTING',
    now: Date,
  ): Promise<ReconcileOneOutcome> {
    const nextAttemptAt = new Date(now.getTime() + BLOCKED_RECHECK_INTERVAL_MS);
    const { count } = await this.syncState.blockIfGenerationMatches(
      markerId,
      claimedGeneration,
      claimedAttemptCount,
      blockReason,
      nextAttemptAt,
    );
    if (count === 0) {
      return this.classifySupersededOrFenced(markerId, cartId, productId, claimedGeneration);
    }
    this.logger.warn('Recovery blocked pending an external precondition', { markerId, blockReason, nextAttemptAt });
    return { outcome: blockReason === 'PRODUCT_SUSPECT' ? 'BLOCKED_PRODUCT_SUSPECT' : 'BLOCKED_MODE_NOT_ADMITTING', markerId };
  }

  private async handleRetry(
    markerId: string,
    claimedGeneration: number,
    claimedAttemptCount: number,
    sanitizedMessage: string | null,
  ): Promise<ReconcileOneOutcome> {
    const released = await this.syncState.releaseClaimIfCurrent(markerId, claimedGeneration, claimedAttemptCount, sanitizedMessage);
    if (released.count > 0) {
      this.logger.warn('Recovery write requires retry - claim released, immediately retryable', {
        markerId,
        message: sanitizedMessage,
      });
      return { outcome: 'REQUEUED_RETRYABLE_FAILURE', markerId };
    }
    // Fenced out mid-write - another worker/customer mutation already
    // moved past this claim. No further write is safe to attempt.
    return { outcome: 'STALE_CLAIM', markerId };
  }

  // The write (or block transition) itself "succeeded" but the terminal
  // claim-fencing predicate missed - distinguish WHY before deciding
  // whether markUnresolved is safe to call. Reused identically for a
  // missed resolve AND a missed block-entry: the fencing predicate (id +
  // generation + attemptCount + status='PROCESSING') and the ambiguity it
  // resolves are the same regardless of which terminal transition missed.
  private async classifySupersededOrFenced(
    markerId: string,
    cartId: string,
    productId: string,
    claimedGeneration: number,
  ): Promise<ReconcileOneOutcome> {
    const current = await this.syncState.findById(markerId);
    if (current && current.generation !== claimedGeneration) {
      // A customer mutation superseded us - its own upsertDesiredState/
      // advanceIfCurrentGeneration write already reset status to PENDING,
      // so this is a harmless no-op on status, and necessary in case our
      // stale write landed after their own already-resolved write (DA.1A's
      // Review #2 conservative false-PENDING rule: false PENDING is safe,
      // false RESOLVED is not).
      await this.syncState.markUnresolved(cartId, productId);
      return { outcome: 'REQUEUED_SUPERSEDED', markerId };
    }
    // generation unchanged - only attemptCount/status moved, meaning
    // another DA.1B worker reclaimed this row as stale. Their claim must
    // never be touched by this fenced-out caller.
    return { outcome: 'STALE_CLAIM', markerId };
  }

  private async classifyUnclaimable(markerId: string): Promise<ReconcileOneOutcome> {
    const row = await this.syncState.findById(markerId);
    if (!row) {
      return { outcome: 'NOT_FOUND', markerId };
    }
    if (row.resolvedAt !== null) {
      return { outcome: 'ALREADY_RESOLVED', markerId };
    }
    return { outcome: 'ALREADY_CLAIMED', markerId };
  }

  private static validateInput(input: RunBatchInput): { field: string; reason: string } | null {
    if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
      return { field: 'now', reason: 'now must be a valid Date' };
    }
    if (input.limit !== undefined) {
      if (!Number.isInteger(input.limit) || input.limit <= 0) {
        return { field: 'limit', reason: 'limit must be a positive integer' };
      }
      if (input.limit > MAX_RECOVERY_BATCH_SIZE) {
        return { field: 'limit', reason: `limit must not exceed ${MAX_RECOVERY_BATCH_SIZE}` };
      }
    }
    return null;
  }

  private static tallyOutcome(counters: RunBatchCounters, outcome: ReconcileOneOutcome): void {
    switch (outcome.outcome) {
      case 'RESOLVED_CONVERGED':
        counters.resolvedConverged += 1;
        return;
      case 'REQUEUED_RETRYABLE_FAILURE':
        counters.requeuedRetryableFailure += 1;
        return;
      case 'REQUEUED_SUPERSEDED':
        counters.requeuedSuperseded += 1;
        return;
      case 'REQUEUED_MODE_CHANGED':
        counters.requeuedModeChanged += 1;
        return;
      case 'BLOCKED_PRODUCT_SUSPECT':
      case 'BLOCKED_MODE_NOT_ADMITTING':
        counters.blocked += 1;
        return;
      case 'UNBLOCKED_PENDING':
        counters.unblocked += 1;
        return;
      case 'STALE_BLOCKED_CHECK':
        counters.staleBlockedCheck += 1;
        return;
      case 'STALE_CLAIM':
        counters.staleClaim += 1;
        return;
      case 'ALREADY_RESOLVED':
      case 'ALREADY_CLAIMED':
      case 'NOT_DUE':
      case 'NOT_FOUND':
        counters.skipped += 1;
        return;
      default: {
        const exhaustiveCheck: never = outcome;
        throw new Error(`Unhandled ReconcileOneOutcome outcome: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
