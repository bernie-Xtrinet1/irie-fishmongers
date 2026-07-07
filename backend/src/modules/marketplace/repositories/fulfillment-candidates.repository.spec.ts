import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { FulfillmentCandidatesRepository } from './fulfillment-candidates.repository';

describe('FulfillmentCandidatesRepository', () => {
  let prisma: PrismaService;
  let repository: FulfillmentCandidatesRepository;
  let productsRepository: ProductsRepository;
  let vendor: Vendor;
  let category: Category;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new FulfillmentCandidatesRepository(prisma);
    productsRepository = new ProductsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);

    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });
    const user = await usersRepository.create({
      email: `fulfillment-candidates-repo-${randomUUID()}@example.com`,
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
    await vendorsRepository.updateStatus(vendor.id, 'APPROVED');
    category = await categoriesRepository.create({
      name: `Fulfillment Candidates Category ${randomUUID()}`,
      slug: `fulfillment-candidates-category-${randomUUID()}`,
    });
  });

  afterAll(async () => {
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

  describe('findById', () => {
    it('returns the product with its vendor and lot joined', async () => {
      const created = await productsRepository.create(baseInput());
      const found = await repository.findById(created.id);

      expect(found?.vendor.businessName).toBe("Vera's Catch");
      expect(found?.lot).toBeNull();
    });

    it('returns null for a missing product', async () => {
      const found = await repository.findById('00000000-0000-0000-0000-000000000000');
      expect(found).toBeNull();
    });
  });

  describe('findMatchingCandidates', () => {
    it('matches by case-insensitive name and category, excluding inactive products', async () => {
      const name = `Unique Match Snapper ${randomUUID()}`;
      const active = await productsRepository.create(baseInput({ name }));
      const inactive = await productsRepository.create(baseInput({ name }));
      await productsRepository.setActive(inactive.id, false);
      await productsRepository.create(baseInput({ name: name.toUpperCase() }));

      const candidates = await repository.findMatchingCandidates(name, category.id);

      const ids = candidates.map((candidate) => candidate.id);
      expect(ids).toContain(active.id);
      expect(ids).not.toContain(inactive.id);
      expect(candidates.length).toBeGreaterThanOrEqual(2);
    });

    it('does not match a different category', async () => {
      const name = `Category Scoped Snapper ${randomUUID()}`;
      await productsRepository.create(baseInput({ name }));

      const otherCategory = await new CategoriesRepository(prisma).create({
        name: `Other Category ${randomUUID()}`,
        slug: `other-category-${randomUUID()}`,
      });

      const candidates = await repository.findMatchingCandidates(name, otherCategory.id);
      expect(candidates).toHaveLength(0);

      await prisma.category.delete({ where: { id: otherCategory.id } });
    });
  });
});
