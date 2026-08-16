import { CartReservationSyncBlockReason } from '@prisma/client';

import { ReservationEngineModeSnapshot } from '../../reservation-engine-mode/types/reservation-engine-mode.types';

// Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen plan). This is
// deliberately NOT ReservationGateway (checkout-reservation) - that
// interface is admission-shaped (DRAINING makes zero calls, unconditionally
// refusing new customer demand). Recovery never admits anything; it
// re-derives desired state from the current CartItem and repairs whichever
// system is currently authoritative to match it. In DRAINING specifically,
// a reserve-shaped target can only ever represent pre-existing durable
// intent (CartService's own admission gate already makes it structurally
// impossible for a new positive-desiredQuantity CartItem mutation to occur
// while DRAINING), but this port still routes it to BLOCKED rather than
// writing through - see ReservationRecoveryConvergenceService's own
// DRAINING-reserve comment for why.
export interface ReservationRecoveryTarget {
  converge(input: ReservationRecoveryConvergenceInput): Promise<ReservationRecoveryConvergenceResult>;
}

export interface ReservationRecoveryConvergenceInput {
  cartId: string;
  productId: string;
  // Required when desiredQuantity is non-null (reserve-shaped); must be
  // null when desiredQuantity is null (release-shaped). Callers derive this
  // from CURRENT durable cart ownership (Cart.customerId), never from a
  // stale marker diagnostic - see CartReservationSyncRecoveryService's own
  // customerId-authority comment.
  customerId: string | null;
  // null = desired state is "released/absent". Non-null = desired absolute
  // reservation quantity, always re-derived by the caller from the current
  // CartItem, never replayed from historical marker data.
  desiredQuantity: number | null;
}

// Every branch carries the complete mode identity converge() chose the
// write against (both revisionId and revision - see
// ReservationEngineModeSnapshot's own comment on why both, together, are
// the fencing signal) so the caller can later prove, under the shared
// advisory lock, that nothing has changed before ever treating a CONVERGED
// outcome as resolved.
export type ReservationRecoveryConvergenceResult =
  | { outcome: 'CONVERGED'; observedMode: ReservationEngineModeSnapshot }
  | {
      outcome: 'BLOCKED';
      blockReason: CartReservationSyncBlockReason;
      observedMode: ReservationEngineModeSnapshot;
    }
  | {
      outcome: 'RETRY';
      reasonCode: 'CHECKOUT_IN_PROGRESS' | 'UNKNOWN_INFRA_FAILURE';
      lastError: string | null;
      observedMode: ReservationEngineModeSnapshot;
    };

// CART_SCOPED activation-boundary gate (see the gate design review's
// direct-backfill design). The same three outcomes as the cart-scoped
// branch of ReservationRecoveryConvergenceResult, deliberately WITHOUT
// observedMode - the pre-cutover backfill/freshness sweep runs entirely
// while mode is still MIRROR (never CART_SCOPED), under the mutation
// barrier's own revision proof, not the mode-transition advisory lock;
// there is no "verify mode identity unchanged" step for it to feed, so
// carrying a snapshot here would be either misleading (a fabricated
// CART_SCOPED identity that was never actually current) or meaningless
// (echoing back MIRROR, which no caller needs).
//
// blockReason is narrowed to 'PRODUCT_SUSPECT' only, never the full
// CartReservationSyncBlockReason union: convergeCartScopedCore (the sole
// producer of this type) can never itself decide MODE_NOT_ADMITTING -
// that classification belongs entirely to converge()'s own outer
// DRAINING branch, which never delegates into convergeCartScopedCore in
// the first place. This is the type system proving convergeCartScopedCore
// really is a pure "given a target, converge it" primitive with no
// mode-policy opinion of its own.
export type DirectCartScopedConvergenceResult =
  | { outcome: 'CONVERGED' }
  | { outcome: 'BLOCKED'; blockReason: Extract<CartReservationSyncBlockReason, 'PRODUCT_SUSPECT'> }
  | { outcome: 'RETRY'; reasonCode: 'CHECKOUT_IN_PROGRESS' | 'UNKNOWN_INFRA_FAILURE'; lastError: string | null };
