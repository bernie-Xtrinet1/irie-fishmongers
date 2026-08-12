import { Injectable } from '@nestjs/common';
import { CartItemAddAttempt, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { CartItemAddAttemptCompletedResult, CartItemAddRejectionCode } from '../types/cart-item-add-attempt.types';

export type PrismaClientOrTx = PrismaService | Prisma.TransactionClient;

// Phase 16A.0-DA, Unit DA.2 (see the DA.2 design review). Owns every access
// to prisma.cartItemAddAttempt. Every conditional-transition method is a
// single atomic updateMany, returning a plain { count } for
// CartItemAddIdempotencyService to classify - matching
// CheckoutAttemptRepository's own established idiom, never a
// read-then-write.
@Injectable()
export class CartItemAddAttemptRepository {
  constructor(private readonly prisma: PrismaService) {}

  // The unique (customerId, idempotencyKey) constraint is the concurrency
  // authority: a plain create() is attempted first - if two callers race,
  // exactly one create() succeeds and the other observes Postgres's P2002
  // unique-violation, at which point it re-reads the row the winner just
  // created. Never a find-then-create sequence, which would leave an
  // unguarded race window. This is its own fast statement, deliberately
  // not wrapped in the addItem mutation transaction - see the model-level
  // comment on CartItemAddAttempt for why that separation matters.
  async createOrGetByIdempotencyKey(input: {
    idempotencyKey: string;
    customerId: string;
    cartId: string;
    productId: string;
    requestedQuantity: number;
    now: Date;
  }): Promise<{ attempt: CartItemAddAttempt; created: boolean }> {
    try {
      const attempt = await this.prisma.cartItemAddAttempt.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          customerId: input.customerId,
          cartId: input.cartId,
          productId: input.productId,
          requestedQuantity: input.requestedQuantity,
          createdAt: input.now,
          updatedAt: input.now,
        },
      });
      return { attempt, created: true };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        Array.isArray(error.meta?.target) &&
        (error.meta.target as string[]).includes('idempotencyKey')
      ) {
        const existing = await this.prisma.cartItemAddAttempt.findUnique({
          where: { customerId_idempotencyKey: { customerId: input.customerId, idempotencyKey: input.idempotencyKey } },
        });
        if (!existing) {
          throw new Error(
            `Internal consistency error: (customerId, idempotencyKey) unique constraint was violated for ` +
              `customerId="${input.customerId}" but no row was found on re-read`,
          );
        }
        return { attempt: existing, created: false };
      }
      throw error;
    }
  }

  // Conditional reclaim of a PROCESSING row whose updatedAt proves no
  // activity since staleCutoff - never touches a row that isn't still at
  // the exact attemptCount the caller last observed, so two callers
  // racing to reclaim the same stale row can never both succeed (only one
  // update's WHERE clause still matches by the time it runs).
  reclaimIfStale(
    id: string,
    expectedAttemptCount: number,
    staleCutoff: Date,
    now: Date,
  ): Promise<{ count: number }> {
    return this.prisma.cartItemAddAttempt.updateMany({
      where: { id, status: 'PROCESSING', attemptCount: expectedAttemptCount, updatedAt: { lte: staleCutoff } },
      data: { attemptCount: { increment: 1 }, updatedAt: now },
    });
  }

  // Requires an externally-owned transaction client, matching
  // CheckoutAttemptRepository.markCommitted - this method must never
  // default to the plain injected PrismaService. Fenced on
  // (id, attemptCount, status='PROCESSING'): a miss means a newer reclaim
  // has already superseded this attempt, and the caller must roll back
  // the whole mutation transaction rather than let a stale attempt's
  // CartItem/marker writes commit - see the model-level comment.
  completeIfCurrentAttempt(
    tx: Prisma.TransactionClient,
    id: string,
    attemptCount: number,
    result: CartItemAddAttemptCompletedResult,
    now: Date,
  ): Promise<{ count: number }> {
    return tx.cartItemAddAttempt.updateMany({
      where: { id, attemptCount, status: 'PROCESSING' },
      data: {
        status: 'COMPLETED',
        resultCartItemId: result.cartItemId,
        resultQuantity: result.quantity,
        resultMutationVersion: result.mutationVersion,
        resultGeneration: result.generation,
        updatedAt: now,
      },
    });
  }

  // A single atomic updateMany, called outside any transaction - a typed
  // business rejection happens before any CartItem mutation is even
  // attempted, so there is nothing to roll back. Fenced identically to
  // completeIfCurrentAttempt so a stale worker's late rejection can never
  // overwrite a newer reclaimed attempt's state.
  rejectIfCurrentAttempt(
    id: string,
    attemptCount: number,
    rejectionCode: CartItemAddRejectionCode,
    rejectionMessage: string,
    now: Date,
  ): Promise<{ count: number }> {
    return this.prisma.cartItemAddAttempt.updateMany({
      where: { id, attemptCount, status: 'PROCESSING' },
      data: { status: 'REJECTED', rejectionCode, rejectionMessage, updatedAt: now },
    });
  }

  findById(id: string, client: PrismaClientOrTx = this.prisma): Promise<CartItemAddAttempt | null> {
    return client.cartItemAddAttempt.findUnique({ where: { id } });
  }
}
