import { Injectable } from '@nestjs/common';
import { CartItem, Prisma } from '@prisma/client';

import { PrismaClientOrTx } from '../../cart/repositories/cart.repository';
import { PrismaService } from '../../../database/prisma.service';

// Owns every write to CartItem's three price-lock fields
// (lockedUnitPrice, lockedCurrency, priceLockedAt). CartRepository owns
// Cart.currency (see CartRepository.establishCurrencyIfCompatible) and
// general CartItem CRUD - this repository owns only the lock-field
// lifecycle, kept separate so CartRepository never accumulates
// price-lock-specific business logic.
@Injectable()
export class PriceLockRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Conditioned on all three lock fields being null (Decision 2) - never
  // priceLockedAt alone, so a partially-corrupted row can never be
  // silently treated as "missing" and overwritten.
  createLockIfMissing(
    cartItemId: string,
    lockedUnitPrice: Prisma.Decimal,
    lockedCurrency: string,
    priceLockedAt: Date,
    client: PrismaClientOrTx,
  ): Promise<{ count: number }> {
    return client.cartItem.updateMany({
      where: { id: cartItemId, lockedUnitPrice: null, lockedCurrency: null, priceLockedAt: null },
      data: { lockedUnitPrice, lockedCurrency, priceLockedAt },
    });
  }

  // Unconditional aside from id - ownership and existing-lock-state
  // classification (MISSING/PARTIAL rejection) have already happened in
  // PriceLockService before this is called. The count check is defense in
  // depth only (matches this codebase's "always a conditional updateMany,
  // never a blind update" convention), not required by any concurrency
  // test.
  reconfirmLock(
    cartItemId: string,
    lockedUnitPrice: Prisma.Decimal,
    lockedCurrency: string,
    priceLockedAt: Date,
    client: PrismaClientOrTx,
  ): Promise<{ count: number }> {
    return client.cartItem.updateMany({
      where: { id: cartItemId },
      data: { lockedUnitPrice, lockedCurrency, priceLockedAt },
    });
  }

  // Narrow select for validateCartPriceLocks - deliberately never joins
  // Product, so this method structurally cannot be used to read
  // Product.price.
  findCartWideLockState(
    cartId: string,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<
    Pick<CartItem, 'id' | 'productId' | 'quantity' | 'lockedUnitPrice' | 'lockedCurrency' | 'priceLockedAt'>[]
  > {
    return client.cartItem.findMany({
      where: { cartId },
      select: { id: true, productId: true, quantity: true, lockedUnitPrice: true, lockedCurrency: true, priceLockedAt: true },
    });
  }
}
