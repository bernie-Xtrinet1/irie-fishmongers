import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { VendorSalesRepository } from './vendor-sales.repository';

describe('VendorSalesRepository', () => {
  let prisma: PrismaService;
  let repository: VendorSalesRepository;
  let productsRepository: ProductsRepository;
  let ordersRepository: OrdersRepository;
  let customerId: string;
  let vendorUserId: string;
  let vendor: Vendor;
  let category: Category;
  let productId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new VendorSalesRepository(prisma);
    productsRepository = new ProductsRepository(prisma);
    ordersRepository = new OrdersRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });

    const customer = await usersRepository.create({
      email: `vendor-sales-repo-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `vendor-sales-repo-vendor-${randomUUID()}@example.com`,
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
      name: `Vendor Sales Repo Category ${randomUUID()}`,
      slug: `vendor-sales-repo-category-${randomUUID()}`,
    });

    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Vendor Sales Repo Snapper',
      description: 'Sold for vendor-sales repository tests.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    productId = product.id;
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  async function createVendorOrder(subtotal: number): Promise<string> {
    const order = await ordersRepository.create({
      customerId,
      deliveryAddressLine1: '1 Test Street',
      deliveryParish: 'KINGSTON',
      deliveryPhone: '+18765551234',
      vendorOrders: [
        {
          vendorId: vendor.id,
          subtotal,
          items: [
            {
              productId,
              productName: 'Vendor Sales Repo Snapper',
              unitPrice: 500,
              unit: 'PER_POUND',
              quantity: subtotal / 500,
              subtotal,
            },
          ],
        },
      ],
    });
    return order.vendorOrders[0]!.id;
  }

  describe('countActiveListings', () => {
    it('counts only active products for the vendor', async () => {
      const countBefore = await repository.countActiveListings(vendor.id);

      const active = await productsRepository.create({
        vendorId: vendor.id,
        categoryId: category.id,
        name: 'Active Listing',
        description: 'An active listing for counting.',
        unit: 'PER_POUND',
        price: 400,
        quantityAvailable: 10,
        imageUrl: 'https://cdn.example.com/active.jpg',
      });
      const inactive = await productsRepository.create({
        vendorId: vendor.id,
        categoryId: category.id,
        name: 'Inactive Listing',
        description: 'An inactive listing that should not be counted.',
        unit: 'PER_POUND',
        price: 400,
        quantityAvailable: 10,
        imageUrl: 'https://cdn.example.com/inactive.jpg',
      });
      await productsRepository.setActive(inactive.id, false);

      const countAfter = await repository.countActiveListings(vendor.id);
      expect(countAfter).toBe(countBefore + 1);
      expect(active.isActive).toBe(true);
    });

    it('returns 0 for a vendor with no products', async () => {
      const count = await repository.countActiveListings(randomUUID());
      expect(count).toBe(0);
    });
  });

  describe('sumVendorOrderSubtotalsSince', () => {
    it('sums subtotals of vendor orders created since the given date', async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const before = await repository.sumVendorOrderSubtotalsSince(vendor.id, since);

      await createVendorOrder(1500);

      const after = await repository.sumVendorOrderSubtotalsSince(vendor.id, since);
      expect(after).toBe(before + 1500);
    });

    it('excludes REJECTED and CANCELLED vendor orders from the sum', async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const before = await repository.sumVendorOrderSubtotalsSince(vendor.id, since);

      const rejectedId = await createVendorOrder(2000);
      await prisma.vendorOrder.update({ where: { id: rejectedId }, data: { status: 'REJECTED' } });

      const cancelledId = await createVendorOrder(3000);
      await prisma.vendorOrder.update({ where: { id: cancelledId }, data: { status: 'CANCELLED' } });

      const after = await repository.sumVendorOrderSubtotalsSince(vendor.id, since);
      expect(after).toBe(before);
    });

    it('excludes vendor orders created before the given date', async () => {
      await createVendorOrder(1000);
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const sum = await repository.sumVendorOrderSubtotalsSince(vendor.id, future);
      expect(sum).toBe(0);
    });

    it('returns 0 when the vendor has no matching vendor orders', async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const sum = await repository.sumVendorOrderSubtotalsSince(randomUUID(), since);
      expect(sum).toBe(0);
    });
  });
});
