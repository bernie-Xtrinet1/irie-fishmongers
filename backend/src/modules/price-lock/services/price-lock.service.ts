import { Injectable } from '@nestjs/common';
import { CartItem } from '@prisma/client';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { PrismaService } from '../../../database/prisma.service';
import { PRICE_LOCK_TTL_SECONDS } from '../constants/price-lock.constants';
import { PriceLockRepository } from '../repositories/price-lock.repository';
import {
  CartItemLockClassification,
  CreatePriceLockInput,
  CreatePriceLockResult,
  PriceLockState,
  ReconfirmPriceInput,
  ReconfirmPriceResult,
  ValidateCartPriceLocksResult,
  ValidatedCartPriceLockItem,
} from '../types/price-lock.types';

type LockFieldsOnly = Pick<CartItem, 'lockedUnitPrice' | 'lockedCurrency' | 'priceLockedAt'>;

// Owns every business rule for price-lock lifecycle (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md,
// Decision 7). Never queries prisma.cart.*/prisma.cartItem.*/
// prisma.product.* directly - PrismaService is injected solely to open
// $transaction; every model access goes through CartRepository,
// ProductsRepository, or PriceLockRepository. Additive and unwired -
// PriceLockModule is not imported by any production module yet.
@Injectable()
export class PriceLockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cartRepository: CartRepository,
    private readonly productsRepository: ProductsRepository,
    private readonly priceLockRepository: PriceLockRepository,
  ) {}

  async createPriceLock(input: CreatePriceLockInput): Promise<CreatePriceLockResult> {
    return this.prisma.$transaction(async (tx) => {
      const item = await this.cartRepository.findItemById(input.cartId, input.cartItemId, tx);
      if (!item) {
        return { ok: false, code: 'CART_ITEM_NOT_FOUND' };
      }

      const cart = await this.cartRepository.findById(input.cartId, tx);
      if (!cart) {
        return { ok: false, code: 'CART_NOT_FOUND' };
      }
      if (cart.customerId !== input.customerId) {
        return { ok: false, code: 'OWNERSHIP_MISMATCH' };
      }

      // Existing-lock classification always precedes any Product read -
      // a COMPLETE lock (valid or expired) is resolved from the stored
      // row and Cart.currency alone, never by consulting current vendor
      // pricing.
      const classification = PriceLockService.classifyLock(item);
      if (classification.kind === 'COMPLETE') {
        return PriceLockService.classifyExistingCompleteLock(
          item.id,
          item.productId,
          cart.currency,
          classification,
          input.now,
        );
      }
      if (classification.kind === 'PARTIAL') {
        return { ok: false, code: 'PRICE_LOCK_STATE_INVALID' };
      }

      // MISSING - only now is Product pricing consulted.
      const product = await this.productsRepository.findById(item.productId, tx);
      if (!product) {
        return { ok: false, code: 'PRODUCT_NOT_FOUND' };
      }

      const { count: currencyCount } = await this.cartRepository.establishCurrencyIfCompatible(
        input.cartId,
        input.customerId,
        product.currency,
        tx,
      );
      if (currencyCount !== 1) {
        // Cart existence and ownership were already proven above in this
        // same transaction, and no code path mutates Cart.id/customerId -
        // the only remaining explanation for a zero-match here is the
        // currency OR-clause failing.
        const freshCart = await this.cartRepository.findById(input.cartId, tx);
        return {
          ok: false,
          code: 'CART_CURRENCY_MISMATCH',
          cartCurrency: freshCart?.currency ?? null,
          conflictingCurrency: product.currency,
        };
      }

      const { count: lockCount } = await this.priceLockRepository.createLockIfMissing(
        item.id,
        product.price,
        product.currency,
        input.now,
        tx,
      );
      if (lockCount === 1) {
        return {
          ok: true,
          action: 'CREATED',
          cartItemId: item.id,
          productId: item.productId,
          lockedUnitPrice: product.price.toString(),
          lockedCurrency: product.currency,
          priceLockedAt: input.now,
        };
      }

      // Lost the create race - reclassify the winner's row without ever
      // re-consulting Product (Decision 2). establishCurrencyIfCompatible
      // already succeeded above in this same transaction, so
      // Cart.currency is now guaranteed to equal product.currency - reuse
      // that already-loaded value rather than re-reading Cart or Product.
      const winner = await this.cartRepository.findItemById(input.cartId, input.cartItemId, tx);
      if (!winner) {
        throw new Error(
          `Internal consistency error: cart item ${item.id} disappeared mid-transaction`,
        );
      }
      const winnerClassification = PriceLockService.classifyLock(winner);
      if (winnerClassification.kind === 'MISSING') {
        throw new Error(
          `Internal consistency error: cart item ${item.id} lock write matched zero rows but ` +
            'remains MISSING',
        );
      }
      if (winnerClassification.kind === 'PARTIAL') {
        return { ok: false, code: 'PRICE_LOCK_STATE_INVALID' };
      }
      return PriceLockService.classifyExistingCompleteLock(
        winner.id,
        winner.productId,
        product.currency,
        winnerClassification,
        input.now,
      );
    });
  }

  async reconfirmPrice(input: ReconfirmPriceInput): Promise<ReconfirmPriceResult> {
    return this.prisma.$transaction(async (tx) => {
      const item = await this.cartRepository.findItemById(input.cartId, input.cartItemId, tx);
      if (!item) {
        return { ok: false, code: 'CART_ITEM_NOT_FOUND' };
      }

      const cart = await this.cartRepository.findById(input.cartId, tx);
      if (!cart) {
        return { ok: false, code: 'CART_NOT_FOUND' };
      }
      if (cart.customerId !== input.customerId) {
        return { ok: false, code: 'OWNERSHIP_MISMATCH' };
      }

      const classification = PriceLockService.classifyLock(item);
      if (classification.kind === 'MISSING') {
        return { ok: false, code: 'PRICE_LOCK_MISSING' };
      }
      if (classification.kind === 'PARTIAL') {
        return { ok: false, code: 'PRICE_LOCK_STATE_INVALID' };
      }

      // Cart.currency must be established before Product is ever read -
      // reconfirmation never repairs a missing Cart.currency itself.
      if (cart.currency === null) {
        return { ok: false, code: 'CART_CURRENCY_MISSING' };
      }

      const product = await this.productsRepository.findById(item.productId, tx);
      if (!product) {
        return { ok: false, code: 'PRODUCT_NOT_FOUND' };
      }
      if (product.currency !== cart.currency) {
        return {
          ok: false,
          code: 'CART_CURRENCY_MISMATCH',
          cartCurrency: cart.currency,
          conflictingCurrency: product.currency,
        };
      }

      await this.priceLockRepository.reconfirmLock(
        item.id,
        product.price,
        product.currency,
        input.now,
        tx,
      );

      return {
        ok: true,
        cartItemId: item.id,
        productId: item.productId,
        oldUnitPrice: classification.lockedUnitPrice.toString(),
        oldCurrency: classification.lockedCurrency,
        newUnitPrice: product.price.toString(),
        newCurrency: product.currency,
        priceLockedAt: input.now,
      };
    });
  }

  async getPriceLockState(input: CreatePriceLockInput): Promise<PriceLockState> {
    const item = await this.cartRepository.findItemById(input.cartId, input.cartItemId);
    if (!item) {
      return { ok: false, code: 'CART_ITEM_NOT_FOUND' };
    }

    const cart = await this.cartRepository.findById(input.cartId);
    if (!cart) {
      return { ok: false, code: 'CART_NOT_FOUND' };
    }
    if (cart.customerId !== input.customerId) {
      return { ok: false, code: 'OWNERSHIP_MISMATCH' };
    }

    const classification = PriceLockService.classifyLock(item);
    if (classification.kind === 'MISSING') {
      return { ok: true, status: 'MISSING' };
    }
    if (classification.kind === 'PARTIAL') {
      return { ok: true, status: 'PRICE_LOCK_STATE_INVALID' };
    }

    if (cart.currency === null) {
      return {
        ok: true,
        status: 'CART_CURRENCY_MISSING',
        lockedCurrency: classification.lockedCurrency,
        priceLockedAt: classification.priceLockedAt,
      };
    }
    if (classification.lockedCurrency !== cart.currency) {
      return {
        ok: true,
        status: 'CURRENCY_MISMATCH',
        cartCurrency: cart.currency,
        lockedCurrency: classification.lockedCurrency,
      };
    }

    const validUntil = new Date(classification.priceLockedAt.getTime() + PRICE_LOCK_TTL_SECONDS * 1000);
    return {
      ok: true,
      status: input.now.getTime() < validUntil.getTime() ? 'VALID' : 'EXPIRED',
      lockedUnitPrice: classification.lockedUnitPrice.toString(),
      lockedCurrency: classification.lockedCurrency,
      priceLockedAt: classification.priceLockedAt,
      validUntil,
    };
  }

  async validateCartPriceLocks(
    cartId: string,
    customerId: string,
    now: Date,
  ): Promise<ValidateCartPriceLocksResult> {
    const cart = await this.cartRepository.findById(cartId);
    if (!cart) {
      return { ok: false, code: 'CART_NOT_FOUND' };
    }
    if (cart.customerId !== customerId) {
      return { ok: false, code: 'OWNERSHIP_MISMATCH' };
    }

    const items = await this.priceLockRepository.findCartWideLockState(cartId);
    if (items.length === 0) {
      return { ok: false, code: 'CART_EMPTY' };
    }
    if (cart.currency === null) {
      return { ok: false, code: 'CART_CURRENCY_MISSING' };
    }

    const expiredItemIds: string[] = [];
    const missingLockItemIds: string[] = [];
    const currencyMismatchItemIds: string[] = [];
    const invalidLockStateItemIds: string[] = [];
    const validItems: ValidatedCartPriceLockItem[] = [];

    for (const item of items) {
      const classification = PriceLockService.classifyLock(item);
      if (classification.kind === 'MISSING') {
        missingLockItemIds.push(item.id);
        continue;
      }
      if (classification.kind === 'PARTIAL') {
        invalidLockStateItemIds.push(item.id);
        continue;
      }
      if (classification.lockedCurrency !== cart.currency) {
        currencyMismatchItemIds.push(item.id);
        continue;
      }
      const validUntil = classification.priceLockedAt.getTime() + PRICE_LOCK_TTL_SECONDS * 1000;
      if (now.getTime() >= validUntil) {
        expiredItemIds.push(item.id);
        continue;
      }
      validItems.push({
        cartItemId: item.id,
        productId: item.productId,
        quantity: item.quantity,
        lockedUnitPrice: classification.lockedUnitPrice.toString(),
        lockedCurrency: classification.lockedCurrency,
        priceLockedAt: classification.priceLockedAt,
      });
    }

    if (
      expiredItemIds.length + missingLockItemIds.length + currencyMismatchItemIds.length + invalidLockStateItemIds.length >
      0
    ) {
      return {
        ok: false,
        code: 'PRICE_LOCKS_INVALID',
        expiredItemIds: expiredItemIds.sort(),
        missingLockItemIds: missingLockItemIds.sort(),
        currencyMismatchItemIds: currencyMismatchItemIds.sort(),
        invalidLockStateItemIds: invalidLockStateItemIds.sort(),
      };
    }

    return { ok: true, cartCurrency: cart.currency, items: validItems };
  }

  private static classifyLock(item: LockFieldsOnly): CartItemLockClassification {
    const { lockedUnitPrice, lockedCurrency, priceLockedAt } = item;
    if (lockedUnitPrice === null && lockedCurrency === null && priceLockedAt === null) {
      return { kind: 'MISSING' };
    }
    if (lockedUnitPrice !== null && lockedCurrency !== null && priceLockedAt !== null) {
      return { kind: 'COMPLETE', lockedUnitPrice, lockedCurrency, priceLockedAt };
    }
    return { kind: 'PARTIAL' };
  }

  // A COMPLETE lock is not valid merely because all three fields are
  // non-null - it must also agree with Cart.currency (never
  // Product.currency, which is deliberately never read for an existing
  // lock). The currency invariant is checked before TTL: an invariant
  // failure is reported even for an otherwise-still-valid lock, and takes
  // priority over PRICE_LOCK_EXPIRED for an otherwise-expired one.
  private static classifyExistingCompleteLock(
    cartItemId: string,
    productId: string,
    cartCurrency: string | null,
    classification: Extract<CartItemLockClassification, { kind: 'COMPLETE' }>,
    now: Date,
  ): CreatePriceLockResult {
    if (cartCurrency === null) {
      return { ok: false, code: 'CART_CURRENCY_MISSING' };
    }
    if (classification.lockedCurrency !== cartCurrency) {
      return {
        ok: false,
        code: 'CART_CURRENCY_MISMATCH',
        cartCurrency,
        conflictingCurrency: classification.lockedCurrency,
      };
    }

    const validUntil = classification.priceLockedAt.getTime() + PRICE_LOCK_TTL_SECONDS * 1000;
    if (now.getTime() < validUntil) {
      return {
        ok: true,
        action: 'ALREADY_LOCKED',
        cartItemId,
        productId,
        lockedUnitPrice: classification.lockedUnitPrice.toString(),
        lockedCurrency: classification.lockedCurrency,
        priceLockedAt: classification.priceLockedAt,
      };
    }
    return { ok: false, code: 'PRICE_LOCK_EXPIRED' };
  }
}
