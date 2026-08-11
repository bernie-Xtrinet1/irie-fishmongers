import { CartItem, Prisma } from '@prisma/client';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { ProductsRepository, ProductWithLot } from '../../products/repositories/products.repository';
import { PrismaService } from '../../../database/prisma.service';
import { PRICE_LOCK_TTL_SECONDS } from '../constants/price-lock.constants';
import { PriceLockRepository } from '../repositories/price-lock.repository';
import { PriceLockService } from './price-lock.service';

// PriceLockService coverage: createPriceLock's structural failures
// (not-found/ownership/product-not-found), the MISSING-lock currency
// race, and race-loss winner reclassification. The happy path and
// existing-lock classification live in
// price-lock-creation.service.spec.ts - split to keep every file within
// the repository's 400-line cap.
describe('PriceLockService (createPriceLock structural failures and race-loss reclassification)', () => {
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

  it('returns CART_ITEM_NOT_FOUND when the item does not exist', async () => {
    cartRepository.findItemById.mockResolvedValue(null);

    const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

    expect(result).toEqual({ ok: false, code: 'CART_ITEM_NOT_FOUND' });
  });

  it('returns CART_NOT_FOUND when the cart does not exist', async () => {
    cartRepository.findItemById.mockResolvedValue(buildItem());
    cartRepository.findById.mockResolvedValue(null);

    const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

    expect(result).toEqual({ ok: false, code: 'CART_NOT_FOUND' });
  });

  it('returns OWNERSHIP_MISMATCH when the cart belongs to another customer', async () => {
    cartRepository.findItemById.mockResolvedValue(buildItem());
    cartRepository.findById.mockResolvedValue({ id: cartId, customerId: 'someone-else', currency: null } as never);

    const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

    expect(result).toEqual({ ok: false, code: 'OWNERSHIP_MISMATCH' });
  });

  it('returns PRODUCT_NOT_FOUND when the derived product no longer exists', async () => {
    cartRepository.findItemById.mockResolvedValue(buildItem());
    cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);
    productsRepository.findById.mockResolvedValue(null);

    const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

    expect(result).toEqual({ ok: false, code: 'PRODUCT_NOT_FOUND' });
  });

  it('returns CART_CURRENCY_MISMATCH when currency establishment fails', async () => {
    cartRepository.findItemById.mockResolvedValue(buildItem());
    cartRepository.findById
      .mockResolvedValueOnce({ id: cartId, customerId, currency: 'USD' } as never)
      .mockResolvedValueOnce({ id: cartId, customerId, currency: 'USD' } as never);
    productsRepository.findById.mockResolvedValue(buildProduct({ currency: 'JMD' }));
    cartRepository.establishCurrencyIfCompatible.mockResolvedValue({ count: 0 });

    const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

    expect(result).toEqual({
      ok: false,
      code: 'CART_CURRENCY_MISMATCH',
      cartCurrency: 'USD',
      conflictingCurrency: 'JMD',
    });
    expect(priceLockRepository.createLockIfMissing).not.toHaveBeenCalled();
  });

  it('falls back to a null cartCurrency if the re-read cart is unexpectedly gone', async () => {
    cartRepository.findItemById.mockResolvedValue(buildItem());
    cartRepository.findById
      .mockResolvedValueOnce({ id: cartId, customerId, currency: null } as never)
      .mockResolvedValueOnce(null);
    productsRepository.findById.mockResolvedValue(buildProduct({ currency: 'JMD' }));
    cartRepository.establishCurrencyIfCompatible.mockResolvedValue({ count: 0 });

    const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

    expect(result).toEqual({
      ok: false,
      code: 'CART_CURRENCY_MISMATCH',
      cartCurrency: null,
      conflictingCurrency: 'JMD',
    });
  });

  it('reclassifies the race winner without re-reading Product when the create write loses the race', async () => {
    cartRepository.findItemById
      .mockResolvedValueOnce(buildItem())
      .mockResolvedValueOnce(
        buildItem({
          lockedUnitPrice: new Prisma.Decimal('9.99'),
          lockedCurrency: 'JMD',
          priceLockedAt: new Date(now.getTime() - 500),
        }),
      );
    cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);
    productsRepository.findById.mockResolvedValue(buildProduct());
    cartRepository.establishCurrencyIfCompatible.mockResolvedValue({ count: 1 });
    priceLockRepository.createLockIfMissing.mockResolvedValue({ count: 0 });

    const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

    expect(result).toEqual({
      ok: true,
      action: 'ALREADY_LOCKED',
      cartItemId,
      productId,
      lockedUnitPrice: '9.99',
      lockedCurrency: 'JMD',
      priceLockedAt: new Date(now.getTime() - 500),
    });
    expect(productsRepository.findById).toHaveBeenCalledTimes(1);
  });

  it('never reports a race-loss winner as ALREADY_LOCKED when its lockedCurrency disagrees with the established cart currency', async () => {
    cartRepository.findItemById
      .mockResolvedValueOnce(buildItem())
      .mockResolvedValueOnce(
        buildItem({
          lockedUnitPrice: new Prisma.Decimal('9.99'),
          lockedCurrency: 'USD',
          priceLockedAt: new Date(now.getTime() - 500),
        }),
      );
    cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);
    productsRepository.findById.mockResolvedValue(buildProduct({ currency: 'JMD' }));
    cartRepository.establishCurrencyIfCompatible.mockResolvedValue({ count: 1 });
    priceLockRepository.createLockIfMissing.mockResolvedValue({ count: 0 });

    const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

    expect(result).toEqual({
      ok: false,
      code: 'CART_CURRENCY_MISMATCH',
      cartCurrency: 'JMD',
      conflictingCurrency: 'USD',
    });
    expect(productsRepository.findById).toHaveBeenCalledTimes(1);
  });

  it('classifies the race winner as PRICE_LOCK_EXPIRED when its lock has already expired', async () => {
    cartRepository.findItemById
      .mockResolvedValueOnce(buildItem())
      .mockResolvedValueOnce(
        buildItem({
          lockedUnitPrice: new Prisma.Decimal('9.99'),
          lockedCurrency: 'JMD',
          priceLockedAt: new Date(now.getTime() - PRICE_LOCK_TTL_SECONDS * 1000),
        }),
      );
    cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);
    productsRepository.findById.mockResolvedValue(buildProduct());
    cartRepository.establishCurrencyIfCompatible.mockResolvedValue({ count: 1 });
    priceLockRepository.createLockIfMissing.mockResolvedValue({ count: 0 });

    const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

    expect(result).toEqual({ ok: false, code: 'PRICE_LOCK_EXPIRED' });
  });

  it('classifies the race winner as PRICE_LOCK_STATE_INVALID when its lock is partial', async () => {
    cartRepository.findItemById
      .mockResolvedValueOnce(buildItem())
      .mockResolvedValueOnce(buildItem({ lockedUnitPrice: new Prisma.Decimal('9.99') }));
    cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);
    productsRepository.findById.mockResolvedValue(buildProduct());
    cartRepository.establishCurrencyIfCompatible.mockResolvedValue({ count: 1 });
    priceLockRepository.createLockIfMissing.mockResolvedValue({ count: 0 });

    const result = await service.createPriceLock({ cartId, cartItemId, customerId, now });

    expect(result).toEqual({ ok: false, code: 'PRICE_LOCK_STATE_INVALID' });
  });

  it('throws an internal consistency error when the race-lost row is still MISSING on re-read', async () => {
    cartRepository.findItemById.mockResolvedValueOnce(buildItem()).mockResolvedValueOnce(buildItem());
    cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);
    productsRepository.findById.mockResolvedValue(buildProduct());
    cartRepository.establishCurrencyIfCompatible.mockResolvedValue({ count: 1 });
    priceLockRepository.createLockIfMissing.mockResolvedValue({ count: 0 });

    await expect(service.createPriceLock({ cartId, cartItemId, customerId, now })).rejects.toThrow(
      'Internal consistency error',
    );
  });

  it('throws an internal consistency error when the race-lost row disappears entirely on re-read', async () => {
    cartRepository.findItemById.mockResolvedValueOnce(buildItem()).mockResolvedValueOnce(null);
    cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);
    productsRepository.findById.mockResolvedValue(buildProduct());
    cartRepository.establishCurrencyIfCompatible.mockResolvedValue({ count: 1 });
    priceLockRepository.createLockIfMissing.mockResolvedValue({ count: 0 });

    await expect(service.createPriceLock({ cartId, cartItemId, customerId, now })).rejects.toThrow(
      'Internal consistency error',
    );
  });
});
