import { randomUUID } from 'crypto';

import { Delivery, Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { DeliveriesRepository } from './deliveries.repository';
import { DeliveryExceptionsRepository } from './delivery-exceptions.repository';
import { DriversRepository } from './drivers.repository';

describe('DeliveryExceptionsRepository', () => {
  let prisma: PrismaService;
  let repository: DeliveryExceptionsRepository;
  let delivery: Delivery;
  let customerId: string;
  let vendorUserId: string;
  let driverUserId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new DeliveryExceptionsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);
    const ordersRepository = new OrdersRepository(prisma);
    const vendorOrdersRepository = new VendorOrdersRepository(prisma);
    const driversRepository = new DriversRepository(prisma);
    const deliveriesRepository = new DeliveriesRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });
    const driverRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.DRIVER } });

    const customer = await usersRepository.create({
      email: `delivery-exceptions-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `delivery-exceptions-vendor-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vera',
      lastName: 'Vendor',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    vendorUserId = vendorUser.id;
    const vendor = await vendorsRepository.create({
      userId: vendorUserId,
      businessName: 'Exceptions Test Vendor',
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });

    const driverUser = await usersRepository.create({
      email: `delivery-exceptions-driver-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Dana',
      lastName: 'Driver',
      roleId: driverRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    driverUserId = driverUser.id;
    const driver = await driversRepository.create({
      userId: driverUserId,
      licensePlate: `EX ${randomUUID().slice(0, 4)}`,
      vehicleType: 'CAR',
      vehicleOwnership: 'PERSONAL_VEHICLE',
    });

    const category = await categoriesRepository.create({
      name: `Delivery Exceptions Category ${randomUUID()}`,
      slug: `delivery-exceptions-category-${randomUUID()}`,
    });
    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Exceptions Test Snapper',
      description: 'Used for delivery exception repository tests.',
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
          subtotal: 500,
          items: [
            {
              productId: product.id,
              productName: product.name,
              unitPrice: 500,
              unit: 'PER_POUND',
              quantity: 1,
              subtotal: 500,
            },
          ],
        },
      ],
    });
    const vendorOrder = order.vendorOrders[0]!;
    await vendorOrdersRepository.updateStatus(vendorOrder.id, 'READY_FOR_PICKUP');

    delivery = await deliveriesRepository.create({ vendorOrderId: vendorOrder.id, driverId: driver.id });
  });

  afterAll(async () => {
    await prisma.deliveryException.deleteMany({ where: { deliveryId: delivery.id } });
    await prisma.delivery.deleteMany({ where: { id: delivery.id } });
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.driver.deleteMany({ where: { userId: driverUserId } });
    await prisma.vendor.deleteMany({ where: { userId: vendorUserId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.user.delete({ where: { id: driverUserId } });
    await prisma.onModuleDestroy();
  });

  it('creates a delivery exception', async () => {
    const exception = await repository.create({
      deliveryId: delivery.id,
      type: 'VEHICLE_BREAKDOWN',
      reason: 'Flat tire on the highway',
      photos: ['https://cdn.example.com/flat-tire.jpg'],
    });

    expect(exception.resolved).toBe(false);
    expect(exception.deliveryId).toBe(delivery.id);
  });

  it('finds an exception by id', async () => {
    const created = await repository.create({
      deliveryId: delivery.id,
      type: 'TRAFFIC_DELAY',
      reason: 'Major road closure downtown',
      photos: [],
    });

    const found = await repository.findById(created.id);
    expect(found?.id).toBe(created.id);
  });

  it('resolves an exception', async () => {
    const created = await repository.create({
      deliveryId: delivery.id,
      type: 'WEATHER_DELAY',
      reason: 'Heavy rain flooding the route',
      photos: [],
    });

    const resolved = await repository.resolve(created.id, customerId);
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolvedById).toBe(customerId);
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it('finds all exceptions for a delivery', async () => {
    const items = await repository.findByDeliveryId(delivery.id);
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.every((item) => item.deliveryId === delivery.id)).toBe(true);
  });

  describe('findManyWithContext', () => {
    it('filters by resolution status and paginates', async () => {
      const { items, total } = await repository.findManyWithContext(false, { skip: 0, take: 20 });
      expect(total).toBeGreaterThanOrEqual(2);
      expect(items.every((item) => !item.resolved)).toBe(true);
    });

    it('returns all exceptions when no filter is given', async () => {
      const { items } = await repository.findManyWithContext(undefined, { skip: 0, take: 20 });
      expect(items.length).toBeGreaterThanOrEqual(3);
    });

    it('includes vendor/customer/driver context for each item', async () => {
      const { items } = await repository.findManyWithContext(undefined, { skip: 0, take: 20 });
      const item = items.find((candidate) => candidate.deliveryId === delivery.id);
      expect(item?.delivery.vendorOrder.vendor.businessName).toBe('Exceptions Test Vendor');
      expect(item?.delivery.vendorOrder.order.customer.firstName).toBe('Cara');
      expect(item?.delivery.driver.user.firstName).toBe('Dana');
    });
  });
});
