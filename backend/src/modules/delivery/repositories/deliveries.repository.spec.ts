import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { DriversRepository } from './drivers.repository';
import { DeliveriesRepository } from './deliveries.repository';

describe('DeliveriesRepository', () => {
  let prisma: PrismaService;
  let repository: DeliveriesRepository;
  let vendorOrdersRepository: VendorOrdersRepository;
  let customerId: string;
  let vendorUserId: string;
  let driverUserId: string;
  let driverId: string;
  let category: Category;
  let vendorOrderId: string;

  async function createReadyVendorOrder(
    vendor: Vendor,
    productId: string,
    deliveryZoneId?: string,
  ): Promise<string> {
    const ordersRepository = new OrdersRepository(prisma);
    const order = await ordersRepository.create({
      customerId,
      deliveryAddressLine1: '1 Test Street',
      deliveryParish: 'KINGSTON',
      deliveryPhone: '+18765551234',
      deliveryZoneId,
      vendorOrders: [
        {
          vendorId: vendor.id,
          subtotal: 1000,
          items: [
            {
              productId,
              productName: 'Deliveries Repo Snapper',
              unitPrice: 500,
              unit: 'PER_POUND',
              quantity: 2,
              subtotal: 1000,
            },
          ],
        },
      ],
    });
    const newVendorOrderId = order.vendorOrders[0]!.id;
    await vendorOrdersRepository.updateStatus(newVendorOrderId, 'READY_FOR_PICKUP');
    return newVendorOrderId;
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new DeliveriesRepository(prisma);
    vendorOrdersRepository = new VendorOrdersRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);
    const driversRepository = new DriversRepository(prisma);

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
      email: `deliveries-repo-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `deliveries-repo-vendor-${randomUUID()}@example.com`,
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
      businessName: "Vera's Catch",
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });

    const driverUser = await usersRepository.create({
      email: `deliveries-repo-driver-${randomUUID()}@example.com`,
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
      name: `Deliveries Repo Category ${randomUUID()}`,
      slug: `deliveries-repo-category-${randomUUID()}`,
    });

    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Deliveries Repo Snapper',
      description: 'Sold for deliveries repository tests.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });

    vendorOrderId = await createReadyVendorOrder(vendor, product.id);
  });

  afterAll(async () => {
    // Customer first: cascades Order -> VendorOrder -> OrderItem -> Delivery,
    // freeing the Restrict constraint on Delivery.driverId before the driver's
    // user row is deleted.
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.user.delete({ where: { id: driverUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  it('finds the vendor order awaiting pickup by id', async () => {
    const found = await repository.findVendorOrderForPickup(vendorOrderId);
    expect(found?.status).toBe('READY_FOR_PICKUP');
    expect(found?.vendor.businessName).toBe("Vera's Catch");
    expect(found?.items).toHaveLength(1);
  });

  it('lists vendor orders available for pickup', async () => {
    const { items, total } = await repository.findAvailableForPickup({ skip: 0, take: 20 });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(items.some((item) => item.id === vendorOrderId)).toBe(true);
  });

  it('returns no delivery for a vendor order that has not been claimed', async () => {
    await expect(repository.findByVendorOrderId(vendorOrderId)).resolves.toBeNull();
    await expect(repository.countActiveByDriverId(driverId)).resolves.toBe(0);
  });

  it('creates a delivery, no longer listing the vendor order as available', async () => {
    const delivery = await repository.create({ vendorOrderId, driverId });
    expect(delivery.driverId).toBe(driverId);
    expect(delivery.vendorOrder.vendor.businessName).toBe("Vera's Catch");
    expect(delivery.pickedUpAt).toBeNull();

    const { items } = await repository.findAvailableForPickup({ skip: 0, take: 20 });
    expect(items.some((item) => item.id === vendorOrderId)).toBe(false);

    await expect(repository.countActiveByDriverId(driverId)).resolves.toBe(1);
  });

  it('finds a delivery by id and by vendor order id', async () => {
    const byVendorOrder = await repository.findByVendorOrderId(vendorOrderId);
    expect(byVendorOrder).not.toBeNull();

    const byId = await repository.findById(byVendorOrder!.id);
    expect(byId?.vendorOrderId).toBe(vendorOrderId);
  });

  it("paginates a driver's deliveries", async () => {
    const { items, total } = await repository.findManyByDriver(driverId, { skip: 0, take: 20 });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(items.some((item) => item.vendorOrderId === vendorOrderId)).toBe(true);
  });

  it('marks a delivery picked up', async () => {
    const delivery = await repository.findByVendorOrderId(vendorOrderId);
    const updated = await repository.markPickedUp(delivery!.id);
    expect(updated.pickedUpAt).not.toBeNull();
  });

  it('marks a delivery delivered with proof, closing it out of the active count', async () => {
    const delivery = await repository.findByVendorOrderId(vendorOrderId);
    const updated = await repository.markDelivered(
      delivery!.id,
      'PHOTO',
      'https://cdn.example.com/proof/photo-1.jpg',
    );
    expect(updated.deliveredAt).not.toBeNull();
    expect(updated.proofType).toBe('PHOTO');
    expect(updated.proofUrl).toBe('https://cdn.example.com/proof/photo-1.jpg');

    await expect(repository.countActiveByDriverId(driverId)).resolves.toBe(0);
  });

  it('marks a delivery failed with a reason', async () => {
    const vendorsRepository = new VendorsRepository(prisma);
    const vendor = await vendorsRepository.findByUserId(vendorUserId);
    const productsRepository = new ProductsRepository(prisma);
    const product = await productsRepository.create({
      vendorId: vendor!.id,
      categoryId: category.id,
      name: 'Deliveries Repo Failure Snapper',
      description: 'Sold for delivery-failure repository tests.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    const failureVendorOrderId = await createReadyVendorOrder(vendor!, product.id);
    const delivery = await repository.create({ vendorOrderId: failureVendorOrderId, driverId });

    const updated = await repository.markFailed(delivery.id, 'Customer not present');
    expect(updated.failedAt).not.toBeNull();
    expect(updated.failureReason).toBe('Customer not present');

    await expect(repository.countActiveByDriverId(driverId)).resolves.toBe(0);
  });

  it('finds scheduled, unclaimed-pickup deliveries in a zone', async () => {
    const zone = await prisma.deliveryZone.findUniqueOrThrow({ where: { code: 'ZONE_1' } });

    const vendorsRepository = new VendorsRepository(prisma);
    const vendor = await vendorsRepository.findByUserId(vendorUserId);
    const productsRepository = new ProductsRepository(prisma);
    const product = await productsRepository.create({
      vendorId: vendor!.id,
      categoryId: category.id,
      name: 'Deliveries Repo Zone Snapper',
      description: 'Sold for zone-scoped delivery repository tests.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    const zoneVendorOrderId = await createReadyVendorOrder(vendor!, product.id, zone.id);
    const zoneDelivery = await repository.create({ vendorOrderId: zoneVendorOrderId, driverId });

    const scheduled = await repository.findScheduledForZone(zone.id);
    expect(scheduled.some((delivery) => delivery.id === zoneDelivery.id)).toBe(true);
    expect(scheduled.every((delivery) => delivery.pickedUpAt === null)).toBe(true);
  });
});
