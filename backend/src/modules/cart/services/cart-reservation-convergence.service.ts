import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { sanitizeErrorMessage } from '../../../common/utils/sanitize-error-message.util';
import { PrismaService } from '../../../database/prisma.service';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CartRepository } from '../repositories/cart.repository';

const MAX_LOG_MESSAGE_LENGTH = 500;

// Phase 16A.0-DA, Unit DA.1A (see the DA.1 architecture review). Extracted
// unchanged from CartService (Phase 16A.0-DA, Unit DA.2) purely to keep
// cart.service.ts under the 400-line cap once DA.2's idempotency flow was
// added - matching the same "plain extracted collaborator" pattern already
// used for checkout-plan-reconciliation.ts. The compensation instructions
// below describe how to undo whichever primary mutation shape produced the
// current durable CartItem state, if the corresponding Redis reservation
// write turns out to be ambiguous (threw, with no proof it did or didn't
// actually apply). `mutationVersion` here guards only the CartItem-table-
// level write (defense in depth) - the marker-level generation gate (see
// applyCompensation) is the actual correctness boundary, since
// CartItem.mutationVersion resets to 0 on a fresh insert and cannot by
// itself distinguish a deleted row from an unrelated later row that
// happens to share the same version.
export type CompensationPlan =
  | { kind: 'DELETE_IF_UNCHANGED'; mutationVersion: number }
  | { kind: 'REVERT_QUANTITY'; mutationVersion: number; toQuantity: number }
  | { kind: 'RESTORE'; toQuantity: number };

// A sentinel used only to unwind applyCompensation's transaction when the
// marker-generation gate misses AFTER a tentative CartItem-level write -
// never surfaced to callers (caught and converted to 'MISSED').
class StaleCompensationGenerationError extends Error {}

@Injectable()
export class CartReservationConvergenceService {
  private readonly logger = new Logger(CartReservationConvergenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cartRepository: CartRepository,
    private readonly inventoryReservations: InventoryReservationsService,
    private readonly syncState: CartReservationSyncStateRepository,
  ) {}

  // Phase 16A.0-DA, Unit DA.1A convergence algorithm (see the DA.1
  // architecture review, including the concurrency-proof correction).
  // Deliberately calls the same legacy InventoryReservationsService.
  // reserve/release CartService already calls today - mode-awareness is
  // DA.3's scope, not DA.1A's. This only makes the existing call site's
  // failure handling deterministic.
  //
  // `generation` is CartReservationSyncState's own permanent counter for
  // this pair - never CartItem.mutationVersion, which resets on a fresh
  // insert and cannot alone distinguish a deleted row's stale compensation
  // from an unrelated later row. desiredQuantity null means "desired Redis
  // state is released/absent". reserve/release are absolute-quantity/
  // idempotent but unconditioned, non-CAS primitives (plain HSET/HDEL,
  // confirmed by direct inspection): a slow, stale write can physically
  // complete AFTER a newer one and silently overwrite it - see
  // confirmOrUnresolve for how that is detected and never left claiming
  // false convergence.
  async convergeReservation(
    cartId: string,
    productId: string,
    generation: number,
    desiredQuantity: number | null,
    compensationPlan: CompensationPlan,
  ): Promise<void> {
    const converged = await this.tryRedisWrite(productId, cartId, desiredQuantity);
    if (converged) {
      await this.confirmOrUnresolve(cartId, productId, generation);
      return;
    }

    const compensationOutcome = await this.applyCompensation(cartId, productId, generation, compensationPlan);
    if (compensationOutcome === 'MISSED') {
      // A newer mutation already advanced the marker past our generation.
      // Never touch Redis with our now-stale intent - and CartItem was
      // never left touched either (see applyCompensation: a late gate
      // miss rolls back the whole transaction, including any tentative
      // CartItem write already made).
      return;
    }

    // Durable state is now confirmed reverted. The failed write's actual
    // Redis effect is still unknown (it may have silently applied) -
    // re-assert the reverted value, which is always a safe, idempotent
    // no-op if it never applied, and corrective if it did.
    const restored = await this.tryRedisWrite(productId, cartId, compensationOutcome.desiredQuantity);
    if (restored) {
      await this.confirmOrUnresolve(cartId, productId, compensationOutcome.generation);
    }
    // If the restore attempt also throws, the marker (already advanced by
    // applyCompensation, resolvedAt already null) is left unresolved -
    // DA.1B's future recovery worker owns converging it from there.
  }

