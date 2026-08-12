import { Injectable } from '@nestjs/common';
import { CartReservationSyncState } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { PrismaClientOrTx } from '../../cart/repositories/cart.repository';

export interface AdvanceGenerationOutcome {
  count: number;
  generation: number | null;
}

// Phase 16A.0-DA, Unit DA.1B (see the DA.1B claim-fencing review). The
// recovery worker's stale-PROCESSING reclaim window - identical value to
// mirror-compensation's own PROCESSING_STALE_TIMEOUT_MS, but defined
// independently here rather than imported: these are two unrelated
// recovery subsystems that happen to agree on a cadence, not a shared
// dependency.
export const PROCESSING_STALE_TIMEOUT_MS = 5 * 60 * 1000;

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

  // --- Phase 16A.0-DA, Unit DA.1B (recovery worker; see the DA.1B
  // claim-fencing review). attemptCount is the claim-fencing token: it is
  // monotonic and never reset (unlike CartItem.mutationVersion, which
  // resets on delete/recreate - see the DA.1 architecture review's ABA
  // finding), so a stale worker's captured (generation, attemptCount)
  // pair can never coincidentally match again once superseded, whether by
  // a customer mutation (generation moves) or by another worker's
  // stale-PROCESSING reclaim (attemptCount moves, generation does not). ---

  findById(id: string, client: PrismaClientOrTx = this.prisma): Promise<CartReservationSyncState | null> {
    return client.cartReservationSyncState.findUnique({ where: { id } });
  }

  // Read-only, bounded, no locking (see the DA.1B review's Section 14 -
  // "do not add SKIP LOCKED reflexively", mirroring
  // CompensationRepository.findBatchCandidateIds's own proven precedent).
  // resolvedAt IS NULL is the sole correctness selector (Section 3's
  // mandatory source-of-truth rule: a resolved row is never a recovery
  // candidate, regardless of status). No nextAttemptAt/backoff column
  // exists on this table by design (Section 7/15) - a PENDING unresolved
  // row is always immediately eligible; only a PROCESSING row has a time
  // gate at all (the stale-reclaim cutoff).
  //
  // Timestamp binding: these columns are Postgres `timestamp without time
  // zone` (same native type as CartReservationCompensation's, confirmed by
  // that table's own regression-test comment). Binding a native JS Date
  // directly would send it as timestamptz and let Postgres silently shift
  // it by the session's non-UTC offset when compared against a naive
  // column - the staleCutoff boundary is passed as an ISO string cast to
  // ::timestamp instead, never a raw Date, matching
  // CompensationRepository.findBatchCandidateIds's own established fix.
  async findRecoveryCandidateIds(
    now: Date,
    limit: number,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ id: string }[]> {
    const staleCutoffIso = new Date(now.getTime() - PROCESSING_STALE_TIMEOUT_MS).toISOString();
    return client.$queryRaw<{ id: string }[]>`
      SELECT "id"
      FROM "cart_reservation_sync_states"
      WHERE "resolvedAt" IS NULL
        AND (
          "status" = 'PENDING'
          OR ("status" = 'PROCESSING' AND "processingStartedAt" < ${staleCutoffIso}::timestamp)
        )
      ORDER BY
        CASE
          WHEN "status" = 'PROCESSING'
            THEN "processingStartedAt" + (${PROCESSING_STALE_TIMEOUT_MS} * INTERVAL '1 millisecond')
          ELSE "createdAt"
        END ASC,
        "id" ASC
      LIMIT ${limit}
    `;
  }

  // The single claim path for both an ordinary unresolved PENDING row and
  // a stale PROCESSING row whose worker crashed before resolving -
  // contractual, not a fallback (mirrors
  // CompensationRepository.claimForRecoveryAttempt). resolvedAt: null is
  // included defensively even though candidate discovery already filters
  // on it - every primitive here is self-contained, never relying solely
  // on the caller's own pre-filtering. Never touches generation: claiming
  // is purely a worker-ownership concern, orthogonal to the pair's
  // logical desired-state identity (Section 1/2 of the DA.1B review).
  // Returns the claimed row (including the post-increment attemptCount)
  // so the caller can capture its own claimedGeneration/claimedAttemptCount
  // fencing pair, or null if nothing was claimed.
  async claimForRecovery(
    id: string,
    now: Date,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<CartReservationSyncState | null> {
    const staleCutoff = new Date(now.getTime() - PROCESSING_STALE_TIMEOUT_MS);
    const result = await client.cartReservationSyncState.updateMany({
      where: {
        id,
        resolvedAt: null,
        OR: [{ status: 'PENDING' }, { status: 'PROCESSING', processingStartedAt: { lt: staleCutoff } }],
      },
      data: { status: 'PROCESSING', processingStartedAt: now, attemptCount: { increment: 1 } },
    });
    if (result.count === 0) {
      return null;
    }
    return client.cartReservationSyncState.findUniqueOrThrow({ where: { id } });
  }

  // Fenced by BOTH generation and attemptCount, plus status='PROCESSING' -
  // a stale worker whose claim was reclaimed (attemptCount moved) or whose
  // target was superseded by a customer mutation (generation moved) can
  // never match this predicate again, so it can never resolve a claim it
  // no longer owns. Clears lastError on success (Section 12) and
  // normalizes processingStartedAt back to null when leaving PROCESSING.
  resolveClaimIfCurrent(
    id: string,
    claimedGeneration: number,
    claimedAttemptCount: number,
    resolvedAt: Date,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cartReservationSyncState.updateMany({
      where: { id, generation: claimedGeneration, attemptCount: claimedAttemptCount, status: 'PROCESSING' },
      data: { status: 'PENDING', resolvedAt, processingStartedAt: null, lastError: null },
    });
  }

  // Same fencing predicate as resolveClaimIfCurrent, used for both a
  // genuinely retryable Redis failure and a superseded-mid-flight
  // requeue. Deliberately NOT an ungated release (see the DA.1B review's
  // Section 3): an ungated release-by-id could reset a NEWER worker's
  // legitimate, still-fresh PROCESSING claim back to PENDING purely
  // because a stale caller's own claim was reclaimed out from under it -
  // this predicate makes that structurally impossible, since a fenced-out
  // caller's (generation, attemptCount) pair can never match the row's
  // current values again. A zero-count result means the caller has been
  // fenced out entirely; it must not attempt any further write.
  releaseClaimIfCurrent(
    id: string,
    claimedGeneration: number,
    claimedAttemptCount: number,
    sanitizedLastError: string | null,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cartReservationSyncState.updateMany({
      where: { id, generation: claimedGeneration, attemptCount: claimedAttemptCount, status: 'PROCESSING' },
      data: { status: 'PENDING', lastError: sanitizedLastError, processingStartedAt: null },
    });
  }

  // Checkout-clear correction (see the DA.1B final review's repository-wide
  // mutation invariant audit). The desired-absence counterpart to
  // upsertDesiredState for a bulk removal: every production mutation that
  // changes CartItem existence or quantity for a (cartId, productId) pair
  // must atomically advance generation in the SAME transaction as that
  // mutation - this was the one gap the audit found (OrdersService's
  // checkout-clear bulk delete never touched this table at all). This is
  // deliberately just a loop over the exact same unconditional
  // upsertDesiredState every other primary mutation already uses - never a
  // bespoke second write path or a second generation mechanism.
  // mutationVersion is diagnostic-only here, exactly as everywhere else in
  // this contract - the caller's already-known pre-clear value is
  // sufficient; no fresh CartItem read is required or performed.
  async advanceForClearedCart(
    cartId: string,
    items: { productId: string; mutationVersion: number }[],
    client: PrismaClientOrTx = this.prisma,
  ): Promise<void> {
    for (const item of items) {
      await this.upsertDesiredState(cartId, item.productId, item.mutationVersion, null, client);
    }
  }
}
