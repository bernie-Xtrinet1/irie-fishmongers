import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { PaymentsRepository } from './payments.repository';

describe('PaymentsRepository', () => {
  let prisma: PrismaService;
  let repository: PaymentsRepository;
  let customerId: string;
  let vendorUserId: string;
  let category: Category;
  let orderId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new PaymentsRepository(prisma);

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
      email: `payment-repo-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `payment-repo-vendor-${randomUUID()}@example.com`,
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
      name: `Payment Repo Category ${randomUUID()}`,
      slug: `payment-repo-category-${randomUUID()}`,
    });

    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Payment Repo Snapper',
      description: 'Sold for payment repository tests.',
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
              productName: 'Payment Repo Snapper',
              unitPrice: 500,
              unit: 'PER_POUND',
              quantity: 2,
              subtotal: 1000,
            },
          ],
        },
      ],
    });
    orderId = order.id;
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  it('creates a payment for an order', async () => {
    const payment = await repository.create({
      orderId,
      provider: 'CASH_ON_DELIVERY',
      amount: 1000,
      currency: 'JMD',
    });
    expect(payment.orderId).toBe(orderId);
    expect(payment.status).toBe('PENDING');
  });

  it('finds a payment by id', async () => {
    const created = await repository.findByOrderId(orderId);
    const found = await repository.findById(created!.id);
    expect(found?.orderId).toBe(orderId);
  });

  it('returns null when a payment id does not exist', async () => {
    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });

  it('finds a payment by order id', async () => {
    const found = await repository.findByOrderId(orderId);
    expect(found?.orderId).toBe(orderId);
  });

  it('returns null when an order has no payment', async () => {
    await expect(repository.findByOrderId(randomUUID())).resolves.toBeNull();
  });

  it('finds a payment by provider reference', async () => {
    const existing = await repository.findByOrderId(orderId);
    const updated = await repository.update(existing!.id, { providerReference: 'ref-123' });
    const found = await repository.findByProviderReference('ref-123');
    expect(found?.id).toBe(updated.id);
  });

  it('returns null when no payment matches the provider reference', async () => {
    await expect(repository.findByProviderReference('missing-ref')).resolves.toBeNull();
  });

  it('updates a payment status and paidAt', async () => {
    const existing = await repository.findByOrderId(orderId);
    const paidAt = new Date();
    const updated = await repository.update(existing!.id, { status: 'PAID', paidAt });
    expect(updated.status).toBe('PAID');
    expect(updated.paidAt?.getTime()).toBe(paidAt.getTime());
  });
});
