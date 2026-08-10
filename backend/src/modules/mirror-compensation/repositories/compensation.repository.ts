import { Injectable } from '@nestjs/common';
import {
  CartReservationCompensation,
  CompensationBlockReason,
  CompensationOperation,
  CompensationReasonCode,
  CompensationStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export type PrismaClientOrTx = PrismaService | Prisma.TransactionClient;

export interface CreateCompensationInput {
  operation: CompensationOperation;
  cartId: string;
  productId: string;
  customerId: string | null;
  desiredQuantity: number | null;
  reasonCode: CompensationReasonCode;
  lastError: string | null;
}

// The complete latest-divergence diagnostic snapshot. Deduplication is by
// (cartId, productId) alone, independent of operation (see the schema
// comment) - so an accepted new divergence must overwrite every field
// that describes "what was most recently observed", not just
// reasonCode/lastError, or the row would end up in a self-contradictory
// state (e.g. operation:'RESERVE_MIRROR' but desiredQuantity from a since-
// superseded RELEASE_MIRROR arrival). operation/customerId/desiredQuantity
// remain historical diagnostic context only - the eventual reconciler
// (C4.3) never treats them as replay authority, it always re-derives
// desired state from current CartItem truth.
export interface DivergenceUpdateInput {
  operation: CompensationOperation;
  customerId: string | null;
  desiredQuantity: number | null;
  reasonCode: CompensationReasonCode;
  lastError: string | null;
  now: Date;
}

// Phase 16A.0-C4.3. blockReason (why a row is currently unable to
// proceed) is deliberately separate from reasonCode (the latest mirror/
// recovery divergence diagnostic) - see the schema comment. reasonCode is
// optional here because entering BLOCKED for a mode-blocking reason
// (MODE_NOT_ADMITTING) is not itself a new mirror-write diagnostic; it
// must not overwrite whatever real diagnostic reasonCode already holds.
export interface BlockCompensationInput {
  blockReason: CompensationBlockReason;
  reasonCode?: CompensationReasonCode;
  lastError: string | null;
  nextAttemptAt: Date;
}

// The diagnostic snapshot persisted alongside an ordinary (non-terminal)
// retry - keeps reasonCode/lastError current with what the reconciler
// actually just observed, matching the same latest-wins principle
// recordMirrorDivergence's arrivals already follow.
export interface RequeueAfterAttemptInput {
  reasonCode: CompensationReasonCode;
  lastError: string | null;
  nextAttemptAt: Date;
}

const UNRESOLVED_STATUSES: CompensationStatus[] = ['PENDING', 'PROCESSING', 'BLOCKED'];
const PROCESSING_STALE_TIMEOUT_MS = 5 * 60 * 1000;

// Shared budget for every bounded optimistic-retry loop in this
// subsystem (e.g. CompensationService.recordDivergence's create/find/
// conditional-update loop, C4.2) - defined once at the repository level
// so future callers reuse it rather than each hardcoding their own limit.
export const MAX_OPTIMISTIC_RETRIES = 3;

// Phase 16A.0-C4.1 (see ADR-007). Every conditional-transition method
// represents exactly one concrete state transition and returns a plain
// { count }, matching CheckoutAttemptRepository's established idiom - no
// method decides which transition to apply, that is CompensationService's
// job (C4.2/C4.3). generation is the sole concurrency counter (no
// separate "version" column exists). Additive and unwired - nothing
// outside this file's own tests calls any of it yet.
@Injectable()
export class CompensationRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    input: CreateCompensationInput,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<CartReservationCompensation> {
    return client.cartReservationCompensation.create({ data: { ...input, generation: 0 } });
  }

  // The partial unique index (migration SQL only, see the schema comment)
  // should guarantee at most one unresolved row for a given (cartId,
  // productId) pair - but this query stays deterministic even if that
  // invariant is ever violated by manual database corruption, rather than
  // depending on the database's own unspecified tie-break order. Multiple
  // matching rows is never a normal-operation outcome; oldest-first is
  // chosen only so behavior is reproducible if it ever happens.
  findUnresolvedByCartAndProduct(
    cartId: string,
    productId: string,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<CartReservationCompensation | null> {
    return client.cartReservationCompensation.findFirst({
      where: { cartId, productId, status: { in: UNRESOLVED_STATUSES } },
      orderBy: { createdAt: 'asc' },
    });
  }

  findById(id: string, client: PrismaClientOrTx = this.prisma): Promise<CartReservationCompensation | null> {
    return client.cartReservationCompensation.findUnique({ where: { id } });
  }

  // A new divergence arriving against a still-unresolved row: generation
  // always advances and the complete latest-divergence snapshot
  // (operation/customerId/desiredQuantity/reasonCode/lastError/
  // nextAttemptAt) is always latest-wins, status is never touched
  // (PENDING stays PENDING, PROCESSING stays PROCESSING,
  // BLOCKED+ACCOUNTING_UNDERFLOW stays BLOCKED). attemptCount,
  // blockedCheckCount, and createdAt are never touched by arrival.
  // Scoped to the still-unresolved-status guard, never `WHERE id` alone -
  // the row may have resolved between the caller's read and this write;
  // a zero-count result means the caller must retry its own create/dedup
  // sequence, never assume this succeeded.
  advanceGenerationPreservingStatus(
    id: string,
    input: DivergenceUpdateInput,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cartReservationCompensation.updateMany({
      where: { id, status: { in: UNRESOLVED_STATUSES } },
      data: {
        generation: { increment: 1 },
        operation: input.operation,
        customerId: input.customerId,
        desiredQuantity: input.desiredQuantity,
        reasonCode: input.reasonCode,
        lastError: input.lastError,
        nextAttemptAt: input.now,
      },
    });
  }

  // A new divergence arriving against a BLOCKED row with an ordinarily-
  // retryable reasonCode: unblocks atomically in the same write that
  // advances generation and overwrites the same latest-divergence
  // snapshot as advanceGenerationPreservingStatus - a row must not stay
  // blocked solely because an older divergence had a different blocking
  // reason. DRAINING remains authoritative regardless: if the subsequent
  // recovery attempt discovers mode is still DRAINING and desired
  // quantity > 0, the row is placed back into BLOCKED.
  advanceGenerationAndUnblock(
    id: string,
    input: DivergenceUpdateInput,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cartReservationCompensation.updateMany({
      where: { id, status: 'BLOCKED' },
      data: {
        generation: { increment: 1 },
        operation: input.operation,
        customerId: input.customerId,
        desiredQuantity: input.desiredQuantity,
        reasonCode: input.reasonCode,
        lastError: input.lastError,
        nextAttemptAt: input.now,
        status: 'PENDING',
        blockReason: null,
      },
    });
  }

  // The single claim path for both an ordinary due PENDING row and a
  // stale PROCESSING row whose worker crashed before resolving -
  // contractual, not a fallback. A stale reclaim consumes a real recovery
  // attempt, identical to any other claim.
  claimForRecoveryAttempt(
    id: string,
    now: Date,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    const staleCutoff = new Date(now.getTime() - PROCESSING_STALE_TIMEOUT_MS);
    return client.cartReservationCompensation.updateMany({
      where: {
        id,
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: now } },
          { status: 'PROCESSING', lastAttemptAt: { lt: staleCutoff } },
        ],
      },
      data: { status: 'PROCESSING', lastAttemptAt: now, attemptCount: { increment: 1 } },
    });
  }

  // Generation-gated: this is the one transition that claims "recovery is
  // complete for the state I observed." A zero-count result means a newer
  // divergence arrived mid-attempt - the caller must requeue
  // (requeueAfterAttemptIfGenerationMatches), never treat this as success.
  resolveIfGenerationMatches(
    id: string,
    claimedGeneration: number,
    now: Date,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cartReservationCompensation.updateMany({
      where: { id, status: 'PROCESSING', generation: claimedGeneration },
      data: { status: 'RESOLVED', resolvedAt: now },
    });
  }

  // Generation-gated for the same reason as resolveIfGenerationMatches -
  // giving up must not abandon a fresher divergence's own repair need. A
  // zero-count result means the caller must requeue instead of marking
  // permanent failure.
  markPermanentFailureIfGenerationMatches(
    id: string,
    claimedGeneration: number,
    now: Date,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cartReservationCompensation.updateMany({
      where: { id, status: 'PROCESSING', generation: claimedGeneration },
      data: { status: 'PERMANENT_FAILURE', permanentFailureAt: now },
    });
  }

  // Phase 16A.0-C4.3 correction: generation-gated, unlike an earlier
  // ungated form. An ordinary retry (RETRY_SCHEDULED) is not a terminal
  // transition, but it must still never let a stale worker delay a newer
  // generation using an old backoff schedule - a zero-count result means
  // a newer divergence superseded this attempt; the caller must release
  // the claim via the safe generation-advanced mechanism (see
  // CompensationReconciliationService) and report REQUEUED_NEWER_DIVERGENCE,
  // never RETRY_SCHEDULED. attemptCount is not touched here - it was
  // already incremented at claim.
  requeueAfterAttemptIfGenerationMatches(
    id: string,
    claimedGeneration: number,
    input: RequeueAfterAttemptInput,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cartReservationCompensation.updateMany({
      where: { id, status: 'PROCESSING', generation: claimedGeneration },
      data: {
        status: 'PENDING',
        reasonCode: input.reasonCode,
        lastError: input.lastError,
        nextAttemptAt: input.nextAttemptAt,
      },
    });
  }

  // Phase 16A.0-C4.3: the safe stale-claim release, distinct in purpose
  // from requeueAfterAttemptIfGenerationMatches and deliberately NOT
  // generation-gated - it exists precisely for the case where a
  // generation-gated call (resolve/block/permanentFailure/requeue) has
  // just returned a zero-count mismatch, meaning a concurrent
  // recordMirrorDivergence arrival advanced generation via
  // advanceGenerationPreservingStatus while this row was PROCESSING (that
  // method never touches status). The row is therefore provably still
  // PROCESSING and safe to release: this call makes no claim about
  // convergence and does not touch generation, reasonCode, or lastError -
  // the newer arrival already wrote the correct diagnostic snapshot, and
  // this call must never overwrite it. See
  // CompensationReconciliationService for the full proof. Never call this
  // for an ordinary (non-superseded) retry - that path is
  // requeueAfterAttemptIfGenerationMatches, which does persist a fresh
  // diagnostic and is generation-gated for its own reason.
  releaseStaleClaim(
    id: string,
    nextAttemptAt: Date,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cartReservationCompensation.updateMany({
      where: { id, status: 'PROCESSING' },
      data: { status: 'PENDING', nextAttemptAt },
    });
  }

  // Phase 16A.0-C4.3: the one transition that establishes BLOCKED for the
  // first time (create() always starts a row at PENDING). Generation-gated
  // for the same reason as
  // resolveIfGenerationMatches/markPermanentFailureIfGenerationMatches -
  // a zero-count result means a newer divergence arrived mid-attempt; the
  // caller must release the claim rather than treat this as having
  // established a block. Never touches generation/attemptCount/
  // blockedCheckCount/operation/customerId/desiredQuantity - see
  // BlockCompensationInput's doc comment for why reasonCode is optional.
  blockIfGenerationMatches(
    id: string,
    claimedGeneration: number,
    input: BlockCompensationInput,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cartReservationCompensation.updateMany({
      where: { id, status: 'PROCESSING', generation: claimedGeneration },
      data: {
        status: 'BLOCKED',
        blockReason: input.blockReason,
        ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
        lastError: input.lastError,
        nextAttemptAt: input.nextAttemptAt,
      },
    });
  }

  // Generation-gated to prevent a slow precondition check (e.g. a Redis
  // round trip to reconcileProductReservedTotal or getCurrentMode) from
  // clobbering a fresher arrival's already-correct state with a
  // conclusion computed from stale input - never because this transition
  // claims convergence. A zero-count result means the row was untouched;
  // its generation, reasonCode, and lastError are already whatever the
  // newer arrival correctly wrote.
  unblockIfGenerationMatches(
    id: string,
    observedGeneration: number,
    now: Date,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cartReservationCompensation.updateMany({
      where: { id, status: 'BLOCKED', generation: observedGeneration },
      data: { status: 'PENDING', nextAttemptAt: now, blockReason: null },
    });
  }

  // Same staleness-guard rationale as unblockIfGenerationMatches.
  // blockedCheckCount is entirely separate from attemptCount and never
  // feeds the attempt-based permanent-failure threshold.
  rescheduleBlockedCheckIfGenerationMatches(
    id: string,
    observedGeneration: number,
    nextAttemptAt: Date,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cartReservationCompensation.updateMany({
      where: { id, status: 'BLOCKED', generation: observedGeneration },
      data: { blockedCheckCount: { increment: 1 }, nextAttemptAt },
    });
  }
}
