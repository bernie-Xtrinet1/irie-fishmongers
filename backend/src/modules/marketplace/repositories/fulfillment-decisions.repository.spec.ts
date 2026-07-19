import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateScoreInput, FulfillmentDecisionsRepository } from './fulfillment-decisions.repository';

describe('FulfillmentDecisionsRepository', () => {
  let prisma: PrismaService;
  let repository: FulfillmentDecisionsRepository;
  let productsRepository: ProductsRepository;
  let vendor: Vendor;
  let category: Category;
  let vendorUserId: string;
  let customerId: string;
  let productId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new FulfillmentDecisionsRepository(prisma);
    productsRepository = new ProductsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);

    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });
    const vendorUser = await usersRepository.create({
      email: `fulfillment-decisions-repo-vendor-${randomUUID()}@example.com`,
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

    const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const customerUser = await usersRepository.create({
      email: `fulfillment-decisions-repo-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cammy',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customerUser.id;

    category = await categoriesRepository.create({
      name: `Fulfillment Decisions Category ${randomUUID()}`,
      slug: `fulfillment-decisions-category-${randomUUID()}`,
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
    // FulfillmentDecision.requestedProduct/customer are onDelete: Restrict
    // (audit rows must not silently vanish) - delete the decisions (which
    // cascade to their scores/assignment) before the product/user rows they
    // reference, then the vendor user (cascades Vendor -> Product), then
    // the customer user and category.
    await prisma.fulfillmentDecision.deleteMany({ where: { customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  function baseDecision(overrides: Partial<Parameters<FulfillmentDecisionsRepository['createDecisionWithScores']>[0]> = {}) {
    return {
      requestedProductId: productId,
      quantity: 5,
      deliveryParish: 'KINGSTON' as const,
      customerId,
      decidedAt: new Date(),
      ...overrides,
    };
  }

  function baseScore(overrides: Partial<CreateScoreInput> = {}): CreateScoreInput {
    return { ...buildScoreInput(), ...overrides };
  }

  function buildScoreInput(): CreateScoreInput {
    return {
      vendorId: vendor.id,
      productId,
      inventoryScore: 100,
      freshnessScore: 50,
      complianceScore: 50,
      distanceScore: 100,
      ratingScore: 50,
      deliveryCapacityScore: 50,
      totalScore: 75,
      eligible: true,
      ineligibilityReason: null,
    };
  }

  it('persists a decision with its vendor scores and no assignment when there is no winner', async () => {
    const decisionId = await repository.createDecisionWithScores(
      baseDecision(),
      [baseScore({ eligible: false, ineligibilityReason: 'Vendor is not approved', totalScore: 0 })],
      null,
    );

    const decision = await prisma.fulfillmentDecision.findUniqueOrThrow({
      where: { id: decisionId },
      include: { scores: true, assignment: true },
    });

    expect(decision.scores).toHaveLength(1);
    expect(decision.scores[0]?.eligible).toBe(false);
    expect(decision.assignment).toBeNull();
  });

  it('persists a decision with a winning assignment', async () => {
    const decisionId = await repository.createDecisionWithScores(
      baseDecision(),
      [baseScore()],
      { vendorId: vendor.id, productId },
    );

    const decision = await prisma.fulfillmentDecision.findUniqueOrThrow({
      where: { id: decisionId },
      include: { scores: true, assignment: true },
    });

    expect(decision.scores).toHaveLength(1);
    expect(decision.assignment?.vendorId).toBe(vendor.id);
    expect(decision.assignment?.productId).toBe(productId);
  });
});
