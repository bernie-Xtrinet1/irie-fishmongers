// Phase 16A.0-DA, Unit DA.1B (see the DA.1B claim-fencing review), extended
// in Unit DA.4B (see the DA.4B frozen plan) with mode-aware CART_SCOPED/
// DRAINING recovery. Two single-row entry points share this one outcome
// union - CartReservationSyncRecoveryService.reconcileOne (claim + converge
// + terminal resolution) and recheckBlocked (the BLOCKED-precondition
// recheck, which never claims) - mirroring
// CompensationReconciliationService/CompensationBlockedRecheckService's own
// established precedent of one shared result shape across both entry
// points. runBatch (DA.1B) fans out over a bounded candidate snapshot,
// dispatching each candidate to whichever entry point its status calls for.
//
// RESOLVED_CONVERGED: the recovery target now matches the current durable
// CartItem truth for this pair, the mode identity converge() chose the
// write against was still current when re-checked under the shared
// advisory lock, and the claim (generation + attemptCount + PROCESSING)
// was still current when that was confirmed - all three conditions, the
// same transaction.
// REQUEUED_RETRYABLE_FAILURE: the write itself was ambiguous (a thrown
// exception, or a typed CHECKOUT_IN_PROGRESS retry) - the claim was
// released back to PENDING with a sanitized lastError, immediately
// eligible again (no persisted backoff for this case).
// REQUEUED_SUPERSEDED: the write converged, but a customer mutation
// advanced the marker's generation while it was in flight - the worker's
// own claim is provably fenced out, and DA.1A's conservative
// markUnresolved rule was applied so a possibly-corrupting stale write can
// never leave the newer generation falsely resolved.
// REQUEUED_MODE_CHANGED: the write converged and the claim (generation +
// attemptCount) was still current, but the mode identity converge() chose
// the write against is no longer current, re-checked under the shared
// advisory lock setMode() itself holds exclusively - the claim was
// released back to PENDING; the next attempt re-derives desired state and
// targets whichever system is now authoritative. This is the DA.4B
// mode-race fence: without it, a write chosen under a stale mode could be
// falsely marked resolved after a transition already moved authority
// elsewhere.
// BLOCKED_PRODUCT_SUSPECT / BLOCKED_MODE_NOT_ADMITTING: converge() reports
// the write cannot proceed right now (product accounting is untrustworthy,
// or DRAINING refuses a reserve-shaped target) - the claim transitions to
// BLOCKED (fenced identically to a terminal resolution), consuming the
// attempt that was already claimed, awaiting the next periodic recheck.
// UNBLOCKED_PENDING: recheckBlocked found the precondition has cleared (or
// desired state re-derived to release-shaped, never blocked) - the row
// returns to PENDING, eligible for the very next pass. Consumes zero
// recovery attempts.
// STALE_BLOCKED_CHECK: recheckBlocked's generation-fenced transition
// missed - a customer mutation superseded the block while it was pending
// recheck. Consumes zero recovery attempts.
// STALE_CLAIM: the worker's claim was reclaimed by another worker (only
// attemptCount moved, not generation) before this attempt's terminal
// write - the fenced-out worker performs no further DB write at all.
// ALREADY_RESOLVED: the row already has resolvedAt set.
// ALREADY_CLAIMED: claimForRecovery missed because another worker
// currently holds a not-yet-stale PROCESSING claim.
// NOT_DUE: recheckBlocked was called against a row that is not currently
// BLOCKED - defensive; should not occur given runBatch dispatches by the
// row's own just-read status.
// NOT_FOUND: no row exists with the given id.
export type ReconcileOneOutcome =
  | { outcome: 'RESOLVED_CONVERGED'; markerId: string }
  | { outcome: 'REQUEUED_RETRYABLE_FAILURE'; markerId: string }
  | { outcome: 'REQUEUED_SUPERSEDED'; markerId: string }
  | { outcome: 'REQUEUED_MODE_CHANGED'; markerId: string }
  | { outcome: 'BLOCKED_PRODUCT_SUSPECT'; markerId: string }
  | { outcome: 'BLOCKED_MODE_NOT_ADMITTING'; markerId: string }
  | { outcome: 'UNBLOCKED_PENDING'; markerId: string }
  | { outcome: 'STALE_BLOCKED_CHECK'; markerId: string }
  | { outcome: 'STALE_CLAIM'; markerId: string }
  | { outcome: 'ALREADY_RESOLVED'; markerId: string }
  | { outcome: 'ALREADY_CLAIMED'; markerId: string }
  | { outcome: 'NOT_DUE'; markerId: string }
  | { outcome: 'NOT_FOUND'; markerId: string };

export interface RunBatchInput {
  now: Date;
  // Optional - CartReservationSyncRecoveryService applies
  // DEFAULT_RECOVERY_BATCH_SIZE when omitted. Validated against
  // MAX_RECOVERY_BATCH_SIZE, never silently clamped.
  limit?: number;
}

// Every counter is derived directly from a real ReconcileOneOutcome - no
// invented metric exists here that reconcileOne/recheckBlocked don't
// already report. candidatesFound/attempted are currently always equal
// (every selected candidate is processed exactly once per invocation, see
// runBatch's snapshot-then-process contract) - kept separate so a future
// bounded-time or partial-processing policy would not be a breaking type
// change.
export interface RunBatchCounters {
  resolvedConverged: number;
  requeuedRetryableFailure: number;
  requeuedSuperseded: number;
  requeuedModeChanged: number;
  blocked: number; // BLOCKED_PRODUCT_SUSPECT + BLOCKED_MODE_NOT_ADMITTING
  unblocked: number; // UNBLOCKED_PENDING
  staleBlockedCheck: number;
  staleClaim: number;
  skipped: number; // ALREADY_RESOLVED + ALREADY_CLAIMED + NOT_DUE + NOT_FOUND
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
