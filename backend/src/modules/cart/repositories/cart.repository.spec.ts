import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartRepository } from './cart.repository';

describe('CartRepository', () => {
  let prisma: PrismaService;
  let repository: CartRepository;
  let productId: string;
  let customerId: string;
  let vendorUserId: string;
  let category: Category;
  let vendor: Vendor;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new CartRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });

    const customer = await usersRepository.create({
      email: `cart-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `cart-vendor-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vera',
      lastName: 'Vendor',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    vendorUserId = vendorUser.id;

    vendor = await vendorsRepository.create({
      userId: vendorUserId,
      businessName: "Vera's Catch",
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });
    category = await categoriesRepository.create({
      name: `Cart Test Category ${randomUUID()}`,
      slug: `cart-test-category-${randomUUID()}`,
    });
    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Cart Test Snapper',
      description: 'A product used only for cart repository tests.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 20,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    productId = product.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  it('creates an empty cart on first access and returns the same cart afterwards', async () => {
    const cart = await repository.findOrCreateByCustomerId(customerId);
    expect(cart.items).toHaveLength(0);

    const again = await repository.findOrCreateByCustomerId(customerId);
    expect(again.id).toBe(cart.id);
  });

  it('adds a new item and increments quantity on repeated adds', async () => {
    const cart = await repository.findOrCreateByCustomerId(customerId);

    await repository.addOrIncrementItem(cart.id, productId, 2);
    let updated = await repository.findOrCreateByCustomerId(customerId);
    expect(updated.items.find((item) => item.productId === productId)?.quantity).toBe(2);

    await repository.addOrIncrementItem(cart.id, productId, 3);
    updated = await repository.findOrCreateByCustomerId(customerId);
    expect(updated.items.find((item) => item.productId === productId)?.quantity).toBe(5);
  });

  it('sets an absolute quantity via updateItemQuantity', async () => {
    const cart = await repository.findOrCreateByCustomerId(customerId);
    const item = cart.items.find((candidate) => candidate.productId === productId)!;

    await repository.updateItemQuantity(item.id, 9);
    const updated = await repository.findOrCreateByCustomerId(customerId);
    expect(updated.items.find((candidate) => candidate.productId === productId)?.quantity).toBe(9);
  });

  it('finds an item by id scoped to its cart', async () => {
    const cart = await repository.findOrCreateByCustomerId(customerId);
    const item = cart.items[0]!;

    await expect(repository.findItemById(cart.id, item.id)).resolves.not.toBeNull();
    await expect(repository.findItemById(randomUUID(), item.id)).resolves.toBeNull();
  });

  it('removes an item', async () => {
    const cart = await repository.findOrCreateByCustomerId(customerId);
    const item = cart.items[0]!;

    await repository.removeItem(item.id);
    const updated = await repository.findOrCreateByCustomerId(customerId);
    expect(updated.items).toHaveLength(0);
  });

  it('clears all items in a cart', async () => {
    const cart = await repository.findOrCreateByCustomerId(customerId);
    await repository.addOrIncrementItem(cart.id, productId, 1);

    await repository.clear(cart.id);
    const updated = await repository.findOrCreateByCustomerId(customerId);
    expect(updated.items).toHaveLength(0);
  });

  it('finds a cart by id', async () => {
    const cart = await repository.findOrCreateByCustomerId(customerId);
    await expect(repository.findById(cart.id)).resolves.not.toBeNull();
    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });
});
