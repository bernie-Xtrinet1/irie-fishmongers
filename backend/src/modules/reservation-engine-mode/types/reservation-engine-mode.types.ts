import { ReservationEngineMode } from '@prisma/client';

// Phase 16A.0-C, Unit C1 (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md,
// Decision 8). Additive and unwired - nothing reads the current mode or
// calls setMode yet.

export interface SetReservationEngineModeInput {
  targetMode: ReservationEngineMode;
  updatedById: string;
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
export type SetReservationEngineModeResult =
  | { ok: true; id: string; mode: ReservationEngineMode; createdAt: Date }
  | { ok: false; code: 'INVALID_TRANSITION'; from: ReservationEngineMode; to: ReservationEngineMode }
  | { ok: false; code: 'ROLLBACK_BLOCKED'; outstandingProductIds: string[] }
  | { ok: false; code: 'ROLLBACK_STRUCTURE_DRIFT'; structureDriftProductIds: string[] };

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