  // A Redis write we just performed succeeded, but reserve/release carry no
  // CAS/version predicate, so it may have landed after a newer mutation's
  // write and silently overwritten it. resolveIfCurrentGeneration only
  // proves OUR generation is still current; a miss means we cannot prove
  // Redis reflects the newer value rather than our stale one. Required
  // invariant: either Redis is known to match the latest durable target
  // and the marker may be resolved, or convergence is unprovable and the
  // marker stays pending for DA.1B - markUnresolved enforces the second
  // branch. Accepted race (no distributed lock introduced): since
  // markUnresolved targets the CURRENT row, not this call's captured
  // generation, it can conservatively flip an already-synchronized newer
  // marker back to PENDING - acceptable, since false PENDING only costs
  // DA.1B an extra re-check, while false RESOLVED would silently lose
  // divergence evidence.
  private async confirmOrUnresolve(cartId: string, productId: string, generation: number): Promise<void> {
    const resolved = await this.syncState.resolveIfCurrentGeneration(cartId, productId, generation);
    if (resolved.count === 0) {
      await this.syncState.markUnresolved(cartId, productId);
    }
  }

  private async tryRedisWrite(
    productId: string,
    cartId: string,
    desiredQuantity: number | null,
  ): Promise<boolean> {
    try {
      if (desiredQuantity === null) {
        await this.inventoryReservations.release(productId, cartId);
      } else {
        await this.inventoryReservations.reserve(productId, cartId, desiredQuantity);
      }
      return true;
    } catch (error) {
      this.logger.error('Reservation write threw - outcome is ambiguous, not assumed unapplied', {
        cartId,
        productId,
        message: sanitizeErrorMessage(CartReservationConvergenceService.errorMessage(error), MAX_LOG_MESSAGE_LENGTH),
      });
      return false;
    }
  }

  // CartItem-level compensation runs FIRST, the marker-generation gate
  // SECOND, both inside the same transaction - matching the primary-
  // mutation path's own lock order (CartItem row, then marker row), so
  // both paths acquire Postgres row locks in the same order and cannot
  // deadlock against each other (see the DA.1 architecture review's
  // lock-ordering correction). Order doesn't affect final correctness:
  // transactions are atomic, so a late gate miss below throws to roll
  // back the WHOLE transaction, including the CartItem write just made.
  private async applyCompensation(
    cartId: string,
    productId: string,
    expectedGeneration: number,
    plan: CompensationPlan,
  ): Promise<'MISSED' | { generation: number; desiredQuantity: number | null }> {
    const target = CartReservationConvergenceService.compensationTarget(plan);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const cartItemOk = await this.applyCartItemCompensation(cartId, productId, plan, tx);
        if (!cartItemOk) {
          return 'MISSED';
        }

        const advanced = await this.syncState.advanceIfCurrentGeneration(
          cartId,
          productId,
          expectedGeneration,
          target.newExpectedMutationVersion,
          target.newExpectedQuantity,
          tx,
        );
        if (advanced.count === 0 || advanced.generation === null) {
          // The CartItem-level write above may have tentatively matched
          // (possible even against a stale guard, after a delete/recreate
          // mutationVersion collision - see the DA.1 architecture
          // review's ABA finding), but the marker generation gate proves
          // a newer mutation has already superseded this generation.
          // Throwing rolls back the whole transaction.
          throw new StaleCompensationGenerationError();
        }

        return { generation: advanced.generation, desiredQuantity: target.newExpectedQuantity };
      });
    } catch (error) {
      if (error instanceof StaleCompensationGenerationError) {
        return 'MISSED';
      }
      throw error;
    }
  }

  private async applyCartItemCompensation(
    cartId: string,
    productId: string,
    plan: CompensationPlan,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    if (plan.kind === 'DELETE_IF_UNCHANGED') {
      const result = await this.cartRepository.compensateItemDeleteIfUnchanged(cartId, productId, plan.mutationVersion, tx);
      return result.count > 0;
    }
    if (plan.kind === 'REVERT_QUANTITY') {
      const result = await this.cartRepository.compensateItemQuantity(
        cartId,
        productId,
        plan.mutationVersion,
        plan.toQuantity,
        tx,
      );
      return result.count > 0;
    }
    const outcome = await this.cartRepository.compensateItemRestore(cartId, productId, plan.toQuantity, tx);
    return outcome.restored;
  }

  // The exact post-compensation CartItem state, known in advance because
  // each primitive's own increment/reset behavior is deterministic given
  // the guard value being passed to it (see cart.repository.ts).
  private static compensationTarget(
    plan: CompensationPlan,
  ): { newExpectedMutationVersion: number; newExpectedQuantity: number | null } {
    if (plan.kind === 'DELETE_IF_UNCHANGED') {
      return { newExpectedMutationVersion: plan.mutationVersion, newExpectedQuantity: null };
    }
    if (plan.kind === 'REVERT_QUANTITY') {
      return { newExpectedMutationVersion: plan.mutationVersion + 1, newExpectedQuantity: plan.toQuantity };
    }
    // RESTORE - compensateItemRestore always creates a fresh row, which
    // always starts at mutationVersion 0.
    return { newExpectedMutationVersion: 0, newExpectedQuantity: plan.toQuantity };
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
