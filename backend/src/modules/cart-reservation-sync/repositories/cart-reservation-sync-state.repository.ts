import { Injectable } from '@nestjs/common';
import { CartReservationSyncState } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { PrismaClientOrTx } from '../../cart/repositories/cart.repository';

export interface AdvanceGenerationOutcome {
  count: number;
  generation: number | null;
}

// Phase 16A.0-DA, Unit DA.1A (see the DA.1 architecture review). Owns the
// durable CartReservationSyncState marker - the proactive record of what
// Redis reservation state a (cartId, productId) pair should converge to.
// One row per pair (@@unique([cartId, productId])), never deleted: `generation`
// is the permanent logical-generation counter for the pair's full lifetime,
// and it can only stay permanent if the row itself is permanent (see the
// schema-level comment for why CartItem.mutationVersion cannot serve this
// role on its own - it resets to 0 on every fresh insert).
//
// DA.1A uses upsertDesiredState (primary mutations), advanceIfCurrentGeneration
// (compensation, gated), and resolveIfCurrentGeneration (confirmed
// convergence, gated) - all synchronous, all within the same transaction as
// the CartItem mutation they accompany. Claiming for asynchronous recovery
// (status=PROCESSING, attemptCount, processingStartedAt) is DA.1B's concern -
// the columns already exist (this migration), but no primitive here reads or
// writes them yet.
@Injectable()
export class CartReservationSyncStateRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Unconditional upsert - always safe to call as the last step of any
  // primary CartItem-mutating transaction (add/update/remove; never a
  // compensation). Always advances generation and clears resolvedAt: a new
  // mutation's desired state is authoritative over whatever the previous
  // generation was converging toward, exactly matching
  // CartReservationCompensation's own "latest-wins arrival" precedent
  // (C4.2). Returns the resulting generation so the caller can use it as
  // the guard for resolveIfCurrentGeneration/advanceIfCurrentGeneration.
  async upsertDesiredState(
    cartId: string,
    productId: string,
    expectedMutationVersion: number,
    expectedQuantity: number | null,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ generation: number }> {
    const row = await client.cartReservationSyncState.upsert({
      where: { cartId_productId: { cartId, productId } },
      create: { cartId, productId, expectedMutationVersion, expectedQuantity },
      update: {
        expectedMutationVersion,
        expectedQuantity,
        status: 'PENDING',
        generation: { increment: 1 },
        resolvedAt: null,
        lastError: null,
      },
    });
    return { generation: row.generation };
  }

  // The compensation-path gate (Phase 16A.0-DA, Unit DA.1A - see the DA.1
  // architecture review's ABA-across-delete/recreate correction). Guarded
  // on the marker's own permanent generation, never on CartItem.mutationVersion
  // (which can numerically coincide with an unrelated later row after a
  // delete/recreate cycle). A caller must check this BEFORE touching
  // CartItem for a compensation - if it misses, the CartItem-level
  // operation must never be attempted, since a miss means a newer
  // mutation has already superseded the state being compensated.
  async advanceIfCurrentGeneration(
    cartId: string,
    productId: string,
    expectedGeneration: number,
    newExpectedMutationVersion: number,
    newExpectedQuantity: number | null,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<AdvanceGenerationOutcome> {
    const result = await client.cartReservationSyncState.updateMany({
      where: { cartId, productId, generation: expectedGeneration },
      data: {
        expectedMutationVersion: newExpectedMutationVersion,
        expectedQuantity: newExpectedQuantity,
        status: 'PENDING',
        generation: { increment: 1 },
        resolvedAt: null,
        lastError: null,
      },
    });
    if (result.count === 0) {
      return { count: 0, generation: null };
    }
    const row = await client.cartReservationSyncState.findUniqueOrThrow({
      where: { cartId_productId: { cartId, productId } },
    });
    return { count: result.count, generation: row.generation };
  }

  // Confirms convergence - sets resolvedAt, never deletes the row (the row
  // must persist to keep generation permanent for the pair's lifetime).
  // Guarded on generation: a mismatch means a newer mutation already
  // superseded this generation, so resolving it now would incorrectly
  // mark stale, unconfirmed state as converged - the row is left
  // untouched instead.
  resolveIfCurrentGeneration(
    cartId: string,
    productId: string,
    expectedGeneration: number,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cartReservationSyncState.updateMany({
      where: { cartId, productId, generation: expectedGeneration },
      data: { resolvedAt: new Date() },
    });
  }

  // Phase 16A.0-DA, Unit DA.1A (concurrency-proof correction). reserve/
  // release are unconditioned, non-CAS Redis primitives (plain HSET/HDEL) -
  // a stale, slow write can physically complete AFTER a newer one and
  // silently overwrite it, with no error and no way for the caller to
  // detect it from the Redis call's own return value alone. This is called
  // whenever a caller's own just-completed Redis write's matching
  // resolveIfCurrentGeneration call misses (proving a newer mutation has
  // since advanced past the generation that write was for) - since the
  // caller cannot prove their own write didn't just corrupt Redis, nothing
  // may be left claiming confirmed convergence. Unconditional (not
  // generation-gated): it must apply to whatever the CURRENT row is,
  // because the point is "an unproven write may have just landed against
  // current Redis state" - the caller has no valid generation to guard
  // with at this point, only the knowledge that its own write already
  // physically happened. Idempotent and safe to call redundantly.
  markUnresolved(
    cartId: string,
    productId: string,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cartReservationSyncState.updateMany({
      where: { cartId, productId },
      data: { status: 'PENDING', resolvedAt: null },
    });
  }

  findByCartAndProduct(
    cartId: string,
    productId: string,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<CartReservationSyncState | null> {
    return client.cartReservationSyncState.findUnique({
      where: { cartId_productId: { cartId, productId } },
    });
  }
}
