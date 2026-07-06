import { randomUUID } from 'crypto';

import { Category, Payment, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { PaymentsRepository } from './payments.repository';
import { RefundsRepository } from './refunds.repository';

describe('RefundsRepository', () => {
  let prisma: PrismaService;
  let repository: RefundsRepository;
  let customerId: string;
  let vendorUserId: string;
  let category: Category;
  let payment: Payment;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new RefundsRepository(prisma);
    const paymentsRepository = new PaymentsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);
    const ordersRepository = new OrdersRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });

    const customer = await usersRepository.create({
      email: `refund-repo-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `refund-repo-vendor-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vera',
      lastName: 'Vendor',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    vendorUserId = vendorUser.id;
    const vendor: Vendor = await vendorsRepository.create({
      userId: vendorUserId,
      businessName: "Vera's Catch",
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });

    category = await categoriesRepository.create({
      name: `Refund Repo Category ${randomUUID()}`,
      slug: `refund-repo-category-${randomUUID()}`,
    });

    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Refund Repo Snapper',
      description: 'Sold for refund repository tests.',
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
              productName: 'Refund Repo Snapper',
              unitPrice: 500,
              unit: 'PER_POUND',
              quantity: 2,
              subtotal: 1000,
            },
          ],
        },
      ],
    });

    payment = await paymentsRepository.create({
      orderId: order.id,
      provider: 'CASH_ON_DELIVERY',
      amount: 1000,
      currency: 'JMD',
    });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  it('creates a refund for a payment', async () => {
    const refund = await repository.create({
      paymentId: payment.id,
      amount: 400,
      reason: 'Vendor rejected order',
      status: 'COMPLETED',
    });
    expect(refund.paymentId).toBe(payment.id);
    expect(refund.status).toBe('COMPLETED');
  });

  it('lists refunds for a payment ordered by creation time', async () => {
    await repository.create({
      paymentId: payment.id,
      amount: 100,
      reason: 'Partial admin adjustment',
      status: 'PENDING',
    });

    const refunds = await repository.findByPaymentId(payment.id);
    expect(refunds.length).toBeGreaterThanOrEqual(2);
    expect(refunds[0]!.createdAt.getTime()).toBeLessThanOrEqual(refunds[1]!.createdAt.getTime());
  });

  it('sums only completed refunds for a payment', async () => {
    const total = await repository.sumCompletedByPaymentId(payment.id);
    expect(total).toBe(400);
  });

  it('returns zero when a payment has no completed refunds', async () => {
    await expect(repository.sumCompletedByPaymentId(randomUUID())).resolves.toBe(0);
  });
});
