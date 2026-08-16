import { ReservationEngineMode } from '@prisma/client';

// Phase 16A.0-C, Unit C1 (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md,
// Decision 8). Additive and unwired - nothing reads the current mode or
// calls setMode yet.

// CART_SCOPED activation-boundary gate (see the gate design review's final
// atomic-freshness design). The exact, frozen proof setMode() re-verifies
// atomically, under TRANSITION_LOCK_KEY, before ever authorizing
// MIRROR -> CART_SCOPED. Canonically defined here (the module that
// verifies it), not in cart-scoped-backfill (which only produces it via
// CartScopedBackfillService.buildAttestation) - the consumer owns the
// contract, the producer imports it. barrierRevision/targetCount are the
// two backlog/target-completeness authorization inputs; minimumExpiresAt
// is the freshness bound (epoch ms, Node clock domain - see
// InventoryReservationsService.reserveWithFreshEpoch's own comment on why
// this is never Redis/Postgres time); completedAt is informational/
// logging only, never itself compared against anything.
export interface CutoverAttestation {
  barrierRevision: number;
  targetCount: number;
  minimumExpiresAt: number;
  completedAt: number;
}

export interface SetReservationEngineModeInput {
  targetMode: ReservationEngineMode;
  updatedById: string;
  // Required if and only if targetMode is CART_SCOPED - setMode() rejects
  // with CUTOVER_ATTESTATION_REQUIRED otherwise. Never meaningful for any
  // other transition.
  cutoverAttestation?: CutoverAttestation;
}

// The state-transition table lives in ADR-007, not restated here beyond
// what the types need: LEGACY<->MIRROR, MIRROR->CART_SCOPED,
// CART_SCOPED<->DRAINING, DRAINING->LEGACY (gated). Every other pair is
// INVALID_TRANSITION, including a same-mode "transition" - the table has
// no self-loops. ROLLBACK_STRUCTURE_DRIFT takes priority over
// ROLLBACK_BLOCKED whenever both would apply - a disagreement between the
// two independent rollback signals is a data-integrity concern, not
// merely "wait longer for holds to expire" (see ADR-007 Decision 8's
// "outstanding reservations vs. data-structure drift" distinction).
// CART_SCOPED activation-boundary gate. Six new failure codes, one per
// hard-blocking precondition verified atomically inside the same locked
// transaction (see ReservationEngineModeService.setMode's own comment for
// the exact check order) - mirroring the existing ROLLBACK_BLOCKED/
// ROLLBACK_STRUCTURE_DRIFT precedent rather than collapsing them into one
// generic failure, so a caller/operator can distinguish exactly which
// precondition failed without parsing a message string.
export type SetReservationEngineModeResult =
  | { ok: true; id: string; mode: ReservationEngineMode; createdAt: Date }
  | { ok: false; code: 'INVALID_TRANSITION'; from: ReservationEngineMode; to: ReservationEngineMode }
  | { ok: false; code: 'ROLLBACK_BLOCKED'; outstandingProductIds: string[] }
  | { ok: false; code: 'ROLLBACK_STRUCTURE_DRIFT'; structureDriftProductIds: string[] }
  | { ok: false; code: 'CUTOVER_ATTESTATION_REQUIRED' }
  | { ok: false; code: 'CUTOVER_BARRIER_REVISION_MISMATCH' }
  | { ok: false; code: 'CUTOVER_SYNC_BACKLOG'; unresolvedCount: number }
  | { ok: false; code: 'CUTOVER_COMPENSATION_BACKLOG'; unresolvedCount: number }
  | { ok: false; code: 'CUTOVER_TARGET_COUNT_MISMATCH'; expected: number; actual: number }
  | { ok: false; code: 'CUTOVER_BACKFILL_STALE' };

// Verifies rollback safety using two independent Redis signals - the
// aggregated product-total keys (inv:reserved:product-total:{*}) and the
// cart-scoped reservation index (inv:reserved:cart-index:{*}), each
// walked and liveness-checked separately (see ADR-007 Decision 8).
// - outstandingProductIds: flagged consistently by both signals - a
//   genuine, currently-live hold. This alone blocks rollback
//   (ROLLBACK_BLOCKED).
// - structureDriftProductIds: the two signals disagree for this product
//   (flagged by exactly one, not both) - the product-total projection
//   and the cart-scoped index no longer agree on reality. This is a
//   distinct, more urgent condition than an ordinary outstanding hold -
//   it means one of the two structures is wrong, not just that
//   reservations haven't expired yet - and is reported as
//   ROLLBACK_STRUCTURE_DRIFT, never silently folded into "holds
//   outstanding".
export interface RollbackVerificationResult {
  clear: boolean;
  outstandingProductIds: string[];
  structureDriftProductIds: string[];
}

// Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen plan). The complete
// persisted transition identity a recovery attempt chose a write against -
// both fields together, never revisionId alone: revisionId (a random UUID)
// has identity but no ordering value of its own once compared, and
// revision (the monotonic sequence value) is the actual fencing signal:
// comparing both is redundant-but-cheap defense in depth, since revision
// alone is already unique per row by construction.
//
// The implicit default - no ReservationEngineModeConfig row exists yet, so
// the effective mode is LEGACY - is a real, comparable identity of its own:
// { mode: 'LEGACY', revisionId: null, revision: null }. This is not a
// missing-data placeholder; it is what getCurrentModeSnapshot returns
// before the first setMode() call ever happens, and verifyModeRevisionUnchanged
// treats it exactly like any other snapshot - if the very first transition
// commits between two reads, revisionId/revision moving from null to a
// real value is detected as a change like any other.
export interface ReservationEngineModeSnapshot {
  mode: ReservationEngineMode;
  revisionId: string | null;
  revision: number | null;
}
