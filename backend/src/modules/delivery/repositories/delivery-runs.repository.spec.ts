import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { DeliveriesRepository } from './deliveries.repository';
import { DeliveryRunsRepository } from './delivery-runs.repository';
import { DriversRepository } from './drivers.repository';

describe('DeliveryRunsRepository', () => {
  let prisma: PrismaService;
  let repository: DeliveryRunsRepository;
  let zoneId: string;
  let deliveryId: string;
  let customerId: string;
  let vendorUserId: string;
  let driverUserId: string;
  let driverId: string;
  let categoryId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new DeliveryRunsRepository(prisma);

    const zone = await prisma.deliveryZone.findUniqueOrThrow({ where: { code: 'ZONE_1' } });
    zoneId = zone.id;

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);
    const driversRepository = new DriversRepository(prisma);
    const ordersRepository = new OrdersRepository(prisma);
    const vendorOrdersRepository = new VendorOrdersRepository(prisma);
    const deliveriesRepository = new DeliveriesRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });
    const driverRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.DRIVER } });

    const customer = await usersRepository.create({
      email: `delivery-runs-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `delivery-runs-vendor-${randomUUID()}@example.com`,
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
      businessName: 'Delivery Runs Test Vendor',
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });

    const driverUser = await usersRepository.create({
      email: `delivery-runs-driver-${randomUUID()}@example.com`,
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
      licensePlate: `RN ${randomUUID().slice(0, 4)}`,
      vehicleType: 'CAR',
      vehicleOwnership: 'PERSONAL_VEHICLE',
    });
    driverId = driver.id;

    const category = await categoriesRepository.create({
      name: `Delivery Runs Category ${randomUUID()}`,
      slug: `delivery-runs-category-${randomUUID()}`,
    });
    categoryId = category.id;

    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId,
      name: 'Delivery Runs Test Snapper',
      description: 'Used for delivery run repository tests.',
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
      deliveryZoneId: zoneId,
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
    const vendorOrderId = order.vendorOrders[0]!.id;
    await vendorOrdersRepository.updateStatus(vendorOrderId, 'READY_FOR_PICKUP');
    const delivery = await deliveriesRepository.create({ vendorOrderId, driverId });
    deliveryId = delivery.id;
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.driver.deleteMany({ where: { userId: driverUserId } });
    await prisma.vendor.deleteMany({ where: { userId: vendorUserId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.user.delete({ where: { id: driverUserId } });
    await prisma.category.delete({ where: { id: categoryId } });
    await prisma.onModuleDestroy();
  });

  it('creates a delivery run with ordered stops', async () => {
    const run = await repository.create({
      zoneId,
      stops: [{ deliveryId, sequence: 1 }],
    });

    expect(run.status).toBe('PLANNED');
    expect(run.driverId).toBeNull();
    expect(run.stops).toHaveLength(1);
    expect(run.stops[0]?.sequence).toBe(1);
  });

  it('finds a delivery run by id', async () => {
    const created = await repository.create({ zoneId, stops: [] });
    const found = await repository.findById(created.id);
    expect(found?.id).toBe(created.id);
  });

  it('returns null when a delivery run does not exist', async () => {
    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });

  it('assigns a driver to a run and transitions it to IN_PROGRESS', async () => {
    const created = await repository.create({ zoneId, stops: [] });
    const assigned = await repository.assign(created.id, { driverId });
    expect(assigned.driverId).toBe(driverId);
    expect(assigned.status).toBe('IN_PROGRESS');
  });
});
