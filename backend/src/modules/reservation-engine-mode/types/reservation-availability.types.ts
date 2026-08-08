// Phase 16A.0-C, Unit C2 (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md).
// Additive and unwired - nothing calls ReservationAvailabilityService yet.
// CartService/ProductsService are unmodified; the mode-specific "final
// authority matrix" this type encodes lives only here until a later unit
// wires a caller to it.

// STRUCTURE_DRIFT_CONFIRMED means InventoryReservationsService's existing
// product suspect flag (productSuspectKey) is already set - i.e. either
// flagMalformedReservation (write-time) or reconcileProductReservedTotal
// finding UNDERCOUNT (a completed reconciliation pass) has already recorded
// a concrete reservation-integrity problem for this product. It is never
// used for a transient read failure - a thrown error from the comparison
// read maps to COMPARISON_UNAVAILABLE instead. The two causes are
// deliberately not conflated: one means "we know something is wrong", the
// other means "we don't know anything right now".
export type MirrorComparison =
  | { status: 'AVAILABLE'; available: number }
  | { status: 'COMPARISON_UNAVAILABLE' }
  | { status: 'STRUCTURE_DRIFT_CONFIRMED' };

// The mode-specific "final authority matrix" (ADR-007 Decision 6,
// corrected during C2 planning): each mode owns exactly one admission
// authority, never a sum of two systems' signals.
// - LEGACY: legacy is authoritative; the new engine is never read.
// - MIRROR: legacy remains authoritative for customer admission; the new
//   engine is observed only for a non-blocking mirrorComparison that can
//   never alter `available`.
// - CART_SCOPED: the new engine is authoritative; legacy is never read.
// - DRAINING: neither system admits new reservations at all.
export type ReservationAvailabilityResult =
  | { ok: true; mode: 'LEGACY'; source: 'LEGACY'; available: number }
  | {
      ok: true;
      mode: 'MIRROR';
      source: 'LEGACY';
      available: number;
      mirrorComparison: MirrorComparison;
    }
  | { ok: true; mode: 'CART_SCOPED'; source: 'CART_SCOPED'; available: number }
  | { ok: false; mode: 'DRAINING'; code: 'MODE_NOT_ADMITTING' }
  | { ok: false; code: 'RESERVATION_STRUCTURE_DRIFT' }
  | { ok: false; code: 'INVALID_INPUT'; field: string; reason: string };
