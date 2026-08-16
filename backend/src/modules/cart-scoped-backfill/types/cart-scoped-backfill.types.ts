import { CutoverAttestation } from '../../reservation-engine-mode/types/reservation-engine-mode.types';

export type { CutoverAttestation };

// CART_SCOPED activation-boundary gate (see the gate design review's
// direct-backfill and freshness-attestation design). One durable positive
// CartItem target, re-derived fresh from current CartItem/Cart truth by
// CartScopedBackfillService.enumeratePositiveTargets - never cached or
// reused across the backfill and freshness-sweep passes without
// re-verification (see BackfillOutcome's own generation-drift comment).
export interface CartScopedBackfillTarget {
  cartId: string;
  productId: string;
  customerId: string;
  quantity: number;
}

// GENERATION_DRIFT is the defensive backstop this design review's own
// point 6 calls for: given a correctly-implemented mutation barrier,
// CartReservationSyncState.generation for a target cannot actually move
// between enumeration and the post-write recheck (every target-changing
// mutation is frozen) - seeing it anyway means the barrier failed to
// cover some write path, a bug to surface loudly, never silently retry
// past.
export type CartScopedBackfillOutcome =
  | { outcome: 'CONVERGED'; target: CartScopedBackfillTarget }
  | { outcome: 'BLOCKED'; target: CartScopedBackfillTarget; blockReason: 'PRODUCT_SUSPECT' }
  | {
      outcome: 'RETRY';
      target: CartScopedBackfillTarget;
      reasonCode: 'CHECKOUT_IN_PROGRESS' | 'UNKNOWN_INFRA_FAILURE';
      lastError: string | null;
    }
  | { outcome: 'GENERATION_DRIFT'; target: CartScopedBackfillTarget };

export interface CartScopedOrphanOutcome {
  cartId: string;
  productId: string;
  released: boolean;
}

// The freshness sweep's per-target result - CONVERGED carries the actual
// resulting expiresAt (epoch ms, Node clock domain - see
// reserveWithFreshEpoch's own comment on why this is never Redis/Postgres
// time), the value minimumExpiresAt is derived from across the whole
// target set.
export type CartScopedFreshnessOutcome =
  | { outcome: 'CONVERGED'; target: CartScopedBackfillTarget; expiresAt: number }
  | { outcome: 'BLOCKED'; target: CartScopedBackfillTarget; blockReason: 'PRODUCT_SUSPECT' }
  | {
      outcome: 'RETRY';
      target: CartScopedBackfillTarget;
      reasonCode: 'CHECKOUT_IN_PROGRESS' | 'UNKNOWN_INFRA_FAILURE';
      lastError: string | null;
    };
