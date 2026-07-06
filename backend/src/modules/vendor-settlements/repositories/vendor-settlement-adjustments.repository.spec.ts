import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor, VendorSettlement } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { PaymentsRepository } from '../../payments/repositories/payments.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { VendorSettlementAdjustmentsRepository } from './vendor-settlement-adjustments.repository';
import { VendorSettlementsRepository } from './vendor-settlements.repository';

describe('VendorSettlementAdjustmentsRepository', () => {
  let prisma: PrismaService;
  let repository: VendorSettlementAdjustmentsRepository;
  let customerId: string;
  let vendorUserId: string;
  let vendor: Vendor;
  let category: Category;
  let settlement: VendorSettlement;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new VendorSettlementAdjustmentsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);
    const ordersRepository = new OrdersRepository(prisma);
    const vendorOrdersRepository = new VendorOrdersRepository(prisma);
    const paymentsRepository = new PaymentsRepository(prisma);
    const vendorSettlementsRepository = new VendorSettlementsRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });

    const customer = await usersRepository.create({
      email: `adjustment-repo-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `adjustment-repo-vendor-${randomUUID()}@example.com`,
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
      name: `Adjustment Repo Category ${randomUUID()}`,
      slug: `adjustment-repo-category-${randomUUID()}`,
    });

    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Adjustment Repo Snapper',
      description: 'Sold for adjustment repository tests.',
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
              productName: 'Adjustment Repo Snapper',
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
    await vendorOrdersRepository.updateStatus(vendorOrderId, 'DELIVERED');
    const payment = await paymentsRepository.create({
      orderId: order.id,
      provider: 'CASH_ON_DELIVERY',
      amount: 1000,
      currency: 'JMD',
    });
    await paymentsRepository.update(payment.id, { status: 'PAID', paidAt: new Date() });

    settlement = await vendorSettlementsRepository.create({
      vendorId: vendor.id,
      vendorOrderId,
      grossAmount: 1000,
      platformFee: 100,
      netAmount: 900,
    });
  });

  afterAll(async () => {
    await prisma.vendorSettlement.deleteMany({ where: { vendorId: vendor.id } });
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  it('returns 0 when a settlement has no adjustments yet', async () => {
    await expect(repository.sumBySettlementId(settlement.id)).resolves.toBe(0);
    await expect(repository.findBySettlementId(settlement.id)).resolves.toHaveLength(0);
  });

  it('creates a negative clawback adjustment', async () => {
    const adjustment = await repository.create({
      settlementId: settlement.id,
      amount: -400,
      reason: 'Partial refund issued for damaged goods',
    });
    expect(adjustment.amount.toNumber()).toBe(-400);
  });

  it('creates a second, positive adjustment', async () => {
    await repository.create({
      settlementId: settlement.id,
      amount: 100,
      reason: 'Goodwill correction after dispute resolution',
    });

    const adjustments = await repository.findBySettlementId(settlement.id);
    expect(adjustments).toHaveLength(2);
    expect(adjustments[0]!.createdAt.getTime()).toBeLessThanOrEqual(adjustments[1]!.createdAt.getTime());
  });

  it('sums all adjustments for a settlement', async () => {
    await expect(repository.sumBySettlementId(settlement.id)).resolves.toBe(-300);
  });
});
