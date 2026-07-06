import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { PaymentsRepository } from '../../payments/repositories/payments.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { VendorSettlementsRepository } from './vendor-settlements.repository';

describe('VendorSettlementsRepository', () => {
  let prisma: PrismaService;
  let repository: VendorSettlementsRepository;
  let customerId: string;
  let vendorUserId: string;
  let vendor: Vendor;
  let category: Category;
  let deliveredVendorOrderId: string;

  async function createOrder(status: 'DELIVERED' | 'READY_FOR_PICKUP', paid: boolean): Promise<string> {
    const ordersRepository = new OrdersRepository(prisma);
    const vendorOrdersRepository = new VendorOrdersRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);
    const paymentsRepository = new PaymentsRepository(prisma);

    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: `Settlement Repo Snapper ${randomUUID()}`,
      description: 'Sold for vendor settlement repository tests.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });

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
              productId: product.id,
              productName: 'Settlement Repo Snapper',
              unitPrice: 500,
              unit: 'PER_POUND',
              quantity: 2,
              subtotal: 1000,
            },
          ],
        },
      ],
    });
    const vendorOrderId = order.vendorOrders[0]!.id;
    await vendorOrdersRepository.updateStatus(vendorOrderId, status);

    const payment = await paymentsRepository.create({
      orderId: order.id,
      provider: 'CASH_ON_DELIVERY',
      amount: 1000,
      currency: 'JMD',
    });
    if (paid) {
      await paymentsRepository.update(payment.id, { status: 'PAID', paidAt: new Date() });
    }

    return vendorOrderId;
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new VendorSettlementsRepository(prisma);

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
      email: `vendor-settlement-repo-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `vendor-settlement-repo-vendor-${randomUUID()}@example.com`,
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
      name: `Vendor Settlement Repo Category ${randomUUID()}`,
      slug: `vendor-settlement-repo-category-${randomUUID()}`,
    });

    deliveredVendorOrderId = await createOrder('DELIVERED', true);
  });

  afterAll(async () => {
    await prisma.vendorSettlement.deleteMany({ where: { vendorId: vendor.id } });
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  it('finds delivered-and-paid vendor orders with no settlement yet', async () => {
    const eligible = await repository.findEligibleVendorOrders();
    expect(eligible.some((vendorOrder) => vendorOrder.id === deliveredVendorOrderId)).toBe(true);
  });

  it('excludes vendor orders that are not yet delivered', async () => {
    const readyVendorOrderId = await createOrder('READY_FOR_PICKUP', true);
    const eligible = await repository.findEligibleVendorOrders();
    expect(eligible.some((vendorOrder) => vendorOrder.id === readyVendorOrderId)).toBe(false);
  });

  it('excludes delivered vendor orders whose payment is not yet paid', async () => {
    const unpaidVendorOrderId = await createOrder('DELIVERED', false);
    const eligible = await repository.findEligibleVendorOrders();
    expect(eligible.some((vendorOrder) => vendorOrder.id === unpaidVendorOrderId)).toBe(false);
  });

  it('creates a settlement row', async () => {
    const settlement = await repository.create({
      vendorId: vendor.id,
      vendorOrderId: deliveredVendorOrderId,
      grossAmount: 1000,
      platformFee: 100,
      netAmount: 900,
    });
    expect(settlement.status).toBe('PENDING');
    expect(settlement.netAmount.toNumber()).toBe(900);
  });

  it('no longer lists the settled vendor order as eligible', async () => {
    const eligible = await repository.findEligibleVendorOrders();
    expect(eligible.some((vendorOrder) => vendorOrder.id === deliveredVendorOrderId)).toBe(false);
  });

  it('finds a settlement by id', async () => {
    const settlement = await prisma.vendorSettlement.findFirstOrThrow({
      where: { vendorOrderId: deliveredVendorOrderId },
    });
    const found = await repository.findById(settlement.id);
    expect(found?.vendorOrderId).toBe(deliveredVendorOrderId);
  });

  it('updates a settlement status and sets a payment date', async () => {
    const settlement = await prisma.vendorSettlement.findFirstOrThrow({
      where: { vendorOrderId: deliveredVendorOrderId },
    });
    const approved = await repository.updateStatus(settlement.id, 'APPROVED');
    expect(approved.status).toBe('APPROVED');

    const paidAt = new Date();
    const paid = await repository.updateStatus(settlement.id, 'PAID', { paymentDate: paidAt });
    expect(paid.status).toBe('PAID');
    expect(paid.paymentDate?.getTime()).toBe(paidAt.getTime());
  });

  it("paginates a vendor's settlements", async () => {
    const { items, total } = await repository.findManyByVendor(vendor.id, { skip: 0, take: 20 });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(items.every((item) => item.vendorId === vendor.id)).toBe(true);
  });

  it('filters the admin listing by vendorId and status', async () => {
    const { items, total } = await repository.findMany(
      { vendorId: vendor.id, status: 'PAID' },
      { skip: 0, take: 20 },
    );
    expect(total).toBeGreaterThanOrEqual(1);
    expect(items.every((item) => item.status === 'PAID')).toBe(true);
  });

  it('returns all settlements when no filters are given', async () => {
    const { items, total } = await repository.findMany({}, { skip: 0, take: 20 });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(items.some((item) => item.vendorId === vendor.id)).toBe(true);
  });
});
