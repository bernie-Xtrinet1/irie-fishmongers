import { CartItem, Prisma } from '@prisma/client';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { PrismaService } from '../../../database/prisma.service';
import { PRICE_LOCK_TTL_SECONDS } from '../constants/price-lock.constants';
import { PriceLockRepository } from '../repositories/price-lock.repository';
import { PriceLockService } from './price-lock.service';

// PriceLockService coverage: getPriceLockState and
// validateCartPriceLocks. createPriceLock/reconfirmPrice live in
// price-lock-creation.service.spec.ts - split to keep every file within
// the repository's 400-line cap.
describe('PriceLockService (getPriceLockState and validateCartPriceLocks)', () => {
  let cartRepository: jest.Mocked<Pick<CartRepository, 'findItemById' | 'findById'>>;
  let productsRepository: jest.Mocked<Pick<ProductsRepository, 'findById'>>;
  let priceLockRepository: jest.Mocked<Pick<PriceLockRepository, 'findCartWideLockState'>>;
  let service: PriceLockService;

  const cartId = 'cart-1';
  const cartItemId = 'cart-item-1';
  const customerId = 'customer-1';
  const productId = 'product-1';
  const now = new Date('2026-08-08T00:00:00.000Z');

  beforeEach(() => {
    cartRepository = { findItemById: jest.fn(), findById: jest.fn() };
    productsRepository = { findById: jest.fn() };
    priceLockRepository = { findCartWideLockState: jest.fn() };
    service = new PriceLockService(
      {} as unknown as PrismaService,
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
      lockedUnitPrice: null,
      lockedCurrency: null,
      priceLockedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  describe('getPriceLockState', () => {
    it('returns VALID at exactly validUntil - 1ms', async () => {
      const priceLockedAt = new Date(now.getTime() - PRICE_LOCK_TTL_SECONDS * 1000 + 1);
      cartRepository.findItemById.mockResolvedValue(
        buildItem({ lockedUnitPrice: new Prisma.Decimal('10.00'), lockedCurrency: 'JMD', priceLockedAt }),
      );
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: 'JMD' } as never);

      const result = await service.getPriceLockState({ cartId, cartItemId, customerId, now });

      expect(result).toMatchObject({ ok: true, status: 'VALID' });
    });

    it('returns EXPIRED at exactly validUntil', async () => {
      const priceLockedAt = new Date(now.getTime() - PRICE_LOCK_TTL_SECONDS * 1000);
      cartRepository.findItemById.mockResolvedValue(
        buildItem({ lockedUnitPrice: new Prisma.Decimal('10.00'), lockedCurrency: 'JMD', priceLockedAt }),
      );
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: 'JMD' } as never);

      const result = await service.getPriceLockState({ cartId, cartItemId, customerId, now });

      expect(result).toMatchObject({ ok: true, status: 'EXPIRED' });
    });

    it('returns EXPIRED at validUntil + 1ms', async () => {
      const priceLockedAt = new Date(now.getTime() - PRICE_LOCK_TTL_SECONDS * 1000 - 1);
      cartRepository.findItemById.mockResolvedValue(
        buildItem({ lockedUnitPrice: new Prisma.Decimal('10.00'), lockedCurrency: 'JMD', priceLockedAt }),
      );
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: 'JMD' } as never);

      const result = await service.getPriceLockState({ cartId, cartItemId, customerId, now });

      expect(result).toMatchObject({ ok: true, status: 'EXPIRED' });
    });

    it('returns MISSING when no lock fields are set', async () => {
      cartRepository.findItemById.mockResolvedValue(buildItem());
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);

      const result = await service.getPriceLockState({ cartId, cartItemId, customerId, now });

      expect(result).toEqual({ ok: true, status: 'MISSING' });
    });

    it('returns PRICE_LOCK_STATE_INVALID for a partial lock', async () => {
      cartRepository.findItemById.mockResolvedValue(buildItem({ lockedUnitPrice: new Prisma.Decimal('10.00') }));
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);

      const result = await service.getPriceLockState({ cartId, cartItemId, customerId, now });

      expect(result).toEqual({ ok: true, status: 'PRICE_LOCK_STATE_INVALID' });
    });

    it('returns CART_CURRENCY_MISSING when a complete lock exists but Cart.currency is null', async () => {
      const priceLockedAt = new Date(now.getTime() - 1_000);
      cartRepository.findItemById.mockResolvedValue(
        buildItem({ lockedUnitPrice: new Prisma.Decimal('10.00'), lockedCurrency: 'JMD', priceLockedAt }),
      );
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);

      const result = await service.getPriceLockState({ cartId, cartItemId, customerId, now });

      expect(result).toEqual({
        ok: true,
        status: 'CART_CURRENCY_MISSING',
        lockedCurrency: 'JMD',
        priceLockedAt,
      });
    });

    it('returns CURRENCY_MISMATCH when the lock currency disagrees with a non-null Cart.currency', async () => {
      const priceLockedAt = new Date(now.getTime() - 1_000);
      cartRepository.findItemById.mockResolvedValue(
        buildItem({ lockedUnitPrice: new Prisma.Decimal('10.00'), lockedCurrency: 'USD', priceLockedAt }),
      );
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: 'JMD' } as never);

      const result = await service.getPriceLockState({ cartId, cartItemId, customerId, now });

      expect(result).toEqual({ ok: true, status: 'CURRENCY_MISMATCH', cartCurrency: 'JMD', lockedCurrency: 'USD' });
    });

    it('returns CART_ITEM_NOT_FOUND / CART_NOT_FOUND / OWNERSHIP_MISMATCH appropriately', async () => {
      cartRepository.findItemById.mockResolvedValueOnce(null);
      await expect(service.getPriceLockState({ cartId, cartItemId, customerId, now })).resolves.toEqual({
        ok: false,
        code: 'CART_ITEM_NOT_FOUND',
      });

      cartRepository.findItemById.mockResolvedValue(buildItem());
      cartRepository.findById.mockResolvedValueOnce(null);
      await expect(service.getPriceLockState({ cartId, cartItemId, customerId, now })).resolves.toEqual({
        ok: false,
        code: 'CART_NOT_FOUND',
      });

      cartRepository.findById.mockResolvedValueOnce({ id: cartId, customerId: 'someone-else', currency: null } as never);
      await expect(service.getPriceLockState({ cartId, cartItemId, customerId, now })).resolves.toEqual({
        ok: false,
        code: 'OWNERSHIP_MISMATCH',
      });
    });
  });

  describe('validateCartPriceLocks', () => {
    function lockItem(overrides: Partial<CartItem> = {}) {
      return buildItem({ id: `item-${Math.random()}`, ...overrides });
    }

    it('returns a full checkout-safe snapshot without ever reading Product', async () => {
      const priceLockedAt = new Date(now.getTime() - 1_000);
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: 'JMD' } as never);
      priceLockRepository.findCartWideLockState.mockResolvedValue([
        lockItem({
          id: 'item-a',
          productId: 'product-a',
          quantity: 2,
          lockedUnitPrice: new Prisma.Decimal('10.00'),
          lockedCurrency: 'JMD',
          priceLockedAt,
        }),
      ]);

      const result = await service.validateCartPriceLocks(cartId, customerId, now);

      expect(result).toEqual({
        ok: true,
        cartCurrency: 'JMD',
        items: [
          {
            cartItemId: 'item-a',
            productId: 'product-a',
            quantity: 2,
            lockedUnitPrice: '10',
            lockedCurrency: 'JMD',
            priceLockedAt,
          },
        ],
      });
      expect(productsRepository.findById).not.toHaveBeenCalled();
    });

    it('returns PRICE_LOCKS_INVALID with every id list sorted, covering missing/expired/mismatched/invalid items together', async () => {
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: 'JMD' } as never);
      const valid = new Date(now.getTime() - 1_000);
      const expired = new Date(now.getTime() - PRICE_LOCK_TTL_SECONDS * 1000);
      priceLockRepository.findCartWideLockState.mockResolvedValue([
        lockItem({ id: 'z-expired', lockedUnitPrice: new Prisma.Decimal('1'), lockedCurrency: 'JMD', priceLockedAt: expired }),
        lockItem({ id: 'a-expired', lockedUnitPrice: new Prisma.Decimal('1'), lockedCurrency: 'JMD', priceLockedAt: expired }),
        lockItem({ id: 'z-missing' }),
        lockItem({ id: 'a-missing' }),
        lockItem({ id: 'z-mismatch', lockedUnitPrice: new Prisma.Decimal('1'), lockedCurrency: 'USD', priceLockedAt: valid }),
        lockItem({ id: 'a-mismatch', lockedUnitPrice: new Prisma.Decimal('1'), lockedCurrency: 'USD', priceLockedAt: valid }),
        lockItem({ id: 'z-invalid', lockedUnitPrice: new Prisma.Decimal('1') }),
        lockItem({ id: 'a-invalid', lockedUnitPrice: new Prisma.Decimal('1') }),
      ]);

      const result = await service.validateCartPriceLocks(cartId, customerId, now);

      expect(result).toEqual({
        ok: false,
        code: 'PRICE_LOCKS_INVALID',
        expiredItemIds: ['a-expired', 'z-expired'],
        missingLockItemIds: ['a-missing', 'z-missing'],
        currencyMismatchItemIds: ['a-mismatch', 'z-mismatch'],
        invalidLockStateItemIds: ['a-invalid', 'z-invalid'],
      });
    });

    it('returns CART_EMPTY when the cart has no items', async () => {
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);
      priceLockRepository.findCartWideLockState.mockResolvedValue([]);

      const result = await service.validateCartPriceLocks(cartId, customerId, now);

      expect(result).toEqual({ ok: false, code: 'CART_EMPTY' });
    });

    it('returns CART_CURRENCY_MISSING when items exist but Cart.currency is null', async () => {
      cartRepository.findById.mockResolvedValue({ id: cartId, customerId, currency: null } as never);
      priceLockRepository.findCartWideLockState.mockResolvedValue([lockItem()]);

      const result = await service.validateCartPriceLocks(cartId, customerId, now);

      expect(result).toEqual({ ok: false, code: 'CART_CURRENCY_MISSING' });
    });

    it('returns CART_NOT_FOUND / OWNERSHIP_MISMATCH appropriately', async () => {
      cartRepository.findById.mockResolvedValueOnce(null);
      await expect(service.validateCartPriceLocks(cartId, customerId, now)).resolves.toEqual({
        ok: false,
        code: 'CART_NOT_FOUND',
      });

      cartRepository.findById.mockResolvedValueOnce({ id: cartId, customerId: 'someone-else', currency: null } as never);
      await expect(service.validateCartPriceLocks(cartId, customerId, now)).resolves.toEqual({
        ok: false,
        code: 'OWNERSHIP_MISMATCH',
      });
    });
  });
});
