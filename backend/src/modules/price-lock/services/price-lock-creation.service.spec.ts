import { CartItem, Prisma } from '@prisma/client';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { ProductsRepository, ProductWithLot } from '../../products/repositories/products.repository';
import { PrismaService } from '../../../database/prisma.service';
import { PRICE_LOCK_TTL_SECONDS } from '../constants/price-lock.constants';
import { PriceLockRepository } from '../repositories/price-lock.repository';
import { PriceLockService } from './price-lock.service';

// PriceLockService coverage: createPriceLock's happy path and its
// existing-lock classification (COMPLETE valid/expired, the Cart-currency
// invariant, PARTIAL). Every dependency is mocked - real-Postgres
// transactional/concurrency behavior is covered by
// price-lock-concurrency.service.spec.ts. Structural failures (not-found/
// ownership/product-not-found) and race-loss reclassification live in
// price-lock-creation-errors.service.spec.ts; reconfirmPrice lives in
// price-lock-reconfirm.service.spec.ts; getPriceLockState and
// validateCartPriceLocks live in
// price-lock-state-validation.service.spec.ts - split to keep every file
// within the repository's 400-line cap.
describe('PriceLockService (createPriceLock)', () => {
  let prisma: jest.Mocked<Pick<PrismaService, '$transaction'>>;
  let cartRepository: jest.Mocked<
    Pick<CartRepository, 'findItemById' | 'findById' | 'establishCurrencyIfCompatible'>
  >;
  let productsRepository: jest.Mocked<Pick<ProductsRepository, 'findById'>>;
  let priceLockRepository: jest.Mocked<Pick<PriceLockRepository, 'createLockIfMissing'>>;
  let service: PriceLockService;

  const cartId = 'cart-1';
  const cartItemId = 'cart-item-1';
  const customerId = 'customer-1';
  const productId = 'product-1';
  const now = new Date('2026-08-08T00:00:00.000Z');
  const tx = {} as Prisma.TransactionClient;

  beforeEach(() => {
    prisma = { $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)) } as never;
    cartRepository = {
      findItemById: jest.fn(),
      findById: jest.fn(),
      establishCurrencyIfCompatible: jest.fn(),
    };
    productsRepository = { findById: jest.fn() };
    priceLockRepository = { createLockIfMissing: jest.fn() };
    service = new PriceLockService(
      prisma as unknown as PrismaService,
      cartRepository as unknown as CartRepository,
      productsRepository as unknown as ProductsRepository,
      priceLockRepository as unknown as PriceLockRepository,
    );
  });

  function buildItem(overrides: Partial<CartItem> = {}): CartItem {
    return {
      id: cartItemId,
      cartId,
      productId,
      quantity: 1,
      mutationVersion: 0,
      lockedUnitPrice: null,
      lockedCurrency: null,
      priceLockedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  function buildProduct(overrides: Partial<ProductWithLot> = {}): ProductWithLot {
    return {
      id: productId,
      vendorId: 'vendor-1',
      categoryId: 'category-1',
      lotId: null,
      name: 'Snapper',
      description: 'Fresh snapper',
      unit: 'PER_POUND',
      price: new Prisma.Decimal('500.00'),
      currency: 'JMD',
      quantityAvailable: 10,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
      isActive: true,
      weightLbs: null,
      createdAt: now,
      updatedAt: now,
      lot: null,
      ...overrides,
    };
  }

  describe('createPriceLock', () => {
    it('reads Product and creates a lock when the item has no lock at all', async () => {
      cartRepository.findItemById.mockResolvedValue(buildItem());
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);
      productsRepository.findById.mockResolvedValue(buildProduct());
      cartRepository.establishCurrencyIfCompatible.mockResolvedValue({ count: 1 });
      priceLockRepository.createLockIfMissing.mockResolvedValue({ count: 1 });

      const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

      expect(result).toEqual({
        ok: true,
        action: 'CREATED',
        cartItemId,
        productId,
        lockedUnitPrice: '500',
        lockedCurrency: 'JMD',
        priceLockedAt: now,
      });
      expect(productsRepository.findById).toHaveBeenCalledTimes(1);
    });

    it('returns ALREADY_LOCKED without reading Product when the lock is complete, valid, and agrees with Cart.currency', async () => {
      const priceLockedAt = new Date(now.getTime() - 1_000);
      cartRepository.findItemById.mockResolvedValue(
        buildItem({ lockedUnitPrice: new Prisma.Decimal('12.34'), lockedCurrency: 'JMD', priceLockedAt }),
      );
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: 'JMD' } as never);

      const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

      expect(result).toEqual({
        ok: true,
        action: 'ALREADY_LOCKED',
        cartItemId,
        productId,
        lockedUnitPrice: '12.34',
        lockedCurrency: 'JMD',
        priceLockedAt,
      });
      expect(productsRepository.findById).not.toHaveBeenCalled();
      expect(cartRepository.establishCurrencyIfCompatible).not.toHaveBeenCalled();
      expect(priceLockRepository.createLockIfMissing).not.toHaveBeenCalled();
    });

    it('returns PRICE_LOCK_EXPIRED with zero writes and zero Product reads when the lock is complete, expired, and agrees with Cart.currency', async () => {
      const priceLockedAt = new Date(now.getTime() - PRICE_LOCK_TTL_SECONDS * 1000);
      cartRepository.findItemById.mockResolvedValue(
        buildItem({ lockedUnitPrice: new Prisma.Decimal('12.34'), lockedCurrency: 'JMD', priceLockedAt }),
      );
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: 'JMD' } as never);

      const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

      expect(result).toEqual({ ok: false, code: 'PRICE_LOCK_EXPIRED' });
      expect(productsRepository.findById).not.toHaveBeenCalled();
      expect(priceLockRepository.createLockIfMissing).not.toHaveBeenCalled();
    });

    it('returns CART_CURRENCY_MISSING for an otherwise-valid complete lock when Cart.currency is null', async () => {
      const priceLockedAt = new Date(now.getTime() - 1_000);
      cartRepository.findItemById.mockResolvedValue(
        buildItem({ lockedUnitPrice: new Prisma.Decimal('12.34'), lockedCurrency: 'JMD', priceLockedAt }),
      );
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);

      const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

      expect(result).toEqual({ ok: false, code: 'CART_CURRENCY_MISSING' });
      expect(productsRepository.findById).not.toHaveBeenCalled();
      expect(cartRepository.establishCurrencyIfCompatible).not.toHaveBeenCalled();
      expect(priceLockRepository.createLockIfMissing).not.toHaveBeenCalled();
    });

    it('returns CART_CURRENCY_MISMATCH for an otherwise-valid complete lock whose lockedCurrency disagrees with Cart.currency', async () => {
      const priceLockedAt = new Date(now.getTime() - 1_000);
      cartRepository.findItemById.mockResolvedValue(
        buildItem({ lockedUnitPrice: new Prisma.Decimal('12.34'), lockedCurrency: 'USD', priceLockedAt }),
      );
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: 'JMD' } as never);

      const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

      expect(result).toEqual({
        ok: false,
        code: 'CART_CURRENCY_MISMATCH',
        cartCurrency: 'JMD',
        conflictingCurrency: 'USD',
      });
      expect(productsRepository.findById).not.toHaveBeenCalled();
      expect(cartRepository.establishCurrencyIfCompatible).not.toHaveBeenCalled();
      expect(priceLockRepository.createLockIfMissing).not.toHaveBeenCalled();
    });

    it('reports the currency invariant failure instead of PRICE_LOCK_EXPIRED when both conditions hold', async () => {
      const priceLockedAt = new Date(now.getTime() - PRICE_LOCK_TTL_SECONDS * 1000);
      cartRepository.findItemById.mockResolvedValue(
        buildItem({ lockedUnitPrice: new Prisma.Decimal('12.34'), lockedCurrency: 'USD', priceLockedAt }),
      );
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: 'JMD' } as never);

      const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

      expect(result).toEqual({
        ok: false,
        code: 'CART_CURRENCY_MISMATCH',
        cartCurrency: 'JMD',
        conflictingCurrency: 'USD',
      });
    });

    it('returns PRICE_LOCK_STATE_INVALID with zero writes and zero Product reads for a partial lock', async () => {
      cartRepository.findItemById.mockResolvedValue(
        buildItem({ lockedUnitPrice: new Prisma.Decimal('12.34'), lockedCurrency: null, priceLockedAt: null }),
      );
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);

      const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

      expect(result).toEqual({ ok: false, code: 'PRICE_LOCK_STATE_INVALID' });
      expect(productsRepository.findById).not.toHaveBeenCalled();
      expect(cartRepository.establishCurrencyIfCompatible).not.toHaveBeenCalled();
      expect(priceLockRepository.createLockIfMissing).not.toHaveBeenCalled();
    });
  });
});
