// Phase 16A.0-C4.4 (see ADR-007). CompensationBatchService.runBatch's
// input/output shapes. This layer knows nothing about reconciliation
// internals - it dispatches by status only and aggregates the
// already-typed ReconcileOneResult outcomes it receives back.

export interface RunBatchInput {
  now: Date;
  // Optional - CompensationBatchService applies DEFAULT_BATCH_SIZE when
  // omitted. Validated against MAX_BATCH_SIZE, never silently clamped.
  limit?: number;
}

// Every field is derived directly from a real ReconcileOneResult outcome
// (see the mapping table in CompensationBatchService) - no invented
// metric exists here that the single-row services don't already report.
//
// candidatesFound / attempted are currently always equal (this
// implementation processes every selected candidate to completion, never
// short-circuits) - kept as separate fields so a future bounded-time or
// partial-processing policy would not be a breaking type change.
export interface BatchReconciliationResult {
  candidatesFound: number;
  attempted: number;
  resolved: number; // RESOLVED_CONVERGED + RESOLVED_NO_LONGER_NEEDED_LEGACY
  requeued: number; // REQUEUED_NEWER_DIVERGENCE
  retryScheduled: number; // RETRY_SCHEDULED
  blocked: number; // BLOCKED_PRODUCT_SUSPECT + BLOCKED_MODE_NOT_ADMITTING
  unblocked: number; // UNBLOCKED_PENDING
  permanentFailure: number; // PERMANENT_FAILURE
  staleBlockedCheck: number; // STALE_BLOCKED_CHECK
  skipped: number; // ALREADY_RESOLVED + NOT_DUE + NOT_FOUND
  // Only unexpected thrown exceptions land here - never a normal
  // ReconcileOneResult outcome. At most one entry per candidate
  // (errors.length <= candidatesFound), message always sanitized, never
  // a raw exception object or raw lastError.
  errors: Array<{ compensationId: string; message: string }>;
  durationMs: number;
}

// Matches CompensationService.recordMirrorDivergence's established
// validation-failure shape (C4.2) rather than a bespoke per-field code -
// one project-consistent {ok:false, code:'INVALID_INPUT', field, reason}
// pattern for every service boundary in this subsystem.
export type RunBatchResult =
  | { ok: true; result: BatchReconciliationResult }
  | { ok: false; code: 'INVALID_INPUT'; field: string; reason: string };
