import { randomUUID } from 'crypto';

import { Category, Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { RecallsRepository } from './recalls.repository';
import { SeafoodLotsRepository } from './seafood-lots.repository';

describe('RecallsRepository', () => {
  let prisma: PrismaService;
  let repository: RecallsRepository;
  let adminUserId: string;
  let vendorUserId: string;
  let customerId: string;
  let category: Category;
  let lotId: string;
  let lotIdTwo: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new RecallsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const lotsRepository = new SeafoodLotsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);
    const ordersRepository = new OrdersRepository(prisma);

    const adminRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.ADMINISTRATOR },
    });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });
    const customerRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });

    const adminUser = await usersRepository.create({
      email: `recalls-repo-admin-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Ana',
      lastName: 'Admin',
      roleId: adminRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    adminUserId = adminUser.id;

    const vendorUser = await usersRepository.create({
      email: `recalls-repo-vendor-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vera',
      lastName: 'Vendor',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    vendorUserId = vendorUser.id;

    const customer = await usersRepository.create({
      email: `recalls-repo-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendor = await vendorsRepository.create({
      userId: vendorUserId,
      businessName: "Vera's Catch",
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });

    const lot = await lotsRepository.create({
      lotNumber: `LOT-TEST-${randomUUID()}`,
      vendorId: vendor.id,
      species: 'Snapper',
      storageType: 'FRESH',
      catchDate: new Date(),
      weight: 20,
      weightUnit: 'POUNDS',
    });
    lotId = lot.id;

    const lotTwo = await lotsRepository.create({
      lotNumber: `LOT-TEST-${randomUUID()}`,
      vendorId: vendor.id,
      species: 'Snapper',
      storageType: 'FRESH',
      catchDate: new Date(),
      weight: 15,
      weightUnit: 'POUNDS',
    });
    lotIdTwo = lotTwo.id;

    category = await categoriesRepository.create({
      name: `Recalls Repo Category ${randomUUID()}`,
      slug: `recalls-repo-category-${randomUUID()}`,
    });

    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      lotId,
      name: 'Recalls Repo Snapper',
      description: 'Sold for recalls repository tests.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });

    await ordersRepository.create({
      customerId,
      deliveryAddressLine1: '1 Test Street',
      deliveryParish: 'KINGSTON',
      deliveryPhone: '+18765551234',
      vendorOrders: [
        {
          vendorId: vendor.id,
          subtotal: 1000,
          items: [
            {
              productId: product.id,
              productName: 'Recalls Repo Snapper',
              unitPrice: 500,
              unit: 'PER_POUND',
              quantity: 2,
              subtotal: 1000,
            },
          ],
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.recall.deleteMany({ where: { createdById: adminUserId } });
    await prisma.product.deleteMany({ where: { lotId: { in: [lotId, lotIdTwo] } } });
    await prisma.seafoodLot.deleteMany({ where: { id: { in: [lotId, lotIdTwo] } } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.user.delete({ where: { id: adminUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  it('creates a recall with linked lots, in DRAFT status', async () => {
    const recall = await repository.create({
      severityClass: 'CLASS_II',
      reason: 'Elevated histamine levels detected in post-market sampling',
      createdById: adminUserId,
      lotIds: [lotId, lotIdTwo],
    });

    expect(recall.status).toBe('DRAFT');
    expect(recall.lots).toHaveLength(2);
    expect(recall.lots.map((recallLot) => recallLot.lotId).sort()).toEqual([lotId, lotIdTwo].sort());
  });

  it('finds a recall by id with lots included, and returns null when missing', async () => {
    const created = await repository.create({
      severityClass: 'CLASS_I',
      reason: 'Confirmed pathogenic contamination in sampled product',
      createdById: adminUserId,
      lotIds: [lotId],
    });

    const found = await repository.findById(created.id);
    expect(found?.lots).toHaveLength(1);
    expect(found?.lots[0]?.lotId).toBe(lotId);

    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });

  it('updates recall status with root cause and resolution notes', async () => {
    const created = await repository.create({
      severityClass: 'CLASS_III',
      reason: 'Minor labeling non-compliance identified during audit',
      createdById: adminUserId,
      lotIds: [lotId],
    });

    const updated = await repository.updateStatus(created.id, 'ACTIVE', {
      rootCause: 'Contaminated ice supply at the packing facility',
    });
    expect(updated.status).toBe('ACTIVE');
    expect(updated.rootCause).toBe('Contaminated ice supply at the packing facility');
    expect(updated.lots).toHaveLength(1);
  });

  it('paginates recalls and includes the lots relation on every item', async () => {
    const { items, total } = await repository.findMany(undefined, { skip: 0, take: 20 });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(items.length).toBeGreaterThanOrEqual(1);
    // Regression guard: findMany must eagerly load `lots` so callers don't
    // silently receive recalls with an empty lotIds array.
    expect(items.some((item) => item.lots.length > 0)).toBe(true);
  });

  it('filters recalls by status', async () => {
    const { items, total } = await repository.findMany('DRAFT', { skip: 0, take: 20 });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(items.every((item) => item.status === 'DRAFT')).toBe(true);
  });

  it('finds affected order items for given lot ids', async () => {
    const orderItems = await repository.findAffectedOrderItems([lotId]);
    expect(orderItems.length).toBeGreaterThanOrEqual(1);
    expect(orderItems[0]?.product.lotId).toBe(lotId);
    expect(orderItems[0]?.vendorOrder.order.customerId).toBe(customerId);
    expect(orderItems[0]?.vendorOrder.order.customer.email).toContain('recalls-repo-customer-');
  });

  it('returns no affected order items for a lot with no linked products', async () => {
    const orderItems = await repository.findAffectedOrderItems([randomUUID()]);
    expect(orderItems).toHaveLength(0);
  });
});
