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

  async addOrIncrementItem(cartId: string, productId: string, quantity: number): Promise<void> {
    await this.prisma.cartItem.upsert({
      where: { cartId_productId: { cartId, productId } },
      create: { cartId, productId, quantity },
      update: { quantity: { increment: quantity } },
    });
  }

  async updateItemQuantity(itemId: string, quantity: number): Promise<void> {
    await this.prisma.cartItem.update({ where: { id: itemId }, data: { quantity } });
  }

  async removeItem(itemId: string): Promise<void> {
    await this.prisma.cartItem.delete({ where: { id: itemId } });
  }

  async clear(cartId: string, client: PrismaClientOrTx = this.prisma): Promise<void> {
    await client.cartItem.deleteMany({ where: { cartId } });
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
