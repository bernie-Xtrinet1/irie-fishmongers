import { randomUUID } from 'crypto';

import { Category, Prisma, Role, RoleName, Vendor } from '@prisma/client';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { PrismaService } from '../../../database/prisma.service';
import { PriceLockRepository } from '../repositories/price-lock.repository';
import { PriceLockService } from './price-lock.service';

// Real-Postgres coverage for cross-repository transactional behavior that
// cannot be exercised through a mocked-repository unit test: the
// cart-currency race and the same-item create race both depend on
// Postgres's own row-level UPDATE serialization (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md,
// Decision 7's atomic-conditional-update-then-classify idiom). This is
// the price-lock-family equivalent of
// checkout-attempt-concurrency.repository.spec.ts, at service granularity
// rather than single-repository granularity, because these races span
// CartRepository and PriceLockRepository together inside one
// PriceLockService transaction - no single repository method can exercise
// them alone.
describe('PriceLockService (concurrency and transactional atomicity)', () => {
  let prisma: PrismaService;
  let cartRepository: CartRepository;
  let productsRepository: ProductsRepository;
  let priceLockRepository: PriceLockRepository;
  let service: PriceLockService;
  let vendorUserId: string;
  let category: Category;
  let vendor: Vendor;
  let jmdProductId: string;
  let usdProductId: string;
  const customerIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    cartRepository = new CartRepository(prisma);
    productsRepository = new ProductsRepository(prisma);
    priceLockRepository = new PriceLockRepository(prisma);
    service = new PriceLockService(prisma, cartRepository, productsRepository, priceLockRepository);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);

    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });
    const vendorUser = await usersRepository.create({
      email: `price-lock-concurrency-vendor-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vinnie',
      lastName: 'Vendor',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    vendorUserId = vendorUser.id;

    vendor = await vendorsRepository.create({
      userId: vendorUserId,
      businessName: "Vinnie's Catch",
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });
    category = await categoriesRepository.create({
      name: `Price Lock Concurrency Category ${randomUUID()}`,
      slug: `price-lock-concurrency-category-${randomUUID()}`,
    });

    const jmdProduct = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Concurrency Snapper (JMD)',
      description: 'JMD-priced product for price-lock concurrency tests.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 100,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    jmdProductId = jmdProduct.id;

    const usdProduct = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Concurrency Snapper (USD)',
      description: 'USD-priced product for price-lock concurrency tests.',
      unit: 'PER_POUND',
      price: 10,
      quantityAvailable: 100,
      imageUrl: 'https://cdn.example.com/snapper-usd.jpg',
    });
    // ProductsRepository.create has no currency parameter (schema
    // defaults to "JMD") - this is fixture-only setup, not a production
    // repository contract change, to obtain a genuinely different
    // currency for the mismatch scenarios below.
    await prisma.product.update({ where: { id: usdProduct.id }, data: { currency: 'USD' } });
    usdProductId = usdProduct.id;
  });

  afterAll(async () => {
    await prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: customerIds } } } });
    await prisma.cart.deleteMany({ where: { customerId: { in: customerIds } } });
    for (const id of customerIds) {
      await prisma.user.delete({ where: { id } });
    }
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  async function createCustomer(): Promise<string> {
    const usersRepository = new UsersRepository(prisma);
    const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const customer = await usersRepository.create({
      email: `price-lock-concurrency-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerIds.push(customer.id);
    return customer.id;
  }

  it('resolves a two-currency race on a null-currency cart with exactly one winner', async () => {
    const customerId = await createCustomer();
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    await cartRepository.addOrIncrementItem(cart.id, jmdProductId, 1);
    await cartRepository.addOrIncrementItem(cart.id, usdProductId, 1);
    const withItems = await cartRepository.findOrCreateByCustomerId(customerId);
    const jmdItem = withItems.items.find((item) => item.productId === jmdProductId)!;
    const usdItem = withItems.items.find((item) => item.productId === usdProductId)!;
    const now = new Date();

    const [jmdResult, usdResult] = await Promise.all([
      service.createPriceLock({ cartId: cart.id, cartItemId: jmdItem.id, customerId, now }),
      service.createPriceLock({ cartId: cart.id, cartItemId: usdItem.id, customerId, now }),
    ]);

    const created = [jmdResult, usdResult].filter((r) => r.ok && r.action === 'CREATED');
    const mismatched = [jmdResult, usdResult].filter((r) => !r.ok && r.code === 'CART_CURRENCY_MISMATCH');
    expect(created).toHaveLength(1);
    expect(mismatched).toHaveLength(1);

    const finalCart = await cartRepository.findById(cart.id);
    const winnerCurrency = created[0]!.ok && created[0]!.action === 'CREATED' ? created[0]!.lockedCurrency : null;
    expect(finalCart?.currency).toBe(winnerCurrency);

    const loserItemId = created[0] === jmdResult ? usdItem.id : jmdItem.id;
    const loserItem = await prisma.cartItem.findUniqueOrThrow({ where: { id: loserItemId } });
    expect(loserItem.lockedUnitPrice).toBeNull();
    expect(loserItem.lockedCurrency).toBeNull();
    expect(loserItem.priceLockedAt).toBeNull();
  });

  it('resolves a same-item create race with exactly one CREATED and one ALREADY_LOCKED, never renewing the winner', async () => {
    const customerId = await createCustomer();
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    await cartRepository.addOrIncrementItem(cart.id, jmdProductId, 1);
    const withItems = await cartRepository.findOrCreateByCustomerId(customerId);
    const item = withItems.items.find((candidate) => candidate.productId === jmdProductId)!;
    const now = new Date();

    const [first, second] = await Promise.all([
      service.createPriceLock({ cartId: cart.id, cartItemId: item.id, customerId, now }),
      service.createPriceLock({ cartId: cart.id, cartItemId: item.id, customerId, now }),
    ]);

    const createdResults = [first, second].filter((r) => r.ok && r.action === 'CREATED');
    const alreadyLockedResults = [first, second].filter((r) => r.ok && r.action === 'ALREADY_LOCKED');
    expect(createdResults).toHaveLength(1);
    expect(alreadyLockedResults).toHaveLength(1);

    const created = createdResults[0]!;
    const alreadyLocked = alreadyLockedResults[0]!;
    if (created.ok && alreadyLocked.ok) {
      expect(alreadyLocked.priceLockedAt).toEqual(created.priceLockedAt);
      expect(alreadyLocked.lockedUnitPrice).toBe(created.lockedUnitPrice);
      expect(alreadyLocked.lockedCurrency).toBe(created.lockedCurrency);
    }

    const finalItem = await prisma.cartItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(finalItem.priceLockedAt).toEqual(now);
  });

  it('never overwrites a partial lock state, even under concurrent createPriceLock calls', async () => {
    const customerId = await createCustomer();
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    await cartRepository.addOrIncrementItem(cart.id, jmdProductId, 1);
    const withItems = await cartRepository.findOrCreateByCustomerId(customerId);
    const item = withItems.items.find((candidate) => candidate.productId === jmdProductId)!;
    await prisma.cartItem.update({
      where: { id: item.id },
      data: { lockedUnitPrice: new Prisma.Decimal('7.00'), lockedCurrency: null, priceLockedAt: null },
    });
    const now = new Date();

    const [first, second] = await Promise.all([
      service.createPriceLock({ cartId: cart.id, cartItemId: item.id, customerId, now }),
      service.createPriceLock({ cartId: cart.id, cartItemId: item.id, customerId, now }),
    ]);

    expect(first).toEqual({ ok: false, code: 'PRICE_LOCK_STATE_INVALID' });
    expect(second).toEqual({ ok: false, code: 'PRICE_LOCK_STATE_INVALID' });

    const finalItem = await prisma.cartItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(finalItem.lockedUnitPrice?.toString()).toBe('7');
    expect(finalItem.lockedCurrency).toBeNull();
    expect(finalItem.priceLockedAt).toBeNull();
  });

  it('leaves Cart.currency unchanged when the transaction is rolled back after currency establishment', async () => {
    const customerId = await createCustomer();
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    await expect(
      prisma.$transaction(async (tx) => {
        await cartRepository.establishCurrencyIfCompatible(cart.id, customerId, 'JMD', tx);
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    const finalCart = await cartRepository.findById(cart.id);
    expect(finalCart?.currency).toBeNull();
  });

  it('atomically overwrites all three lock fields on reconfirmation', async () => {
    const customerId = await createCustomer();
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    await cartRepository.addOrIncrementItem(cart.id, jmdProductId, 1);
    const withItems = await cartRepository.findOrCreateByCustomerId(customerId);
    const item = withItems.items.find((candidate) => candidate.productId === jmdProductId)!;
    const first = new Date();
    await service.createPriceLock({ cartId: cart.id, cartItemId: item.id, customerId, now: first });

    const second = new Date(first.getTime() + 60_000);
    const result = await service.reconfirmPrice({ cartId: cart.id, cartItemId: item.id, customerId, now: second });

    expect(result.ok).toBe(true);
    const finalItem = await prisma.cartItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(finalItem.priceLockedAt).toEqual(second);
    expect(finalItem.lockedUnitPrice?.toString()).toBe('500');
    expect(finalItem.lockedCurrency).toBe('JMD');
  });

  it('persists Decimal prices exactly', async () => {
    const customerId = await createCustomer();
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    await cartRepository.addOrIncrementItem(cart.id, jmdProductId, 1);
    const withItems = await cartRepository.findOrCreateByCustomerId(customerId);
    const item = withItems.items.find((candidate) => candidate.productId === jmdProductId)!;
    const now = new Date();

    await service.createPriceLock({ cartId: cart.id, cartItemId: item.id, customerId, now });

    const finalItem = await prisma.cartItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(finalItem.lockedUnitPrice?.equals(new Prisma.Decimal('500.00'))).toBe(true);
  });
});
