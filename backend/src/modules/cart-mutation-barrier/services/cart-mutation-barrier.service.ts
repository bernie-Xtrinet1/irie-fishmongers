import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { CartMutationBarrierConfigRepository } from '../repositories/cart-mutation-barrier-config.repository';
import { CartMutationBarrierSnapshot } from '../types/cart-mutation-barrier.types';

// CART_SCOPED activation-boundary gate (see the gate design review's final,
// approved shared/exclusive advisory-lock protocol). A dedicated lock key,
// deliberately kept separate from reservation-engine-mode's own
// TRANSITION_LOCK_KEY: ordinary cart mutations (addItem/updateItemQuantity/
// removeItem/checkout) have no business participating in the reservation-
// mode-transition lock's contention domain, and vice versa - the two gates
// protect different invariants that happen to be temporally adjacent
// during one specific cutover, not the same resource.
export const MUTATION_BARRIER_LOCK_KEY = 'cart_mutation_barrier';

// The single sentinel every target-changing mutation transaction throws
// when the barrier is active, thrown INSIDE the transaction (so Prisma
// rolls it back before any CartItem/marker write) and caught by the
// calling service (CartService/OrdersService) to convert into the
// user-facing 503 - "this operation was cleanly refused before touching
// any durable state, retry shortly" is exactly the DA.4B DRAINING/
// MODE_NOT_ADMITTING precedent, not a business-rule conflict (409). One
// shared class, never redefined per call site, so every caller catches
// the identical type.
export class CartMutationBarrierActiveError extends Error {}

// Owns the shared/exclusive advisory-lock protocol that makes "the barrier
// is active" a fact every target-changing cart-mutation transaction can
// trust was true continuously since before its own first durable write -
// not merely true at the instant of a plain, unlocked read (see the gate
// design review's race analysis: a plain first-statement read is
// insufficient under READ COMMITTED, because it does not serialize against
// a concurrent activation that commits in the gap between the read and the
// transaction's own commit).
//
// Protocol (exact, frozen):
//   - checkActive(tx): every target-changing mutation transaction's first
//     statement. Acquires the SHARED lock, then reads the current row via a
//     PLAIN SELECT (never FOR UPDATE/FOR SHARE - see the module doc comment
//     for why introducing a second contested resource here would reopen a
//     deadlock risk the single-resource design deliberately avoids). The
//     shared lock is held for the remainder of the caller's OWN
//     transaction, releasing only at that transaction's commit/rollback -
//     this is what proves the caller's eventual CartItem + marker write
//     (if it proceeds) happened while the observed barrier state could not
//     have changed underneath it.
//   - activate/deactivate: a dedicated, self-contained transaction that
//     acquires the EXCLUSIVE lock before writing. Because shared and
//     exclusive holders of the same advisory-lock key are mutually
//     exclusive, an activate() call cannot acquire its exclusive lock (and
//     therefore cannot commit) until every transaction that already holds
//     the shared lock has released it - i.e. until every mutation that
//     observed the OLD barrier state has already committed its own
//     CartItem + marker write. This is the entire correctness argument:
//     the durable CartReservationSyncState marker such a mutation leaves
//     behind becomes the post-commit drain fence the cutover gate's
//     backlog check already depends on.
@Injectable()
export class CartMutationBarrierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: CartMutationBarrierConfigRepository,
  ) {}

  // Called as the literal first statement inside a target-changing
  // mutation's own transaction (addItem/updateItemQuantity/removeItem/
  // createOrderInTransaction). Never opens its own transaction - the
  // shared lock must be scoped to and released by the CALLER's
  // transaction, not this method's.
  async checkActive(tx: Prisma.TransactionClient): Promise<CartMutationBarrierSnapshot> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${MUTATION_BARRIER_LOCK_KEY}))`;
    const current = await this.repository.findCurrent(tx);
    return { active: current?.active ?? false, revision: current?.revision ?? null };
  }

  // Convenience wrapper for the four target-changing entry points -
  // acquires the shared lock, and throws CartMutationBarrierActiveError
  // before any further statement in the caller's transaction if active.
  // Every call site reduces to one line at the top of its own
  // prisma.$transaction callback.
  async assertNotActive(tx: Prisma.TransactionClient): Promise<void> {
    const snapshot = await this.checkActive(tx);
    if (snapshot.active) {
      throw new CartMutationBarrierActiveError();
    }
  }

  // Idempotent: repeated activation while already active returns the
  // current snapshot without inserting a redundant row (no revision
  // churn) - a fresh revision must mean a genuine active/inactive state
  // change, since a pre-cutover attestation's captured barrierRevision is
  // later compared for EXACT equality against whatever is current at
  // transition time (see the gate design review's binding rationale).
  async activate(activatedById: string): Promise<CartMutationBarrierSnapshot> {
    return this.setActive(true, activatedById);
  }

  async deactivate(activatedById: string): Promise<CartMutationBarrierSnapshot> {
    return this.setActive(false, activatedById);
  }

  private async setActive(desired: boolean, activatedById: string): Promise<CartMutationBarrierSnapshot> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${MUTATION_BARRIER_LOCK_KEY}))`;
      const current = await this.repository.findCurrent(tx);
      if ((current?.active ?? false) === desired) {
        return { active: desired, revision: current?.revision ?? null };
      }
      const created = await this.repository.create({ active: desired, activatedById }, tx);
      return { active: created.active, revision: created.revision };
    });
  }
}
