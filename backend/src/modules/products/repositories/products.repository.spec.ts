import { randomUUID } from 'crypto';

import { ConflictException } from '@nestjs/common';
import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CategoriesRepository } from './categories.repository';
import { ProductsRepository } from './products.repository';

describe('ProductsRepository', () => {
  let prisma: PrismaService;
  let repository: ProductsRepository;
  let vendor: Vendor;
  let category: Category;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new ProductsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);

    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });
    const user = await usersRepository.create({
      email: `products-repo-${randomUUID()}@example.com`,
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
      name: `Test Category ${randomUUID()}`,
      slug: `test-category-${randomUUID()}`,
    });
  });

  afterAll(async () => {
    // Delete the user first so Vendor -> Product cascades clear out before
    // removing the category (Product.category uses onDelete: Restrict).
    await prisma.user.delete({ where: { id: userId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  function baseInput(overrides: Partial<Parameters<ProductsRepository['create']>[0]> = {}) {
    return {
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Fresh Snapper',
      description: 'Caught this morning off the north coast.',
      unit: 'PER_POUND' as const,
      price: 850,
      quantityAvailable: 10,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
      ...overrides,
    };
  }

  it('creates and finds a product by id', async () => {
    const created = await repository.create(baseInput());
    const found = await repository.findById(created.id);
    expect(found?.name).toBe('Fresh Snapper');
    expect(found?.price.toString()).toBe('850');
  });

  it('updates product fields', async () => {
    const created = await repository.create(baseInput());
    const updated = await repository.update(created.id, { name: 'Updated Snapper' });
    expect(updated.name).toBe('Updated Snapper');
  });

  it('toggles active status', async () => {
    const created = await repository.create(baseInput());
    const deactivated = await repository.setActive(created.id, false);
    expect(deactivated.isActive).toBe(false);
    const reactivated = await repository.setActive(created.id, true);
    expect(reactivated.isActive).toBe(true);
  });

  describe('adjustStock', () => {
    it('increases stock', async () => {
      const created = await repository.create(baseInput({ quantityAvailable: 5 }));
      const updated = await repository.adjustStock(created.id, 3);
      expect(updated.quantityAvailable).toBe(8);
    });

    it('decreases stock', async () => {
      const created = await repository.create(baseInput({ quantityAvailable: 5 }));
      const updated = await repository.adjustStock(created.id, -3);
      expect(updated.quantityAvailable).toBe(2);
    });

    it('rejects a decrease that would go negative', async () => {
      const created = await repository.create(baseInput({ quantityAvailable: 2 }));
      await expect(repository.adjustStock(created.id, -3)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('findMany', () => {
    it('filters by category, vendor, and free-text search, excluding inactive products', async () => {
      const match = await repository.create(baseInput({ name: 'Unique Grouper Fillet' }));
      const inactive = await repository.create(baseInput({ name: 'Unique Grouper Steak' }));
      await repository.setActive(inactive.id, false);

      const { items, total } = await repository.findMany(
        { categoryId: category.id, vendorId: vendor.id, search: 'Unique Grouper', activeOnly: true },
        { skip: 0, take: 20 },
      );

      expect(total).toBe(1);
      expect(items.map((item) => item.id)).toEqual([match.id]);
    });

    it('paginates results', async () => {
      const searchTerm = `Paginate-${randomUUID()}`;
      await repository.create(baseInput({ name: `${searchTerm} A` }));
      await repository.create(baseInput({ name: `${searchTerm} B` }));
      await repository.create(baseInput({ name: `${searchTerm} C` }));

      const page1 = await repository.findMany(
        { search: searchTerm, activeOnly: true },
        { skip: 0, take: 2 },
      );
      const page2 = await repository.findMany(
        { search: searchTerm, activeOnly: true },
        { skip: 2, take: 2 },
      );

      expect(page1.total).toBe(3);
      expect(page1.items).toHaveLength(2);
      expect(page2.items).toHaveLength(1);
    });
  });
});
