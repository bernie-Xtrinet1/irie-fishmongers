import { randomUUID } from 'crypto';

import { ConflictException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Parish, ProductUnit, RoleName, UserStatus, VehicleOwnership, VehicleType, VendorOrderStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { DriverSettlementEngine } from '../../driver-settlements/services/driver-settlement-engine.service';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { DeliveriesRepository } from '../repositories/deliveries.repository';
import { DriverLocationsRepository } from '../repositories/driver-locations.repository';
import { DriversRepository } from '../repositories/drivers.repository';
import { RouteHistoryRepository } from '../repositories/route-history.repository';
import { SLABreachesRepository } from '../repositories/sla-breaches.repository';
import { DeliveriesService } from './deliveries.service';
import { DriversService } from './drivers.service';

jest.setTimeout(60_000);

describe('DeliveriesService Concurrent Claim & Ownership Isolation (real Postgres)', () => {
  let prisma: PrismaService;
  let driversService: DriversService;
  let deliveriesService: DeliveriesService;
  let usersRepository: UsersRepository;
  let vendorsRepository: VendorsRepository;
  let categoriesRepository: CategoriesRepository;
  let productsRepository: ProductsRepository;
  let ordersRepository: OrdersRepository;
  let vendorOrdersRepository: VendorOrdersRepository;
  let driversRepository: DriversRepository;

  const createdUserIds: string[] = [];
  const createdCategoryIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    usersRepository = new UsersRepository(prisma);
    vendorsRepository = new VendorsRepository(prisma);
    categoriesRepository = new CategoriesRepository(prisma);
    productsRepository = new ProductsRepository(prisma);
    ordersRepository = new OrdersRepository(prisma);
    vendorOrdersRepository = new VendorOrdersRepository(prisma);
    driversRepository = new DriversRepository(prisma);

    const deliveriesRepository = new DeliveriesRepository(prisma);
    const driverLocationsRepository = new DriverLocationsRepository(prisma);
    const routeHistoryRepository = new RouteHistoryRepository(prisma);
    const slaBreachesRepository = new SLABreachesRepository(prisma);
    const settlementEngine = new DriverSettlementEngine();
    const eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) } as unknown as EventEmitter2;

    driversService = new DriversService(
      driversRepository,
      driverLocationsRepository,
      deliveriesRepository,
      prisma,
    );
    deliveriesService = new DeliveriesService(
      prisma,
      deliveriesRepository,
      vendorOrdersRepository,
      driversRepository,
      driverLocationsRepository,
      routeHistoryRepository,
      slaBreachesRepository,
      settlementEngine,
      eventEmitter,
    );
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.delivery.deleteMany({
        where: { driver: { userId: { in: createdUserIds } } },
      });
      await prisma.orderItem.deleteMany({
        where: { vendorOrder: { order: { customerId: { in: createdUserIds } } } },
      });
      await prisma.vendorOrder.deleteMany({
        where: { order: { customerId: { in: createdUserIds } } },
      });
      await prisma.order.deleteMany({
        where: { customerId: { in: createdUserIds } },
      });
      await prisma.product.deleteMany({
        where: { vendor: { userId: { in: createdUserIds } } },
      });
      await prisma.vendor.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.driver.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
    if (createdCategoryIds.length > 0) {
      await prisma.category.deleteMany({
        where: { id: { in: createdCategoryIds } },
      });
    }
    await prisma.onModuleDestroy();
  });

  async function createUserWithRole(roleName: RoleName, firstName: string) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      update: {},
      create: { name: roleName },
    });
    const user = await usersRepository.create({
      email: `del-conc-${roleName.toLowerCase()}-${randomUUID()}@example.invalid`,
      passwordHash: 'hashed',
      firstName,
      lastName: 'Test',
      roleId: role.id,
      emailVerificationTokenHash: randomUUID(),
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { status: UserStatus.ACTIVE, emailVerifiedAt: new Date() },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function createApprovedOnlineDriver(firstName: string, plate: string) {
    const user = await createUserWithRole(RoleName.DRIVER, firstName);
    const driver = await driversService.register(user.id, {
      licensePlate: plate,
      vehicleType: VehicleType.CAR,
      vehicleOwnership: VehicleOwnership.PERSONAL_VEHICLE,
    });
    await driversService.updateStatus(driver.id, 'APPROVED');
    await driversService.updateAvailability(user.id, 'ONLINE');
    return { user, driver };
  }

  async function createReadyVendorOrder(customerId: string, vendorId: string, productId: string) {
    const order = await ordersRepository.create({
      customerId,
      deliveryAddressLine1: '12 Harbour Road',
      deliveryParish: Parish.KINGSTON,
      deliveryPhone: '+18765550101',
      currency: null,
      vendorOrders: [
        {
          vendorId,
          subtotal: 1200,
          items: [
            {
              productId,
              productName: 'Fresh Red Snapper',
              unitPrice: 600,
              unit: ProductUnit.PER_POUND,
              quantity: 2,
              subtotal: 1200,
              currency: null,
            },
          ],
        },
      ],
    });
    const vendorOrderId = order.vendorOrders[0]!.id;
    await vendorOrdersRepository.updateStatus(vendorOrderId, VendorOrderStatus.READY_FOR_PICKUP);
    return vendorOrderId;
  }

  it('allows only one driver to claim the same pickup under concurrent POST /assign requests and blocks cross-driver mutations', async () => {
    const customer = await createUserWithRole(RoleName.CUSTOMER, 'Customer');
    const vendorUser = await createUserWithRole(RoleName.VENDOR, 'Vendor');
    const vendor = await vendorsRepository.create({
      userId: vendorUser.id,
      businessName: `Dockside ${randomUUID().slice(0, 6)}`,
      parish: Parish.KINGSTON,
      termsAcceptedAt: new Date(),
    });
    await vendorsRepository.updateStatus(vendor.id, 'APPROVED');

    const category = await categoriesRepository.create({
      name: `Snapper ${randomUUID().slice(0, 6)}`,
      slug: `snapper-${randomUUID().slice(0, 8)}`,
    });
    createdCategoryIds.push(category.id);

    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Fresh Red Snapper',
      description: 'Daily harbour catch',
      price: 600,
      unit: ProductUnit.PER_POUND,
      quantityAvailable: 20,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });

    const vendorOrderId = await createReadyVendorOrder(customer.id, vendor.id, product.id);
    const secondVendorOrderId = await createReadyVendorOrder(customer.id, vendor.id, product.id);

    const driverA = await createApprovedOnlineDriver('DriverA', 'DA 1001');
    const driverB = await createApprovedOnlineDriver('DriverB', 'DB 2002');

    // Race two drivers against the same READY_FOR_PICKUP vendor order
    const [resA, resB] = await Promise.allSettled([
      deliveriesService.assign(driverA.user.id, { vendorOrderId }),
      deliveriesService.assign(driverB.user.id, { vendorOrderId }),
    ]);

    const fulfilled = [resA, resB].filter((r) => r.status === 'fulfilled');
    const rejected = [resA, resB].filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConflictException);

    const claimedDelivery = (fulfilled[0] as PromiseFulfilledResult<{ id: string; driverId: string }>).value;
    const winnerUser = claimedDelivery.driverId === driverA.driver.id ? driverA.user : driverB.user;
    const loserUser = claimedDelivery.driverId === driverA.driver.id ? driverB.user : driverA.user;

    // Winner is now BUSY and cannot claim a second job simultaneously
    await expect(
      deliveriesService.assign(winnerUser.id, { vendorOrderId: secondVendorOrderId }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Losing driver cannot update schedule or status of the winning driver's delivery
    await expect(
      deliveriesService.updateSchedule(loserUser.id, claimedDelivery.id, {
        scheduledPickupWindowStart: new Date(Date.now() + 3_600_000).toISOString(),
        scheduledPickupWindowEnd: new Date(Date.now() + 7_200_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      deliveriesService.updateStatus(loserUser.id, claimedDelivery.id, { action: 'PICKED_UP' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Also verify losing driver race on two separate claims by the same online driver serializes cleanly
    const [raceOwn1, raceOwn2] = await Promise.allSettled([
      deliveriesService.assign(loserUser.id, { vendorOrderId: secondVendorOrderId }),
      deliveriesService.assign(loserUser.id, { vendorOrderId: secondVendorOrderId }),
    ]);
    expect([raceOwn1, raceOwn2].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loserClaimedCount = await prisma.delivery.count({
      where: { driver: { userId: loserUser.id } },
    });
    expect(loserClaimedCount).toBe(1);
  });
});
