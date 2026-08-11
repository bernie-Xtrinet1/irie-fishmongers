import { CartItem, Prisma } from '@prisma/client';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { ProductsRepository, ProductWithLot } from '../../products/repositories/products.repository';
import { PrismaService } from '../../../database/prisma.service';
import { PRICE_LOCK_TTL_SECONDS } from '../constants/price-lock.constants';
import { PriceLockRepository } from '../repositories/price-lock.repository';
import { PriceLockService } from './price-lock.service';

// PriceLockService coverage: reconfirmPrice only. createPriceLock lives in
// price-lock-creation.service.spec.ts; getPriceLockState and
// validateCartPriceLocks live in
// price-lock-state-validation.service.spec.ts - split to keep every file
// within the repository's 400-line cap.
describe('PriceLockService (reconfirmPrice)', () => {
  let prisma: jest.Mocked<Pick<PrismaService, '$transaction'>>;
  let cartRepository: jest.Mocked<Pick<CartRepository, 'findItemById' | 'findById'>>;
  let productsRepository: jest.Mocked<Pick<ProductsRepository, 'findById'>>;
  let priceLockRepository: jest.Mocked<Pick<PriceLockRepository, 'reconfirmLock'>>;
  let service: PriceLockService;

  const cartId = 'cart-1';
  const cartItemId = 'cart-item-1';
  const customerId = 'customer-1';
  const productId = 'product-1';
  const now = new Date('2026-08-08T00:00:00.000Z');
  const tx = {} as Prisma.TransactionClient;

  beforeEach(() => {
    prisma = { $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)) } as never;
    cartRepository = { findItemById: jest.fn(), findById: jest.fn() };
    productsRepository = { findById: jest.fn() };
    priceLockRepository = { reconfirmLock: jest.fn() };
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

  it('returns PRICE_LOCK_MISSING with zero writes and zero Product reads', async () => {
    cartRepository.findItemById.mockResolvedValue(buildItem());
    cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);

    const result = await service.reconfirmPrice({ cartId, cartItemId, customerId, now });

    expect(result).toEqual({ ok: false, code: 'PRICE_LOCK_MISSING' });
    expect(productsRepository.findById).not.toHaveBeenCalled();
  });

  it('returns PRICE_LOCK_STATE_INVALID with zero writes for a partial lock, never repairing it', async () => {
    cartRepository.findItemById.mockResolvedValue(
      buildItem({ lockedUnitPrice: null, lockedCurrency: 'JMD', priceLockedAt: null }),
    );
    cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: 'JMD' } as never);

    const result = await service.reconfirmPrice({ cartId, cartItemId, customerId, now });

    expect(result).toEqual({ ok: false, code: 'PRICE_LOCK_STATE_INVALID' });
    expect(productsRepository.findById).not.toHaveBeenCalled();
    expect(priceLockRepository.reconfirmLock).not.toHaveBeenCalled();
  });

  it('returns CART_CURRENCY_MISSING with zero Product reads and zero writes when Cart.currency is null', async () => {
    cartRepository.findItemById.mockResolvedValue(
      buildItem({
        lockedUnitPrice: new Prisma.Decimal('10.00'),
        lockedCurrency: 'JMD',
        priceLockedAt: new Date(now.getTime() - 1_000),
      }),
    );
    cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);

    const result = await service.reconfirmPrice({ cartId, cartItemId, customerId, now });

    expect(result).toEqual({ ok: false, code: 'CART_CURRENCY_MISSING' });
    expect(productsRepository.findById).not.toHaveBeenCalled();
    expect(priceLockRepository.reconfirmLock).not.toHaveBeenCalled();
  });

  it('reconfirms a valid lock to the current Product price', async () => {
    const priceLockedAt = new Date(now.getTime() - 1_000);
    cartRepository.findItemById.mockResolvedValue(
      buildItem({ lockedUnitPrice: new Prisma.Decimal('10.00'), lockedCurrency: 'JMD', priceLockedAt }),
    );
    cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: 'JMD' } as never);
    productsRepository.findById.mockResolvedValue(buildProduct({ price: new Prisma.Decimal('15.50') }));
    priceLockRepository.reconfirmLock.mockResolvedValue({ count: 1 });

    const result = await service.reconfirmPrice({ cartId, cartItemId, customerId, now });

    expect(result).toEqual({
      ok: true,
      cartItemId,
      productId,
      oldUnitPrice: '10',
      oldCurrency: 'JMD',
      newUnitPrice: '15.5',
      newCurrency: 'JMD',
      priceLockedAt: now,
    });
  });

  it('reconfirms an expired lock to the current Product price', async () => {
    const priceLockedAt = new Date(now.getTime() - PRICE_LOCK_TTL_SECONDS * 1000);
    cartRepository.findItemById.mockResolvedValue(
      buildItem({ lockedUnitPrice: new Prisma.Decimal('10.00'), lockedCurrency: 'JMD', priceLockedAt }),
    );
    cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: 'JMD' } as never);
    productsRepository.findById.mockResolvedValue(buildProduct());
    priceLockRepository.reconfirmLock.mockResolvedValue({ count: 1 });

    const result = await service.reconfirmPrice({ cartId, cartItemId, customerId, now });

    expect(result.ok).toBe(true);
    expect(priceLockRepository.reconfirmLock).toHaveBeenCalledTimes(1);
  });

  it('returns CART_CURRENCY_MISMATCH with zero writes when Product.currency no longer matches Cart.currency', async () => {
    cartRepository.findItemById.mockResolvedValue(
      buildItem({
        lockedUnitPrice: new Prisma.Decimal('10.00'),
        lockedCurrency: 'JMD',
        priceLockedAt: new Date(now.getTime() - 1_000),
      }),
    );
    cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: 'JMD' } as never);
    productsRepository.findById.mockResolvedValue(buildProduct({ currency: 'USD' }));

    const result = await service.reconfirmPrice({ cartId, cartItemId, customerId, now });

    expect(result).toEqual({
      ok: false,
      code: 'CART_CURRENCY_MISMATCH',
      cartCurrency: 'JMD',
      conflictingCurrency: 'USD',
    });
    expect(priceLockRepository.reconfirmLock).not.toHaveBeenCalled();
  });

  it('returns CART_ITEM_NOT_FOUND / CART_NOT_FOUND / OWNERSHIP_MISMATCH / PRODUCT_NOT_FOUND appropriately', async () => {
    cartRepository.findItemById.mockResolvedValueOnce(null);
    await expect(service.reconfirmPrice({ cartId, cartItemId, customerId, now })).resolves.toEqual({
      ok: false,
      code: 'CART_ITEM_NOT_FOUND',
    });

    cartRepository.findItemById.mockResolvedValue(buildItem());
    cartRepository.findById.mockResolvedValueOnce(null);
    await expect(service.reconfirmPrice({ cartId, cartItemId, customerId, now })).resolves.toEqual({
      ok: false,
      code: 'CART_NOT_FOUND',
    });

    cartRepository.findById.mockResolvedValueOnce({ id: cartId, customerId: 'someone-else', currency: null } as never);
    await expect(service.reconfirmPrice({ cartId, cartItemId, customerId, now })).resolves.toEqual({
      ok: false,
      code: 'OWNERSHIP_MISMATCH',
    });

    cartRepository.findItemById.mockResolvedValue(
      buildItem({
        lockedUnitPrice: new Prisma.Decimal('10.00'),
        lockedCurrency: 'JMD',
        priceLockedAt: new Date(now.getTime() - 1_000),
      }),
    );
    cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: 'JMD' } as never);
    productsRepository.findById.mockResolvedValueOnce(null);
    await expect(service.reconfirmPrice({ cartId, cartItemId, customerId, now })).resolves.toEqual({
      ok: false,
      code: 'PRODUCT_NOT_FOUND',
    });
  });
});
