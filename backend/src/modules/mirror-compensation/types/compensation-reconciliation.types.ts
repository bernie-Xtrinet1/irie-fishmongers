// Phase 16A.0-C4.3 (see ADR-007). Single-row entry points only -
// CompensationReconciliationService.attemptRecovery/recheckBlocked take
// one compensationId at a time; no batching (C4.4) or scheduling (C4.5)
// exists yet.
//
// RESOLVED_CONVERGED: the cart-scoped mirror now matches current
// Cart/CartItem desired state.
// RESOLVED_NO_LONGER_NEEDED_LEGACY: mode is LEGACY, the mirror was
// cleaned up (released) because the cart-scoped engine is retired, not
// because desired state was itself zero.
// REQUEUED_NEWER_DIVERGENCE: a concurrent recordMirrorDivergence arrival
// advanced generation past what this attempt/check observed - the claim
// was safely released, not a failure.
// RETRY_SCHEDULED: a transient failure (CHECKOUT_IN_PROGRESS or an
// infrastructure exception) will be retried per the bounded backoff
// schedule.
// BLOCKED_PRODUCT_SUSPECT / BLOCKED_MODE_NOT_ADMITTING: the row entered
// BLOCKED for a product-accounting or mode reason, respectively.
// UNBLOCKED_PENDING: recheckBlocked found the blocking condition cleared
// and moved the row back to PENDING.
// STALE_BLOCKED_CHECK: recheckBlocked's generation-gated write matched
// zero rows - a newer arrival superseded the check; nothing was mutated.
// PERMANENT_FAILURE: the attempt budget (MAX_RECOVERY_ATTEMPTS) was
// exhausted.
// ALREADY_RESOLVED: the row was already RESOLVED or PERMANENT_FAILURE.
// NOT_FOUND: no row exists with the given id.
// NOT_DUE: the row exists but was not actionable by the entry point
// called (e.g. attemptRecovery called against a BLOCKED row, or a
// PENDING row not yet due, or a PROCESSING row already claimed
// elsewhere).
export type ReconcileOneResult =
  | { outcome: 'RESOLVED_CONVERGED'; compensationId: string }
  | { outcome: 'RESOLVED_NO_LONGER_NEEDED_LEGACY'; compensationId: string }
  | { outcome: 'REQUEUED_NEWER_DIVERGENCE'; compensationId: string }
  | { outcome: 'RETRY_SCHEDULED'; compensationId: string; nextAttemptAt: Date }
  | { outcome: 'BLOCKED_PRODUCT_SUSPECT'; compensationId: string }
  | { outcome: 'BLOCKED_MODE_NOT_ADMITTING'; compensationId: string }
  | { outcome: 'UNBLOCKED_PENDING'; compensationId: string }
  | { outcome: 'STALE_BLOCKED_CHECK'; compensationId: string }
  | { outcome: 'PERMANENT_FAILURE'; compensationId: string }
  | { outcome: 'ALREADY_RESOLVED'; compensationId: string }
  | { outcome: 'NOT_FOUND'; compensationId: string }
  | { outcome: 'NOT_DUE'; compensationId: string };
