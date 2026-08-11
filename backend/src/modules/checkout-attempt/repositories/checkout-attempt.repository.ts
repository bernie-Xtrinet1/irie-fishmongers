import { Injectable } from '@nestjs/common';
import { CheckoutAttempt, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { StaleCheckoutAttemptCursor } from '../types/checkout-attempt.types';

export type PrismaClientOrTx = PrismaService | Prisma.TransactionClient;

// Owns every access to prisma.checkoutAttempt (see Decision 8/§ "Repository
// ownership" - no other class in this codebase may query this table
// directly). Every conditional-transition method uses a single atomic
// updateMany (matching ProductsRepository.adjustStock's established
// idiom) and returns a plain { count } for CheckoutAttemptService to
// classify - never a read-then-write, never a thrown error for an
// ordinary "0 rows matched" outcome.
@Injectable()
export class CheckoutAttemptRepository {
  constructor(private readonly prisma: PrismaService) {}

  // The unique idempotencyKey constraint is the concurrency authority
  // (Decision 1): a plain create() is attempted first: if two callers
  // race, exactly one create() succeeds and the other observes Postgres's
  // P2002 unique-violation, at which point it re-reads the row the winner
  // just created. Never a find-then-create sequence, which would leave an
  // unguarded race window.
  async createOrGetByIdempotencyKey(input: {
    idempotencyKey: string;
    cartId: string;
    customerId: string;
    now: Date;
  }): Promise<{ attempt: CheckoutAttempt; created: boolean }> {
    try {
      const attempt = await this.prisma.checkoutAttempt.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          cartId: input.cartId,
          customerId: input.customerId,
          createdAt: input.now,
          updatedAt: input.now,
          lastHeartbeatAt: input.now,
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
        const existing = await this.prisma.checkoutAttempt.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (!existing) {
          throw new Error(
            `Internal consistency error: idempotencyKey unique constraint was violated for ` +
              `"${input.idempotencyKey}" but no row was found on re-read`,
          );
        }
        return { attempt: existing, created: false };
      }
      throw error;
    }
  }

  findById(id: string, client: PrismaClientOrTx = this.prisma): Promise<CheckoutAttempt | null> {
    return client.checkoutAttempt.findUnique({ where: { id } });
  }

  // Phase 16A.0-D.2.1. Read-only - no write, no lastHeartbeatAt mutation.
  // idempotencyKey alone is sufficient to look up the row (it is globally
  // unique), but this is an internal persistence primitive only - the
  // caller (CheckoutAttemptService.inspectByIdempotencyKey) must
  // cross-check ownership before exposing anything about the result.
  findByIdempotencyKey(idempotencyKey: string): Promise<CheckoutAttempt | null> {
    return this.prisma.checkoutAttempt.findUnique({ where: { idempotencyKey } });
  }

  updateHeartbeatIfProcessing(id: string, customerId: string, now: Date): Promise<{ count: number }> {
    return this.prisma.checkoutAttempt.updateMany({
      where: { id, customerId, status: 'PROCESSING', lastHeartbeatAt: { lte: now } },
      data: { lastHeartbeatAt: now },
    });
  }

  // Requires an externally-owned transaction client - see Decision 2. This
  // method must never default to the plain injected PrismaService; a
  // caller forgetting to pass tx here would silently write outside the
  // order-creation transaction, exactly the bug ADR-007's hard requirement
  // exists to prevent.
  markCommitted(
    tx: Prisma.TransactionClient,
    id: string,
    customerId: string,
    orderId: string,
    now: Date,
  ): Promise<{ count: number }> {
    return tx.checkoutAttempt.updateMany({
      where: { id, customerId, status: 'PROCESSING' },
      data: { status: 'COMMITTED', orderId, updatedAt: now },
    });
  }

  markFailed(
    id: string,
    customerId: string,
    failureCode: string,
    failureMessage: string | null,
    now: Date,
  ): Promise<{ count: number }> {
    return this.prisma.checkoutAttempt.updateMany({
      where: { id, customerId, status: 'PROCESSING' },
      data: { status: 'FAILED', failureCode, failureMessage, updatedAt: now },
    });
  }

  // Keyset-paginated, per Decision 3's exact cursor formula - never
  // offset-based. Uses the additive [status, lastHeartbeatAt, id] index.
  findStaleProcessing(input: {
    heartbeatBefore: Date;
    cursor: StaleCheckoutAttemptCursor | null;
    limit: number;
  }): Promise<CheckoutAttempt[]> {
    return this.prisma.checkoutAttempt.findMany({
      where: {
        status: 'PROCESSING',
        lastHeartbeatAt: { lt: input.heartbeatBefore },
        ...(input.cursor
          ? {
              OR: [
                { lastHeartbeatAt: { gt: input.cursor.lastHeartbeatAt } },
                { lastHeartbeatAt: input.cursor.lastHeartbeatAt, id: { gt: input.cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ lastHeartbeatAt: 'asc' }, { id: 'asc' }],
      take: input.limit,
    });
  }
}
