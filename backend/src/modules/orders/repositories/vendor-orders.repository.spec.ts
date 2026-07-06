import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { OrdersRepository } from './orders.repository';
import { VendorOrdersRepository } from './vendor-orders.repository';

describe('VendorOrdersRepository', () => {
  let prisma: PrismaService;
  let ordersRepository: OrdersRepository;
  let repository: VendorOrdersRepository;
  let customerId: string;
  let vendorUserId: string;
  let vendor: Vendor;
  let category: Category;
  let productId: string;
  let vendorOrderId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    ordersRepository = new OrdersRepository(prisma);
    repository = new VendorOrdersRepository(prisma);

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
      email: `vo-repo-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `vo-repo-vendor-${randomUUID()}@example.com`,
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
      name: `VO Repo Category ${randomUUID()}`,
      slug: `vo-repo-category-${randomUUID()}`,
    });

    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'VO Repo Snapper',
      description: 'Sold for vendor-order repository tests.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    productId = product.id;

    const order = await ordersRepository.create({
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
              productId,
              productName: 'VO Repo Snapper',
              unitPrice: 500,
              unit: 'PER_POUND',
              quantity: 2,
              subtotal: 1000,
            },
          ],
        },
      ],
    });
    vendorOrderId = order.vendorOrders[0]!.id;
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  it('finds a vendor order by id with items and the parent order', async () => {
    const found = await repository.findById(vendorOrderId);
    expect(found?.vendorId).toBe(vendor.id);
    expect(found?.items).toHaveLength(1);
    expect(found?.order.customerId).toBe(customerId);
  });

  it('returns null for a vendor order that does not exist', async () => {
    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });

  it('updates a vendor order status', async () => {
    const updated = await repository.updateStatus(vendorOrderId, 'ACCEPTED');
    expect(updated.status).toBe('ACCEPTED');
  });

  it("paginates and filters a vendor's orders by status", async () => {
    const { items, total } = await repository.findManyByVendor(vendor.id, 'ACCEPTED', {
      skip: 0,
      take: 20,
    });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(items.every((item) => item.status === 'ACCEPTED')).toBe(true);
  });

  it('returns all vendor orders when no status filter is given', async () => {
    const { items } = await repository.findManyByVendor(vendor.id, undefined, {
      skip: 0,
      take: 20,
    });
    expect(items.length).toBeGreaterThanOrEqual(1);
  });
});
