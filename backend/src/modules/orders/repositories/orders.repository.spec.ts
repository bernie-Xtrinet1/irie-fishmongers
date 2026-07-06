import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { OrdersRepository } from './orders.repository';

describe('OrdersRepository', () => {
  let prisma: PrismaService;
  let repository: OrdersRepository;
  let customerId: string;
  let vendorAUserId: string;
  let vendorBUserId: string;
  let vendorA: Vendor;
  let vendorB: Vendor;
  let category: Category;
  let productAId: string;
  let productBId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new OrdersRepository(prisma);

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
      email: `orders-repo-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorAUser = await usersRepository.create({
      email: `orders-repo-vendor-a-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vera',
      lastName: 'A',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    vendorAUserId = vendorAUser.id;
    vendorA = await vendorsRepository.create({
      userId: vendorAUserId,
      businessName: 'Vendor A',
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });

    const vendorBUser = await usersRepository.create({
      email: `orders-repo-vendor-b-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vera',
      lastName: 'B',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    vendorBUserId = vendorBUser.id;
    vendorB = await vendorsRepository.create({
      userId: vendorBUserId,
      businessName: 'Vendor B',
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });

    category = await categoriesRepository.create({
      name: `Orders Repo Category ${randomUUID()}`,
      slug: `orders-repo-category-${randomUUID()}`,
    });

    const productA = await productsRepository.create({
      vendorId: vendorA.id,
      categoryId: category.id,
      name: 'Vendor A Snapper',
      description: 'Sold by vendor A for orders repository tests.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/a.jpg',
    });
    productAId = productA.id;

    const productB = await productsRepository.create({
      vendorId: vendorB.id,
      categoryId: category.id,
      name: 'Vendor B Shrimp',
      description: 'Sold by vendor B for orders repository tests.',
      unit: 'PER_POUND',
      price: 800,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/b.jpg',
    });
    productBId = productB.id;
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorAUserId } });
    await prisma.user.delete({ where: { id: vendorBUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  it('creates an order with multiple vendor sub-orders and nested items', async () => {
    const order = await repository.create({
      customerId,
      deliveryAddressLine1: '1 Test Street',
      deliveryParish: 'KINGSTON',
      deliveryPhone: '+18765551234',
      vendorOrders: [
        {
          vendorId: vendorA.id,
          subtotal: 1000,
          items: [
            {
              productId: productAId,
              productName: 'Vendor A Snapper',
              unitPrice: 500,
              unit: 'PER_POUND',
              quantity: 2,
              subtotal: 1000,
            },
          ],
        },
        {
          vendorId: vendorB.id,
          subtotal: 800,
          items: [
            {
              productId: productBId,
              productName: 'Vendor B Shrimp',
              unitPrice: 800,
              unit: 'PER_POUND',
              quantity: 1,
              subtotal: 800,
            },
          ],
        },
      ],
    });

    expect(order.vendorOrders).toHaveLength(2);
    expect(order.vendorOrders.every((vendorOrder) => vendorOrder.status === 'PENDING')).toBe(true);
    expect(order.vendorOrders.flatMap((vendorOrder) => vendorOrder.items)).toHaveLength(2);
  });

  it('finds an order by id with nested vendor orders and items', async () => {
    const created = await repository.create({
      customerId,
      deliveryAddressLine1: '1 Test Street',
      deliveryParish: 'KINGSTON',
      deliveryPhone: '+18765551234',
      vendorOrders: [
        {
          vendorId: vendorA.id,
          subtotal: 500,
          items: [
            {
              productId: productAId,
              productName: 'Vendor A Snapper',
              unitPrice: 500,
              unit: 'PER_POUND',
              quantity: 1,
              subtotal: 500,
            },
          ],
        },
      ],
    });

    const found = await repository.findById(created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.vendorOrders[0]?.items[0]?.productName).toBe('Vendor A Snapper');
  });

  it('returns null when an order cannot be found', async () => {
    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });

  it("paginates a customer's orders", async () => {
    const { items, total } = await repository.findManyByCustomer(customerId, {
      skip: 0,
      take: 1,
    });
    expect(total).toBeGreaterThanOrEqual(2);
    expect(items).toHaveLength(1);
  });
});
