import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { DeliveriesRepository } from '../../delivery/repositories/deliveries.repository';
import { DriversRepository } from '../../delivery/repositories/drivers.repository';
import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { DriverSettlementsRepository } from './driver-settlements.repository';

describe('DriverSettlementsRepository', () => {
  let prisma: PrismaService;
  let repository: DriverSettlementsRepository;
  let customerId: string;
  let vendorUserId: string;
  let driverUserId: string;
  let driverId: string;
  let category: Category;
  let deliveredVendorOrderId: string;
  let deliveryId: string;
  const periodStart = new Date('2026-06-29T05:00:00.000Z');
  const periodEnd = new Date('2026-07-06T04:59:59.999Z');

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new DriverSettlementsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);
    const driversRepository = new DriversRepository(prisma);
    const ordersRepository = new OrdersRepository(prisma);
    const vendorOrdersRepository = new VendorOrdersRepository(prisma);
    const deliveriesRepository = new DeliveriesRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });
    const driverRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.DRIVER },
    });

    const customer = await usersRepository.create({
      email: `settlement-repo-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `settlement-repo-vendor-${randomUUID()}@example.com`,
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

    const driverUser = await usersRepository.create({
      email: `settlement-repo-driver-${randomUUID()}@example.com`,
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
      licensePlate: 'AB 1234',
      vehicleType: 'CAR',
      vehicleOwnership: 'PERSONAL_VEHICLE',
    });
    driverId = driver.id;

    category = await categoriesRepository.create({
      name: `Settlement Repo Category ${randomUUID()}`,
      slug: `settlement-repo-category-${randomUUID()}`,
    });

    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Settlement Repo Snapper',
      description: 'Sold for driver settlement repository tests.',
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
    deliveredVendorOrderId = order.vendorOrders[0]!.id;
    await vendorOrdersRepository.updateStatus(deliveredVendorOrderId, 'READY_FOR_PICKUP');

    const delivery = await deliveriesRepository.create({
      vendorOrderId: deliveredVendorOrderId,
      driverId,
    });
    await deliveriesRepository.markPickedUp(delivery.id);
    const delivered = await deliveriesRepository.markDelivered(
      delivery.id,
      'PHOTO',
      'https://cdn.example.com/proof.jpg',
    );
    deliveryId = delivered.id;

    // Backdate deliveredAt into the fixed test settlement period so
    // findUnsettledDeliveries can find it deterministically.
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { deliveredAt: new Date(periodStart.getTime() + 24 * 60 * 60 * 1000) },
    });
  });

  afterAll(async () => {
    await prisma.driverSettlement.deleteMany({ where: { driverId } });
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.user.delete({ where: { id: driverUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  it('finds delivered vendor orders in the period that have no settlement yet', async () => {
    const deliveries = await repository.findUnsettledDeliveries(periodStart, periodEnd);
    expect(deliveries.some((delivery) => delivery.id === deliveryId)).toBe(true);
    const found = deliveries.find((delivery) => delivery.id === deliveryId)!;
    expect(found.driver.id).toBe(driverId);
    expect(found.vendorOrder.items).toHaveLength(1);
  });

  it('creates a per-delivery settlement row', async () => {
    const settlement = await repository.create({
      driverId,
      deliveryId,
      vehicleOwnership: 'PERSONAL_VEHICLE',
      baseFee: 150,
      distanceKm: 12,
      distanceFee: 240,
      heavyLoadBonus: 0,
      peakBonus: 0,
      volumeBonus: 0,
      totalPayout: 390,
      settlementPeriodStart: periodStart,
      settlementPeriodEnd: periodEnd,
    });

    expect(settlement.totalPayout.toNumber()).toBe(390);
    expect(settlement.status).toBe('PENDING');
  });

  it('no longer lists the settled delivery as unsettled', async () => {
    const deliveries = await repository.findUnsettledDeliveries(periodStart, periodEnd);
    expect(deliveries.some((delivery) => delivery.id === deliveryId)).toBe(false);
  });

  it('finds a settlement by id', async () => {
    const settlement = await prisma.driverSettlement.findFirstOrThrow({ where: { deliveryId } });
    const found = await repository.findById(settlement.id);
    expect(found?.deliveryId).toBe(deliveryId);
  });

  it('counts settled deliveries for a driver within a period', async () => {
    const count = await repository.countDeliveriesInPeriod(driverId, periodStart, periodEnd);
    expect(count).toBe(1);
  });

  it('returns null when no volume bonus row exists yet for a driver and period', async () => {
    await expect(
      repository.findVolumeBonusRow(driverId, periodStart, periodEnd),
    ).resolves.toBeNull();
  });

  it('creates a volume-bonus-only row with no deliveryId', async () => {
    const bonusRow = await repository.create({
      driverId,
      vehicleOwnership: 'PERSONAL_VEHICLE',
      baseFee: 0,
      distanceKm: 0,
      distanceFee: 0,
      heavyLoadBonus: 0,
      peakBonus: 0,
      volumeBonus: 1000,
      totalPayout: 1000,
      settlementPeriodStart: periodStart,
      settlementPeriodEnd: periodEnd,
    });

    expect(bonusRow.deliveryId).toBeNull();
    const found = await repository.findVolumeBonusRow(driverId, periodStart, periodEnd);
    expect(found?.id).toBe(bonusRow.id);
  });

  it('updates a settlement status and sets a payout date', async () => {
    const settlement = await prisma.driverSettlement.findFirstOrThrow({ where: { deliveryId } });
    const approved = await repository.updateStatus(settlement.id, 'APPROVED');
    expect(approved.status).toBe('APPROVED');

    const paidAt = new Date();
    const paid = await repository.updateStatus(settlement.id, 'PAID', { payoutDate: paidAt });
    expect(paid.status).toBe('PAID');
    expect(paid.payoutDate?.getTime()).toBe(paidAt.getTime());
  });

  it("paginates a driver's settlements", async () => {
    const { items, total } = await repository.findManyByDriver(driverId, { skip: 0, take: 20 });
    expect(total).toBeGreaterThanOrEqual(2);
    expect(items.every((item) => item.driverId === driverId)).toBe(true);
  });

  it('filters the admin listing by driverId and status', async () => {
    const { items, total } = await repository.findMany(
      { driverId, status: 'PAID' },
      { skip: 0, take: 20 },
    );
    expect(total).toBeGreaterThanOrEqual(1);
    expect(items.every((item) => item.status === 'PAID')).toBe(true);
  });

  it('returns all settlements when no filters are given', async () => {
    const { items, total } = await repository.findMany({}, { skip: 0, take: 20 });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(items.some((item) => item.driverId === driverId)).toBe(true);
  });
});
