import { Injectable } from '@nestjs/common';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ReservationRecoveryConvergenceService } from '../../reservation-recovery/services/reservation-recovery-convergence.service';
import {
  CartScopedBackfillOutcome,
  CartScopedBackfillTarget,
  CartScopedFreshnessOutcome,
  CutoverAttestation,
} from '../types/cart-scoped-backfill.types';

// Keyset page size for enumeratePositiveTargets - an operational, rare,
// admin-triggered procedure, never a hot path, so a conservative page
// size favors bounded memory/query cost over raw throughput.
export const BACKFILL_PAGE_SIZE = 500;

// CART_SCOPED activation-boundary gate (see the gate design review's
// direct-backfill and freshness-attestation design). Owns exactly the
// pre-cutover backfill/freshness sequence: enumerate every durable
// positive CartItem, converge each directly to the cart-scoped engine
// (bypassing mode entirely via ReservationRecoveryConvergenceService's own
// convergeCartScopedDirect - see that method's doc comment), then run a
// final verify-and-recreate freshness sweep over the same target set
// immediately before the transition transaction. Orphan discovery/release
// is a distinct concern, owned by CartScopedOrphanReleaseService (a
// one-time backfill-phase step, not part of the freshness sweep - see
// that service's own doc comment for why).
//
// Never touches CartMutationBarrierConfig, ReservationEngineModeConfig,
// or CartReservationCompensation/CartReservationSyncState backlog counts -
// those are the orchestrator's own, separately-owned preconditions (see
// the CLI orchestrator's doc comment for the full frozen sequence).
@Injectable()
export class CartScopedBackfillService {
  constructor(
    private readonly cartRepository: CartRepository,
    private readonly syncState: CartReservationSyncStateRepository,
    private readonly convergence: ReservationRecoveryConvergenceService,
    private readonly inventoryReservations: InventoryReservationsService,
  ) {}

  async enumeratePositiveTargets(): Promise<CartScopedBackfillTarget[]> {
    const targets: CartScopedBackfillTarget[] = [];
    let afterId: string | null = null;

    for (;;) {
      const page = await this.cartRepository.findPositiveItemsPage(afterId, BACKFILL_PAGE_SIZE);
      if (page.length === 0) {
        break;
      }
      for (const item of page) {
        targets.push({
          cartId: item.cartId,
          productId: item.productId,
          customerId: item.cart.customerId,
          quantity: item.quantity,
        });
      }
      afterId = page[page.length - 1]!.id;
      if (page.length < BACKFILL_PAGE_SIZE) {
        break;
      }
    }

    return targets;
  }

  async backfillTargets(targets: CartScopedBackfillTarget[]): Promise<CartScopedBackfillOutcome[]> {
    const outcomes: CartScopedBackfillOutcome[] = [];
    for (const target of targets) {
      outcomes.push(await this.backfillOne(target));
    }
    return outcomes;
  }

  // The generation re-check is a defensive backstop, not the primary
  // correctness mechanism - see CartScopedBackfillOutcome's own
  // GENERATION_DRIFT comment. Reads BEFORE and AFTER the convergence
  // write, both via the exact same findByCartAndProduct primitive
  // DA.1A/DA.1B/DA.4B already use for this fencing idiom elsewhere.
  private async backfillOne(target: CartScopedBackfillTarget): Promise<CartScopedBackfillOutcome> {
    const before = await this.syncState.findByCartAndProduct(target.cartId, target.productId);

    const result = await this.convergence.convergeCartScopedDirect({
      cartId: target.cartId,
      productId: target.productId,
      customerId: target.customerId,
      desiredQuantity: target.quantity,
    });

    if (result.outcome === 'BLOCKED') {
      return { outcome: 'BLOCKED', target, blockReason: result.blockReason };
    }
    if (result.outcome === 'RETRY') {
      return { outcome: 'RETRY', target, reasonCode: result.reasonCode, lastError: result.lastError };
    }

    const after = await this.syncState.findByCartAndProduct(target.cartId, target.productId);
    if ((before?.generation ?? null) !== (after?.generation ?? null)) {
      return { outcome: 'GENERATION_DRIFT', target };
    }
    return { outcome: 'CONVERGED', target };
  }

  // The final, immediately-pre-cutover verify-and-recreate pass over the
  // SAME target set backfillTargets already converged - re-derived
  // desired state is unnecessary here (the mutation barrier guarantees it
  // cannot have changed), but the Redis-side epoch reset is mandatory:
  // see reserveWithFreshEpoch's own doc comment and the gate design
  // review's freshness-race analysis for why a plain reserveOrRenew
  // renewal is insufficient near an existing entry's absolute cap.
  async freshnessSweep(targets: CartScopedBackfillTarget[]): Promise<CartScopedFreshnessOutcome[]> {
    const outcomes: CartScopedFreshnessOutcome[] = [];
    for (const target of targets) {
      outcomes.push(await this.freshnessOne(target));
    }
    return outcomes;
  }

  private async freshnessOne(target: CartScopedBackfillTarget): Promise<CartScopedFreshnessOutcome> {
    const result = await this.inventoryReservations.reserveWithFreshEpoch(
      target.cartId,
      target.productId,
      target.customerId,
      target.quantity,
    );

    if (!result.ok) {
      if (result.code === 'RESERVATION_PRODUCT_SUSPENDED') {
        return { outcome: 'BLOCKED', target, blockReason: 'PRODUCT_SUSPECT' };
      }
      return { outcome: 'RETRY', target, reasonCode: 'CHECKOUT_IN_PROGRESS', lastError: null };
    }
    if (result.result.underflow !== null) {
      return { outcome: 'BLOCKED', target, blockReason: 'PRODUCT_SUSPECT' };
    }
    return { outcome: 'CONVERGED', target, expiresAt: result.result.entry.expiresAt };
  }

  // Throws rather than returning a typed failure: called only by the
  // orchestrator, and only ever after every freshnessSweep outcome has
  // already been confirmed CONVERGED (a BLOCKED/RETRY anywhere aborts the
  // whole cutover attempt before this is ever reached) - a mismatched
  // count here is a genuine orchestration-sequencing bug, not a normal
  // outcome to branch on.
  buildAttestation(
    targets: CartScopedBackfillTarget[],
    freshnessOutcomes: CartScopedFreshnessOutcome[],
    barrierRevision: number,
  ): CutoverAttestation {
    const expiresAts = freshnessOutcomes
      .filter((outcome): outcome is Extract<CartScopedFreshnessOutcome, { outcome: 'CONVERGED' }> => outcome.outcome === 'CONVERGED')
      .map((outcome) => outcome.expiresAt);
    if (expiresAts.length !== targets.length) {
      throw new Error(
        'Invariant violation: buildAttestation requires every target to have a CONVERGED freshness outcome',
      );
    }
    return {
      barrierRevision,
      targetCount: targets.length,
      minimumExpiresAt: Math.min(...expiresAts),
      completedAt: Date.now(),
    };
  }
}
