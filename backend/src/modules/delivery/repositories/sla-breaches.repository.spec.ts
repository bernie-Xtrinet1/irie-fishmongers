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
import { DriversRepository } from './drivers.repository';
import { SLABreachesRepository } from './sla-breaches.repository';

describe('SLABreachesRepository', () => {
  let prisma: PrismaService;
  let repository: SLABreachesRepository;
  let delivery: Delivery;
  let zoneId: string;
  let customerId: string;
  let vendorUserId: string;
  let driverUserId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new SLABreachesRepository(prisma);

    const zone = await prisma.deliveryZone.findUniqueOrThrow({ where: { code: 'ZONE_1' } });
    zoneId = zone.id;

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
      email: `sla-breaches-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `sla-breaches-vendor-${randomUUID()}@example.com`,
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
      businessName: 'SLA Breaches Test Vendor',
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });

    const driverUser = await usersRepository.create({
      email: `sla-breaches-driver-${randomUUID()}@example.com`,
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
      licensePlate: `SL ${randomUUID().slice(0, 4)}`,
      vehicleType: 'CAR',
      vehicleOwnership: 'PERSONAL_VEHICLE',
    });

    const category = await categoriesRepository.create({
      name: `SLA Breaches Category ${randomUUID()}`,
      slug: `sla-breaches-category-${randomUUID()}`,
    });
    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'SLA Breaches Test Snapper',
      description: 'Used for SLA breach repository tests.',
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
    const vendorOrder = order.vendorOrders[0]!;
    await vendorOrdersRepository.updateStatus(vendorOrder.id, 'READY_FOR_PICKUP');

    delivery = await deliveriesRepository.create({ vendorOrderId: vendorOrder.id, driverId: driver.id });
  });

  afterAll(async () => {
    await prisma.sLABreach.deleteMany({ where: { deliveryId: delivery.id } });
    await prisma.delivery.deleteMany({ where: { id: delivery.id } });
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.driver.deleteMany({ where: { userId: driverUserId } });
    await prisma.vendor.deleteMany({ where: { userId: vendorUserId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.user.delete({ where: { id: driverUserId } });
    await prisma.onModuleDestroy();
  });

  it('creates an SLA breach', async () => {
    const scheduledEnd = new Date('2026-07-08T10:00:00.000Z');
    const breach = await repository.upsert({
      deliveryId: delivery.id,
      type: 'OVERDUE_IN_TRANSIT',
      scheduledEnd,
      minutesLate: 30,
    });

    expect(breach.resolved).toBe(false);
    expect(breach.deliveryId).toBe(delivery.id);
    expect(breach.minutesLate).toBe(30);
  });

  it('is idempotent for the same (delivery, type) pair - a re-detected breach keeps its original values', async () => {
    const first = await repository.upsert({
      deliveryId: delivery.id,
      type: 'LATE_DELIVERY',
      scheduledEnd: new Date('2026-07-08T10:00:00.000Z'),
      minutesLate: 15,
    });

    const second = await repository.upsert({
      deliveryId: delivery.id,
      type: 'LATE_DELIVERY',
      scheduledEnd: new Date('2026-07-08T10:00:00.000Z'),
      minutesLate: 999,
    });

    expect(second.id).toBe(first.id);
    expect(second.minutesLate).toBe(15);
  });

  it('finds an SLA breach by id', async () => {
    const created = await repository.upsert({
      deliveryId: delivery.id,
      type: 'OVERDUE_IN_TRANSIT',
      scheduledEnd: new Date(),
      minutesLate: 5,
    });

    const found = await repository.findById(created.id);
    expect(found?.id).toBe(created.id);
  });

  it('resolves an SLA breach', async () => {
    const created = await repository.upsert({
      deliveryId: delivery.id,
      type: 'LATE_DELIVERY',
      scheduledEnd: new Date(),
      minutesLate: 5,
    });

    const resolved = await repository.resolve(created.id, customerId);
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolvedById).toBe(customerId);
    expect(resolved.resolvedAt).not.toBeNull();
  });

  describe('findMany', () => {
    it('filters by resolution status and paginates', async () => {
      const { items, total } = await repository.findMany({ resolved: false }, { skip: 0, take: 20 });
      expect(total).toBeGreaterThanOrEqual(1);
      expect(items.every((item) => !item.resolved)).toBe(true);
    });

    it('filters by type', async () => {
      const { items } = await repository.findMany({ type: 'OVERDUE_IN_TRANSIT' }, { skip: 0, take: 20 });
      expect(items.every((item) => item.type === 'OVERDUE_IN_TRANSIT')).toBe(true);
    });
  });

  describe('findOverdueInTransitCandidates', () => {
    it('does not return this delivery - it already has an OVERDUE_IN_TRANSIT breach from an earlier test', async () => {
      const candidates = await repository.findOverdueInTransitCandidates(new Date('2100-01-01'));
      expect(candidates.some((candidate) => candidate.id === delivery.id)).toBe(false);
    });
  });

  describe('getBreachCountsByZone', () => {
    it('includes this zone with at least one breach', async () => {
      const summary = await repository.getBreachCountsByZone();
      const zoneSummary = summary.find((entry) => entry.zoneId === zoneId);
      expect(zoneSummary).toBeDefined();
      expect(zoneSummary?.totalBreaches).toBeGreaterThanOrEqual(1);
    });
  });
});
