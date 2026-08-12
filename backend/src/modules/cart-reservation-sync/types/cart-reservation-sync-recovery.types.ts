// Phase 16A.0-DA, Unit DA.1B (see the DA.1B claim-fencing review).
// Single-row entry point only - CartReservationSyncRecoveryService.reconcileOne
// takes one markerId at a time; runBatch (same unit) fans out over a bounded
// candidate snapshot. No scheduling exists yet.
//
// RESOLVED_CONVERGED: Redis now matches the current durable CartItem truth
// for this pair, and the claim (generation + attemptCount + PROCESSING) was
// still current when that was confirmed.
// REQUEUED_RETRYABLE_FAILURE: the Redis write itself threw (an ambiguous,
// possibly-applied outcome) - the claim was released back to PENDING with a
// sanitized lastError, immediately eligible again (no persisted backoff).
// REQUEUED_SUPERSEDED: the Redis write returned success, but a customer
// mutation advanced the marker's generation while it was in flight - the
// worker's own claim is provably fenced out (its captured generation can
// never match again), and DA.1A's conservative markUnresolved rule was
// applied so a possibly-corrupting stale write can never leave the newer
// generation falsely resolved.
// STALE_CLAIM: the worker's claim was reclaimed by another worker (only
// attemptCount moved, not generation) before this attempt's terminal write -
// the fenced-out worker performs no further DB write at all; the newer
// worker owns the row's resolution.
// ALREADY_RESOLVED: claimForRecovery missed because the row already has
// resolvedAt set.
// ALREADY_CLAIMED: claimForRecovery missed because another worker currently
// holds a not-yet-stale PROCESSING claim.
// NOT_FOUND: no row exists with the given id.
export type ReconcileOneOutcome =
  | { outcome: 'RESOLVED_CONVERGED'; markerId: string }
  | { outcome: 'REQUEUED_RETRYABLE_FAILURE'; markerId: string }
  | { outcome: 'REQUEUED_SUPERSEDED'; markerId: string }
  | { outcome: 'STALE_CLAIM'; markerId: string }
  | { outcome: 'ALREADY_RESOLVED'; markerId: string }
  | { outcome: 'ALREADY_CLAIMED'; markerId: string }
  | { outcome: 'NOT_FOUND'; markerId: string };

export interface RunBatchInput {
  now: Date;
  // Optional - CartReservationSyncRecoveryService applies
  // DEFAULT_RECOVERY_BATCH_SIZE when omitted. Validated against
  // MAX_RECOVERY_BATCH_SIZE, never silently clamped.
  limit?: number;
}

// Every counter is derived directly from a real ReconcileOneOutcome - no
// invented metric exists here that reconcileOne doesn't already report.
// candidatesFound/attempted are currently always equal (every selected
// candidate is processed exactly once per invocation, see runBatch's
// snapshot-then-process contract) - kept separate so a future bounded-time
// or partial-processing policy would not be a breaking type change.
export interface RunBatchCounters {
  resolvedConverged: number;
  requeuedRetryableFailure: number;
  requeuedSuperseded: number;
  staleClaim: number;
  skipped: number; // ALREADY_RESOLVED + ALREADY_CLAIMED + NOT_FOUND
}

export interface RunBatchReconciliationResult {
  candidatesFound: number;
  attempted: number;
  counters: RunBatchCounters;
  // Only unexpected thrown exceptions land here - never a normal
  // ReconcileOneOutcome. At most one entry per candidate
  // (errors.length <= candidatesFound), message always sanitized, never a
  // raw exception object.
  errors: { markerId: string; message: string | null }[];
  durationMs: number;
}

// Matches CompensationBatchService's own established
// {ok:false, code:'INVALID_INPUT', field, reason} validation-failure shape -
// one project-consistent pattern for every batch service boundary.
export type RunBatchResult =
  | { ok: true; result: RunBatchReconciliationResult }
  | { ok: false; code: 'INVALID_INPUT'; field: string; reason: string };
