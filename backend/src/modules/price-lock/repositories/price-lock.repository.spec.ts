import { randomUUID } from 'crypto';

import { Category, Prisma, Role, RoleName, Vendor } from '@prisma/client';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { PrismaService } from '../../../database/prisma.service';
import { PriceLockRepository } from './price-lock.repository';

describe('PriceLockRepository', () => {
  let prisma: PrismaService;
  let cartRepository: CartRepository;
  let repository: PriceLockRepository;
  let productId: string;
  let customerId: string;
  let vendorUserId: string;
  let category: Category;
  let vendor: Vendor;
  let cartItemId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    cartRepository = new CartRepository(prisma);
    repository = new PriceLockRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });

    const customer = await usersRepository.create({
      email: `price-lock-repo-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Pauline',
      lastName: 'Priceton',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `price-lock-repo-vendor-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Victor',
      lastName: 'Vendor',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    vendorUserId = vendorUser.id;

    vendor = await vendorsRepository.create({
      userId: vendorUserId,
      businessName: "Victor's Catch",
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });
    category = await categoriesRepository.create({
      name: `Price Lock Repo Category ${randomUUID()}`,
      slug: `price-lock-repo-category-${randomUUID()}`,
    });
    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Price Lock Repo Snapper',
      description: 'A product used only for price-lock repository tests.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 20,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    productId = product.id;
  });

  beforeEach(async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    await cartRepository.addOrIncrementItem(cart.id, productId, 1);
    const updated = await cartRepository.findOrCreateByCustomerId(customerId);
    const item = updated.items.find((candidate) => candidate.productId === productId)!;
    cartItemId = item.id;
    // Reset to MISSING before every test, regardless of what a prior test left behind.
    await prisma.cartItem.update({
      where: { id: item.id },
      data: { lockedUnitPrice: null, lockedCurrency: null, priceLockedAt: null },
    });
  });

  afterAll(async () => {
    await prisma.cartItem.deleteMany({ where: { cart: { customerId } } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  describe('createLockIfMissing', () => {
    it('writes all three lock fields when all three are currently null', async () => {
      const now = new Date();
      const { count } = await repository.createLockIfMissing(
        cartItemId,
        new Prisma.Decimal('12.34'),
        'JMD',
        now,
        prisma,
      );

      expect(count).toBe(1);
      const item = await prisma.cartItem.findUniqueOrThrow({ where: { id: cartItemId } });
      expect(item.lockedUnitPrice?.toString()).toBe('12.34');
      expect(item.lockedCurrency).toBe('JMD');
      expect(item.priceLockedAt).toEqual(now);
    });

    it('matches zero rows when the lock is already complete', async () => {
      const now = new Date();
      await repository.createLockIfMissing(cartItemId, new Prisma.Decimal('12.34'), 'JMD', now, prisma);

      const { count } = await repository.createLockIfMissing(
        cartItemId,
        new Prisma.Decimal('99.99'),
        'USD',
        new Date(now.getTime() + 1_000),
        prisma,
      );

      expect(count).toBe(0);
      const item = await prisma.cartItem.findUniqueOrThrow({ where: { id: cartItemId } });
      expect(item.lockedUnitPrice?.toString()).toBe('12.34');
      expect(item.lockedCurrency).toBe('JMD');
    });

    it('matches zero rows when the lock is partially set', async () => {
      await prisma.cartItem.update({
        where: { id: cartItemId },
        data: { lockedUnitPrice: new Prisma.Decimal('5.00'), lockedCurrency: null, priceLockedAt: null },
      });

      const { count } = await repository.createLockIfMissing(
        cartItemId,
        new Prisma.Decimal('12.34'),
        'JMD',
        new Date(),
        prisma,
      );

      expect(count).toBe(0);
      const item = await prisma.cartItem.findUniqueOrThrow({ where: { id: cartItemId } });
      expect(item.lockedUnitPrice?.toString()).toBe('5');
      expect(item.lockedCurrency).toBeNull();
    });
  });

  describe('reconfirmLock', () => {
    it('overwrites all three lock fields atomically', async () => {
      const first = new Date();
      await repository.createLockIfMissing(cartItemId, new Prisma.Decimal('12.34'), 'JMD', first, prisma);

      const second = new Date(first.getTime() + 60_000);
      const { count } = await repository.reconfirmLock(
        cartItemId,
        new Prisma.Decimal('15.00'),
        'JMD',
        second,
        prisma,
      );

      expect(count).toBe(1);
      const item = await prisma.cartItem.findUniqueOrThrow({ where: { id: cartItemId } });
      expect(item.lockedUnitPrice?.toString()).toBe('15');
      expect(item.priceLockedAt).toEqual(second);
    });
  });

  describe('findCartWideLockState', () => {
    it('returns the narrow lock-state shape without any Product field', async () => {
      const now = new Date();
      await repository.createLockIfMissing(cartItemId, new Prisma.Decimal('12.34'), 'JMD', now, prisma);
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);

      const items = await repository.findCartWideLockState(cart.id, prisma);

      const item = items.find((candidate) => candidate.id === cartItemId);
      expect(item).toEqual({
        id: cartItemId,
        productId,
        quantity: expect.any(Number) as number,
        lockedUnitPrice: expect.anything() as unknown,
        lockedCurrency: 'JMD',
        priceLockedAt: now,
      });
      expect(Object.keys(item ?? {})).not.toContain('product');
    });
  });
});
