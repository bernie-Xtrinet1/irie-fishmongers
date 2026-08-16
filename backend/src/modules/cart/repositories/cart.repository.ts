import { Injectable } from '@nestjs/common';
import { Cart, CartItem, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export type PrismaClientOrTx = PrismaService | Prisma.TransactionClient;

const cartWithItems = Prisma.validator<Prisma.CartDefaultArgs>()({
  include: { items: { include: { product: { include: { lot: true } } } } },
});

export type CartWithItems = Prisma.CartGetPayload<typeof cartWithItems>;

@Injectable()
export class CartRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findOrCreateByCustomerId(customerId: string): Promise<CartWithItems> {
    const existing = await this.prisma.cart.findUnique({
      where: { customerId },
      include: cartWithItems.include,
    });
    if (existing) {
      return existing;
    }

    return this.prisma.cart.create({
      data: { customerId },
      include: cartWithItems.include,
    });
  }

  findItemById(
    cartId: string,
    itemId: string,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<CartItem | null> {
    return client.cartItem.findFirst({ where: { id: itemId, cartId } });
  }

  // Phase 16A.0-C4.3: the desired-state read for compensation recovery,
  // keyed the same way CartReservationCompensation rows are (cartId,
  // productId), not by CartItem.id. Uses the existing
  // @@unique([cartId, productId]) index directly.
  findItemByCartAndProduct(
    cartId: string,
    productId: string,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<CartItem | null> {
    return client.cartItem.findUnique({ where: { cartId_productId: { cartId, productId } } });
  }

  // Phase 16A.0-DA, Unit DA.1A. Returns the resulting row so the caller can
  // capture its post-write mutationVersion/quantity - the compensation
  // guard for whatever comes next (see cart.service.ts's convergence
  // algorithm). The primary write itself needs no explicit version guard:
  // Postgres's own row lock for the duration of this statement (and any
  // enclosing transaction) already serializes concurrent writers to the
  // same (cartId, productId) row - an explicit guard is only needed on the
  // *compensation* primitives below, which must detect whether a newer
  // write has since superseded the one they are trying to undo.
  addOrIncrementItem(
    cartId: string,
    productId: string,
    quantity: number,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<CartItem> {
    return client.cartItem.upsert({
      where: { cartId_productId: { cartId, productId } },
      create: { cartId, productId, quantity },
      update: { quantity: { increment: quantity }, mutationVersion: { increment: 1 } },
    });
  }

  updateItemQuantity(
    itemId: string,
    quantity: number,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<CartItem> {
    return client.cartItem.update({
      where: { id: itemId },
      data: { quantity, mutationVersion: { increment: 1 } },
    });
  }

  // Returns the deleted row (Prisma's delete() returns it by default) -
  // its quantity/mutationVersion reflect exactly what existed at the
  // moment of deletion, which is what a later compensating restore must
  // recreate. Deliberately not read-then-delete: a separate prior read
  // could be stale by the time this statement runs.
  removeItem(itemId: string, client: PrismaClientOrTx = this.prisma): Promise<CartItem> {
    return client.cartItem.delete({ where: { id: itemId } });
  }

  // --- Compensation primitives (Phase 16A.0-DA, Unit DA.1A) ---
  // Each guards against exactly one primary-mutation shape's undo. All
  // three return a miss (count 0 / restored:false) rather than throwing
  // when a newer mutation has already superseded the version being
  // compensated - the caller must never blindly retry with a fresher
  // value, since that would silently discard a newer writer's own intent
  // (see the DA.1 architecture review's compensation-miss race analysis).

  // Undoes an update/increment: reverts quantity to its pre-operation
  // value, guarded on the exact mutationVersion this operation itself
  // produced. The revert is itself a mutation, so it also bumps
  // mutationVersion - a later re-read observes an ever-increasing value,
  // never a version reused across two logically different writes.
  compensateItemQuantity(
    cartId: string,
    productId: string,
    expectedMutationVersion: number,
    revertToQuantity: number,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cartItem.updateMany({
      where: { cartId, productId, mutationVersion: expectedMutationVersion },
      data: { quantity: revertToQuantity, mutationVersion: { increment: 1 } },
    });
  }

  // Undoes a fresh insert: deletes the row only if it still holds exactly
  // the version this operation created it with (0). If a concurrent
  // mutation already changed it, the delete misses rather than removing a
  // newer writer's row.
  compensateItemDeleteIfUnchanged(
    cartId: string,
    productId: string,
    expectedMutationVersion: number,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cartItem.deleteMany({
      where: { cartId, productId, mutationVersion: expectedMutationVersion },
    });
  }

  // Undoes a remove: recreates the row at its pre-deletion quantity. There
  // is no surviving row to guard with a WHERE clause once it has been
  // deleted, so the guard is the unique (cartId, productId) constraint
  // itself - if another request already re-added the same product since
  // our delete, this create collides (P2002) and the compensation is
  // reported as a miss rather than overwriting the newer row.
  async compensateItemRestore(
    cartId: string,
    productId: string,
    quantity: number,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ restored: boolean; item: CartItem | null }> {
    try {
      const item = await client.cartItem.create({ data: { cartId, productId, quantity } });
      return { restored: true, item };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { restored: false, item: null };
      }
      throw error;
    }
  }

  async clear(cartId: string, client: PrismaClientOrTx = this.prisma): Promise<void> {
    await client.cartItem.deleteMany({ where: { cartId } });
  }

  // CART_SCOPED activation-boundary gate (see the gate design review's
  // direct-backfill design). Keyset-paginated by id (never a single
  // unbounded query) - the enumeration primitive the pre-cutover backfill
  // uses to walk every durable positive CartItem across the whole
  // catalogue. Joins Cart.customerId directly (required for a reserve-
  // shaped convergence call) rather than making the caller issue a
  // second lookup per row.
  findPositiveItemsPage(
    afterId: string | null,
    limit: number,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<(CartItem & { cart: { customerId: string } })[]> {
    return client.cartItem.findMany({
      where: { quantity: { gt: 0 }, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: 'asc' },
      take: limit,
      include: { cart: { select: { customerId: true } } },
    });
  }

  findById(id: string, client: PrismaClientOrTx = this.prisma): Promise<Cart | null> {
    return client.cart.findUnique({ where: { id } });
  }

  // Phase 16A.0-B (see PriceLockService): the sole write path for
  // Cart.currency - a single atomic conditional updateMany, never a
  // read-then-write. Matches count===1 exactly when currency was already
  // null (now established) or already equal to productCurrency (a no-op
  // write, idempotent under concurrent retries). A zero count means the
  // caller must re-read to classify CART_NOT_FOUND, OWNERSHIP_MISMATCH, or
  // a genuine currency conflict - this method never performs that
  // re-read itself, matching every other conditional-transition method in
  // this codebase (see ProductsRepository.adjustStock,
  // CheckoutAttemptRepository's conditional updates).
  establishCurrencyIfCompatible(
    cartId: string,
    customerId: string,
    productCurrency: string,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<{ count: number }> {
    return client.cart.updateMany({
      where: {
        id: cartId,
        customerId,
        OR: [{ currency: null }, { currency: productCurrency }],
      },
      data: { currency: productCurrency },
    });
  }
}
