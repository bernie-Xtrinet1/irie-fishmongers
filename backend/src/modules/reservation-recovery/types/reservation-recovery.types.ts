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
