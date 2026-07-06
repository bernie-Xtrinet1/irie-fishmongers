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

  findItemById(cartId: string, itemId: string): Promise<CartItem | null> {
    return this.prisma.cartItem.findFirst({ where: { id: itemId, cartId } });
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

  findById(id: string): Promise<Cart | null> {
    return this.prisma.cart.findUnique({ where: { id } });
  }
}
