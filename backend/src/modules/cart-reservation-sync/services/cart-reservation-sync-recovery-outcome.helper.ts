import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { sanitizeErrorMessage } from '../../../common/utils/sanitize-error-message.util';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { ReservationEngineModeSnapshot } from '../../reservation-engine-mode/types/reservation-engine-mode.types';
import { PrismaService } from '../../../database/prisma.service';
import { CartReservationSyncStateRepository } from '../repositories/cart-reservation-sync-state.repository';
import { ReconcileOneOutcome, RunBatchCounters, RunBatchInput } from '../types/cart-reservation-sync-recovery.types';

export const MAX_LAST_ERROR_LENGTH = 500;
export const DEFAULT_RECOVERY_BATCH_SIZE = 50;
export const MAX_RECOVERY_BATCH_SIZE = 200;
export const MAX_FENCE_DISAGREEMENT_RETRY_ATTEMPTS = 3;
export const MAX_RECOVERY_RETRY_ATTEMPTS = 10;

export async function escalateMarkerRetryLimit(params: {
  syncState: CartReservationSyncStateRepository;
  logger: Logger;
  markerId: string;
  cartId: string;
  productId: string;
  claimedGeneration: number;
  claimedAttemptCount: number;
  detail: string | null;
  now: Date;
  recheckIntervalMs: number;
  classifySuperseded: () => Promise<ReconcileOneOutcome>;
  tx?: Prisma.TransactionClient;
}): Promise<ReconcileOneOutcome> {
  const nextAttemptAt = new Date(params.now.getTime() + params.recheckIntervalMs);
  const escalatedMessage = sanitizeErrorMessage(
    `OPERATOR_ESCALATION: ${params.detail ?? 'recovery retry limit exceeded'}`,
    MAX_LAST_ERROR_LENGTH,
  )!;
  const { count } =
    typeof (params.syncState as { escalateBlockedIfCurrent?: unknown }).escalateBlockedIfCurrent === 'function'
      ? await params.syncState.escalateBlockedIfCurrent(
          params.markerId,
          params.claimedGeneration,
          params.claimedAttemptCount,
          nextAttemptAt,
          escalatedMessage,
          params.tx,
        )
      : await params.syncState.blockIfGenerationMatches(
          params.markerId,
          params.claimedGeneration,
          params.claimedAttemptCount,
          'MODE_NOT_ADMITTING',
          nextAttemptAt,
          params.tx,
        );
  if (count === 0) {
    return params.classifySuperseded();
  }
  params.logger.error('Operator escalation required for sync recovery marker', {
    markerId: params.markerId,
    cartId: params.cartId,
    productId: params.productId,
    claimedAttemptCount: params.claimedAttemptCount,
    detail: escalatedMessage,
  });
  return { outcome: 'BLOCKED_MODE_NOT_ADMITTING', markerId: params.markerId };
}

export async function releaseMarkerIfModeChanged(params: {
  prisma: PrismaService;
  modeService: ReservationEngineModeService;
  syncState: CartReservationSyncStateRepository;
  logger: Logger;
  markerId: string;
  cartId: string;
  productId: string;
  claimedGeneration: number;
  claimedAttemptCount: number;
  observedMode: Pick<ReservationEngineModeSnapshot, 'revisionId' | 'revision'>;
  now: Date;
  recheckIntervalMs: number;
  classifySuperseded: () => Promise<ReconcileOneOutcome>;
}): Promise<ReconcileOneOutcome | null> {
  return params.prisma.$transaction(async (tx) => {
    const stillCurrent = await params.modeService.verifyModeRevisionUnchanged(tx, {
      revisionId: params.observedMode.revisionId,
      revision: params.observedMode.revision,
    });
    if (stillCurrent) {
      return null;
    }
    if (params.claimedAttemptCount >= MAX_RECOVERY_RETRY_ATTEMPTS) {
      return escalateMarkerRetryLimit({
        syncState: params.syncState,
        logger: params.logger,
        markerId: params.markerId,
        cartId: params.cartId,
        productId: params.productId,
        claimedGeneration: params.claimedGeneration,
        claimedAttemptCount: params.claimedAttemptCount,
        detail: 'recovery exceeded retry bound across mode transitions',
        now: params.now,
        recheckIntervalMs: params.recheckIntervalMs,
        classifySuperseded: params.classifySuperseded,
        tx,
      });
    }
    const released = await params.syncState.releaseClaimIfCurrent(
      params.markerId,
      params.claimedGeneration,
      params.claimedAttemptCount,
      'reservation-engine mode identity changed during recovery',
      tx,
    );
    if (released.count === 0) {
      return { outcome: 'STALE_CLAIM', markerId: params.markerId };
    }
    params.logger.warn('Reservation-engine mode changed mid-flight; marker requeued without unsafe resolution', {
      markerId: params.markerId,
    });
    return { outcome: 'REQUEUED_MODE_CHANGED', markerId: params.markerId };
  });
}

export function classifyRetryFailure(
  reasonCode: 'CHECKOUT_IN_PROGRESS' | 'FENCE_REJECTED' | 'UNKNOWN_INFRA_FAILURE',
  lastError: string | null,
): { message: string | null; retryLimit: number } {
  if (reasonCode === 'FENCE_REJECTED') {
    return {
      message: 'unresolved reservation mode/fence disagreement: FENCE_REJECTED',
      retryLimit: MAX_FENCE_DISAGREEMENT_RETRY_ATTEMPTS,
    };
  }
  if (reasonCode === 'CHECKOUT_IN_PROGRESS') {
    return {
      message: 'cart-scoped reservation has an active checkout in progress',
      retryLimit: MAX_RECOVERY_RETRY_ATTEMPTS,
    };
  }
  return {
    message: sanitizeErrorMessage(lastError, MAX_LAST_ERROR_LENGTH),
    retryLimit: MAX_RECOVERY_RETRY_ATTEMPTS,
  };
}

export function validateBatchInput(input: RunBatchInput): { field: string; reason: string } | null {
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

export function tallyRecoveryOutcome(counters: RunBatchCounters, outcome: ReconcileOneOutcome): void {
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
