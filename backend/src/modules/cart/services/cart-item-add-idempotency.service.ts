import { Injectable } from '@nestjs/common';
import { CartItemAddAttempt, Prisma } from '@prisma/client';

import { CartItemAddAttemptRepository } from '../repositories/cart-item-add-attempt.repository';
import {
  CartItemAddAttemptCompletedResult,
  CartItemAddRejectionCode,
  ClassifyCartItemAddAttemptInput,
  ClassifyCartItemAddAttemptResult,
} from '../types/cart-item-add-attempt.types';

// Phase 16A.0-DA, Unit DA.2 (see the DA.2 design review). A legitimate
// PROCESSING row should transition to COMPLETED/REJECTED within
// milliseconds - phase 2 is a single fast DB transaction with no external
// I/O before it. 15s is generous headroom for load/connection-pool
// contention while still failing fast for a genuinely abandoned request
// (crashed server, dropped connection).
export const CART_ITEM_ADD_ATTEMPT_STALE_TIMEOUT_MS = 15_000;

// Bounds classify's reclaim-retry loop against sustained contention on the
// exact same stale row (two callers racing to reclaim simultaneously) -
// never an unbounded loop. Losing this race 3 times in a row within one
// 15s staleness window is not expected in practice; reporting
// ALREADY_PROCESSING after the bound is safe (the caller can simply retry
// the whole request later).
const MAX_RECLAIM_ATTEMPTS = 3;

@Injectable()
export class CartItemAddIdempotencyService {
  constructor(private readonly repository: CartItemAddAttemptRepository) {}

  async classify(input: ClassifyCartItemAddAttemptInput): Promise<ClassifyCartItemAddAttemptResult> {
    const { attempt, created } = await this.repository.createOrGetByIdempotencyKey({
      idempotencyKey: input.idempotencyKey,
      customerId: input.customerId,
      cartId: input.cartId,
      productId: input.productId,
      requestedQuantity: input.requestedQuantity,
      now: input.now,
    });

    if (created) {
      return { outcome: 'EXECUTE', attemptId: attempt.id, attemptCount: attempt.attemptCount };
    }

    // Same key, different logical intent - a conflict regardless of the
    // existing row's status (never a replay, never an execute).
    if (attempt.productId !== input.productId || attempt.requestedQuantity !== input.requestedQuantity) {
      return { outcome: 'IDEMPOTENCY_KEY_CONFLICT' };
    }

    return this.classifyExisting(attempt, input.now, 0);
  }

  private async classifyExisting(
    attempt: CartItemAddAttempt,
    now: Date,
    reclaimAttempts: number,
  ): Promise<ClassifyCartItemAddAttemptResult> {
    if (attempt.status === 'COMPLETED') {
      return {
        outcome: 'COMPLETED_REPLAY',
        result: {
          cartItemId: attempt.resultCartItemId!,
          quantity: attempt.resultQuantity!,
          mutationVersion: attempt.resultMutationVersion!,
          generation: attempt.resultGeneration!,
        },
      };
    }
    if (attempt.status === 'REJECTED') {
      return {
        outcome: 'REJECTED_REPLAY',
        rejectionCode: attempt.rejectionCode as CartItemAddRejectionCode,
        rejectionMessage: attempt.rejectionMessage!,
      };
    }

    // PROCESSING.
    const staleCutoff = new Date(now.getTime() - CART_ITEM_ADD_ATTEMPT_STALE_TIMEOUT_MS);
    if (attempt.updatedAt > staleCutoff) {
      return { outcome: 'ALREADY_PROCESSING' };
    }
    if (reclaimAttempts >= MAX_RECLAIM_ATTEMPTS) {
      return { outcome: 'ALREADY_PROCESSING' };
    }

    const reclaim = await this.repository.reclaimIfStale(attempt.id, attempt.attemptCount, staleCutoff, now);
    if (reclaim.count === 1) {
      return { outcome: 'EXECUTE', attemptId: attempt.id, attemptCount: attempt.attemptCount + 1 };
    }

    // Lost the race - a concurrent reclaimer won, or the row reached a
    // terminal state in the meantime. Re-read and reclassify.
    const fresh = await this.repository.findById(attempt.id);
    if (!fresh) {
      throw new Error(
        `Internal consistency error: CartItemAddAttempt ${attempt.id} vanished mid-reclaim (rows are never deleted)`,
      );
    }
    return this.classifyExisting(fresh, now, reclaimAttempts + 1);
  }

  // Outside any transaction - a typed business rejection happens before
  // any CartItem mutation is attempted, so there is nothing to roll back.
  reject(
    attemptId: string,
    attemptCount: number,
    rejectionCode: CartItemAddRejectionCode,
    rejectionMessage: string,
    now: Date,
  ): Promise<{ count: number }> {
    return this.repository.rejectIfCurrentAttempt(attemptId, attemptCount, rejectionCode, rejectionMessage, now);
  }

  // Requires the caller's own mutation transaction client - see
  // CartItemAddAttemptRepository.completeIfCurrentAttempt.
  complete(
    tx: Prisma.TransactionClient,
    attemptId: string,
    attemptCount: number,
    result: CartItemAddAttemptCompletedResult,
    now: Date,
  ): Promise<{ count: number }> {
    return this.repository.completeIfCurrentAttempt(tx, attemptId, attemptCount, result, now);
  }
}
