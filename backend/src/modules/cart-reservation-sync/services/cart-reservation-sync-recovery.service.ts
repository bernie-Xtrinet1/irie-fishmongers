import { Injectable, Logger } from '@nestjs/common';

import { sanitizeErrorMessage } from '../../../common/utils/sanitize-error-message.util';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CartReservationSyncStateRepository } from '../repositories/cart-reservation-sync-state.repository';
import {
  ReconcileOneOutcome,
  RunBatchCounters,
  RunBatchInput,
  RunBatchReconciliationResult,
  RunBatchResult,
} from '../types/cart-reservation-sync-recovery.types';

export const MAX_LAST_ERROR_LENGTH = 500;
export const DEFAULT_RECOVERY_BATCH_SIZE = 50;
export const MAX_RECOVERY_BATCH_SIZE = 200;

// Phase 16A.0-DA, Unit DA.1B (see the DA.1B claim-fencing review). The
// recovery worker for CartReservationSyncState rows left unresolved by
// DA.1A's own synchronous convergence protocol. Owns unresolved-marker
// recovery only: it never mutates CartItem, never replays
// marker.expectedQuantity/expectedMutationVersion as instructions (Section
// 3 of the DA.1B review - they are diagnostic/ordering context only), and
// re-derives the desired Redis state from the CURRENT CartItem every time.
//
// Calls the same legacy InventoryReservationsService.reserve/release
// CartService itself calls - no ReservationGateway/mode-awareness here,
// matching DA.1A's own scope boundary. No @Cron, no AppModule wiring -
// invocation cadence is entirely external to this unit.
@Injectable()
export class CartReservationSyncRecoveryService {
  private readonly logger = new Logger(CartReservationSyncRecoveryService.name);

  constructor(
    private readonly syncState: CartReservationSyncStateRepository,
    private readonly cartRepository: CartRepository,
    private readonly inventoryReservations: InventoryReservationsService,
  ) {}

  // Claim -> read CURRENT CartItem -> write absolute Redis target -> verify
  // the claim (generation + attemptCount + status='PROCESSING') is still
  // exactly the one this call acquired before treating anything as
  // resolved. attemptCount is the claim-fencing token (monotonic, never
  // reset - unlike CartItem.mutationVersion): a stale worker's captured
  // pair can never match again once superseded, whether by a customer
  // mutation (generation moves) or by another worker's stale-PROCESSING
  // reclaim (attemptCount moves, generation does not).
  async reconcileOne(markerId: string, now: Date): Promise<ReconcileOneOutcome> {
    const claimed = await this.syncState.claimForRecovery(markerId, now);
    if (!claimed) {
      return this.classifyUnclaimable(markerId);
    }

    const { cartId, productId, generation: claimedGeneration, attemptCount: claimedAttemptCount } = claimed;
    const item = await this.cartRepository.findItemByCartAndProduct(cartId, productId);

    try {
      if (item) {
        await this.inventoryReservations.reserve(productId, cartId, item.quantity);
      } else {
        await this.inventoryReservations.release(productId, cartId);
      }
    } catch (error) {
      return this.handleRetryableFailure(markerId, claimedGeneration, claimedAttemptCount, error);
    }

    const resolved = await this.syncState.resolveClaimIfCurrent(markerId, claimedGeneration, claimedAttemptCount, now);
    if (resolved.count > 0) {
      return { outcome: 'RESOLVED_CONVERGED', markerId };
    }
    return this.classifySupersededOrFenced(markerId, cartId, productId, claimedGeneration);
  }

  // Snapshots candidates exactly once, then processes each at most once -
  // never re-queries mid-run (Section 7 of the DA.1B review: a row
  // released back to PENDING by this very run must wait for the NEXT
  // invocation, or a persistently-failing candidate would hot-loop inside
  // one call, since there is no persisted backoff to space out retries).
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
      staleClaim: 0,
      skipped: 0,
    };
    const errors: RunBatchReconciliationResult['errors'] = [];
    let attempted = 0;

    for (const candidate of candidates) {
      attempted += 1;
      try {
        const outcome = await this.reconcileOne(candidate.id, input.now);
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

  private async handleRetryableFailure(
    markerId: string,
    claimedGeneration: number,
    claimedAttemptCount: number,
    error: unknown,
  ): Promise<ReconcileOneOutcome> {
    const sanitized = sanitizeErrorMessage(
      CartReservationSyncRecoveryService.errorMessage(error),
      MAX_LAST_ERROR_LENGTH,
    );
    const released = await this.syncState.releaseClaimIfCurrent(markerId, claimedGeneration, claimedAttemptCount, sanitized);
    if (released.count > 0) {
      this.logger.warn('Recovery Redis write threw - claim released, immediately retryable', {
        markerId,
        message: sanitized,
      });
      return { outcome: 'REQUEUED_RETRYABLE_FAILURE', markerId };
    }
    // Fenced out mid-write - another worker/customer mutation already
    // moved past this claim. No further write is safe to attempt.
    return { outcome: 'STALE_CLAIM', markerId };
  }

  // The Redis write itself "succeeded" but the terminal claim-fencing
  // predicate missed - distinguish WHY before deciding whether
  // markUnresolved is safe to call.
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
      // stale Redis write landed after their own already-resolved write
      // (DA.1A's Review #2 conservative false-PENDING rule: false PENDING
      // is safe, false RESOLVED is not).
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
      case 'STALE_CLAIM':
        counters.staleClaim += 1;
        return;
      case 'ALREADY_RESOLVED':
      case 'ALREADY_CLAIMED':
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
