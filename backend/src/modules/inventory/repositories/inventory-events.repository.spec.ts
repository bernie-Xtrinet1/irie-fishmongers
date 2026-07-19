import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { InventoryEventsRepository } from './inventory-events.repository';

describe('InventoryEventsRepository', () => {
  let prisma: PrismaService;
  let repository: InventoryEventsRepository;
  let productId: string;
  let vendor: Vendor;
  let category: Category;
  let paginationCategory: Category;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new InventoryEventsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);

    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });
    const user = await usersRepository.create({
      email: `inventory-events-repo-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vera',
      lastName: 'Vendor',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    userId = user.id;
    vendor = await vendorsRepository.create({
      userId,
      businessName: "Vera's Catch",
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });
    category = await categoriesRepository.create({
      name: `Inventory Events Category ${randomUUID()}`,
      slug: `inventory-events-category-${randomUUID()}`,
    });
    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Fresh Snapper',
      description: 'Caught this morning off the north coast.',
      unit: 'PER_POUND',
      price: 850,
      quantityAvailable: 10,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    productId = product.id;
  });

  afterAll(async () => {
    // InventoryEvent.product is onDelete: Restrict (audit rows must not
    // silently vanish) - delete the events this suite created before the
    // Vendor -> Product cascade (triggered by deleting the user) can
    // proceed, then the categories themselves (Product.category is also
    // Restrict).
    await prisma.inventoryEvent.deleteMany({ where: { product: { vendorId: vendor.id } } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.category.delete({ where: { id: category.id } });
    if (paginationCategory) {
      await prisma.category.delete({ where: { id: paginationCategory.id } });
    }
    await prisma.onModuleDestroy();
  });

  it('creates and lists events for a product, most recent first', async () => {
    await repository.create({
      productId,
      eventType: 'DECREMENTED',
      quantityDelta: -2,
    });
    await repository.create({
      productId,
      eventType: 'MANUAL_ADJUSTMENT',
      quantityDelta: 5,
      triggeredById: userId,
      notes: 'Recount after weighing',
    });

    const { items, total } = await repository.findByProduct(productId, { skip: 0, take: 20 });

    expect(total).toBe(2);
    expect(items[0]?.eventType).toBe('MANUAL_ADJUSTMENT');
    expect(items[0]?.quantityDelta).toBe(5);
    expect(items[0]?.notes).toBe('Recount after weighing');
    expect(items[1]?.eventType).toBe('DECREMENTED');
    expect(items[1]?.quantityDelta).toBe(-2);
  });

  it('paginates results', async () => {
    paginationCategory = await new CategoriesRepository(prisma).create({
      name: `Inventory Events Pagination Category ${randomUUID()}`,
      slug: `inventory-events-pagination-category-${randomUUID()}`,
    });
    const product = await new ProductsRepository(prisma).create({
      vendorId: vendor.id,
      categoryId: paginationCategory.id,
      name: 'Pagination Snapper',
      description: 'desc',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 20,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });

    for (let i = 0; i < 3; i += 1) {
      await repository.create({ productId: product.id, eventType: 'RESTOCKED', quantityDelta: 1 });
    }

    const page1 = await repository.findByProduct(product.id, { skip: 0, take: 2 });
    const page2 = await repository.findByProduct(product.id, { skip: 2, take: 2 });

    expect(page1.total).toBe(3);
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(1);
  });

  describe('countAndSumByType', () => {
    it('counts and sums quantityDelta per event type within the given range', async () => {
      const from = new Date();
      await repository.create({ productId, eventType: 'RESTOCKED', quantityDelta: 10 });
      await repository.create({ productId, eventType: 'RESTOCKED', quantityDelta: 5 });
      await repository.create({ productId, eventType: 'DISPOSED', quantityDelta: -3 });

      const result = await repository.countAndSumByType({ from });

      expect(result.RESTOCKED).toEqual({ count: 2, totalQuantityDelta: 15 });
      expect(result.DISPOSED).toEqual({ count: 1, totalQuantityDelta: -3 });
      expect(result.MANUAL_ADJUSTMENT).toEqual({ count: 0, totalQuantityDelta: 0 });
    });

    it('excludes events outside the given range', async () => {
      const future = new Date(Date.now() + 60_000);

      const result = await repository.countAndSumByType({ from: future });

      expect(result).toEqual({
        DECREMENTED: { count: 0, totalQuantityDelta: 0 },
        RESTOCKED: { count: 0, totalQuantityDelta: 0 },
        MANUAL_ADJUSTMENT: { count: 0, totalQuantityDelta: 0 },
        DISPOSED: { count: 0, totalQuantityDelta: 0 },
      });
    });
  });
});
