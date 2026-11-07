import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CatalogueLifecycleStatus,
  FoodSafetyStatus,
  ListingLifecycleStatus,
  ListingPhotoModerationStatus,
  Prisma,
  ProductUnit,
  RoleName,
  SeafoodStorageType,
  WeightUnit,
} from '@prisma/client';

import { PrismaService } from '../../../../database/prisma.service';
import { InventoryEventsRepository } from '../../../inventory/repositories/inventory-events.repository';
import { OrdersRepository } from '../../repositories/orders.repository';
import { VendorOrdersRepository } from '../../repositories/vendor-orders.repository';
import { ProductsRepository } from '../../../products/repositories/products.repository';
import { VendorsRepository } from '../../../vendors/repositories/vendors.repository';
import { OrdersService } from '../orders.service';
import { VendorOrdersService } from '../vendor-orders.service';

jest.setTimeout(60_000);

describe('Order Cancellation & Vendor Rejection Disposition (real Postgres)', () => {
  let prisma: PrismaService;
  let ordersRepo: OrdersRepository;
  let vendorOrdersRepo: VendorOrdersRepository;
  let productsRepo: ProductsRepository;
  let vendorsRepo: VendorsRepository;
  let inventoryEventsRepo: InventoryEventsRepository;

  let ordersService: OrdersService;
  let vendorOrdersService: VendorOrdersService;

  const createdIds = {
    userIds: new Set<string>(),
    vendorIds: new Set<string>(),
    categoryIds: new Set<string>(),
    catalogueItemIds: new Set<string>(),
    lotIds: new Set<string>(),
    productIds: new Set<string>(),
    listingIds: new Set<string>(),
    orderIds: new Set<string>(),
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    ordersRepo = new OrdersRepository(prisma);
    vendorOrdersRepo = new VendorOrdersRepository(prisma);
    productsRepo = new ProductsRepository(prisma);
    vendorsRepo = new VendorsRepository(prisma);
    inventoryEventsRepo = new InventoryEventsRepository(prisma);

    const mockPaymentsService: any = {
      getByOrderId: jest.fn().mockResolvedValue(null),
      refundOrder: jest.fn().mockResolvedValue(undefined),
      refundForOrder: jest.fn().mockResolvedValue(undefined),
    };
    const mockEventEmitter: any = {
      emitAsync: jest.fn().mockResolvedValue([]),
    };

    ordersService = new OrdersService(
      prisma,
      ordersRepo,
      vendorOrdersRepo,
      {} as any,
      productsRepo,
      vendorsRepo,
      mockPaymentsService,
      {} as any,
      inventoryEventsRepo,
      {} as any,
      mockEventEmitter,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    vendorOrdersService = new VendorOrdersService(
      prisma,
      vendorOrdersRepo,
      vendorsRepo,
      productsRepo,
      mockPaymentsService,
      inventoryEventsRepo,
      mockEventEmitter,
    );
  });

  afterAll(async () => {
    // Teardown in reverse dependency order
    for (const orderId of createdIds.orderIds) {
      await prisma.inventoryEvent.deleteMany({ where: { vendorOrder: { orderId } } });
      await prisma.orderItem.deleteMany({ where: { vendorOrder: { orderId } } });
      await prisma.vendorOrder.deleteMany({ where: { orderId } });
      await prisma.order.deleteMany({ where: { id: orderId } });
    }
    for (const id of createdIds.listingIds) {
      await prisma.listingPhoto.deleteMany({ where: { vendorDailyListingId: id } });
      await prisma.vendorDailyListing.deleteMany({ where: { id } });
    }
    for (const id of createdIds.productIds) {
      await prisma.product.deleteMany({ where: { id } });
    }
    for (const id of createdIds.lotIds) {
      await prisma.seafoodLot.deleteMany({ where: { id } });
    }
    for (const id of createdIds.catalogueItemIds) {
      await prisma.seafoodCatalogueItem.deleteMany({ where: { id } });
    }
    for (const id of createdIds.categoryIds) {
      await prisma.category.deleteMany({ where: { id } });
    }
    for (const id of createdIds.vendorIds) {
      await prisma.vendor.deleteMany({ where: { id } });
    }
    for (const id of createdIds.userIds) {
      await prisma.userRole.deleteMany({ where: { userId: id } });
      await prisma.user.deleteMany({ where: { id } });
    }
    await prisma.onModuleDestroy();
  });

  async function seedTestEnvironment(lotSafety: FoodSafetyStatus = FoodSafetyStatus.SAFE) {
    const customerRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const vendorRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });

    const customerUser = await prisma.user.create({
      data: {
        email: `cust-${randomUUID()}@example.com`,
        passwordHash: 'hash',
        firstName: 'Cara',
        lastName: 'Customer',
        roles: { create: { roleId: customerRole.id } },
      },
    });
    createdIds.userIds.add(customerUser.id);

    const vendorUser = await prisma.user.create({
      data: {
        email: `vend-${randomUUID()}@example.com`,
        passwordHash: 'hash',
        firstName: 'Vera',
        lastName: 'Vendor',
        roles: { create: { roleId: vendorRole.id } },
      },
    });
    createdIds.userIds.add(vendorUser.id);

    const vendor = await prisma.vendor.create({
      data: {
        userId: vendorUser.id,
        businessName: `Test Fishery ${randomUUID()}`,
        parish: 'KINGSTON',
        termsAcceptedAt: new Date(),
        status: 'APPROVED',
      },
    });
    createdIds.vendorIds.add(vendor.id);

    const category = await prisma.category.create({
      data: {
        name: `Fish Cat ${randomUUID()}`,
        slug: `fish-${randomUUID()}`,
      },
    });
    createdIds.categoryIds.add(category.id);

    const catalogueItem = await prisma.seafoodCatalogueItem.create({
      data: {
        name: `Snapper ${randomUUID()}`,
        commonName: 'Red Snapper',
        categoryId: category.id,
        lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
      },
    });
    createdIds.catalogueItemIds.add(catalogueItem.id);

    const lot = await prisma.seafoodLot.create({
      data: {
        lotNumber: `LOT-${randomUUID()}`,
        vendorId: vendor.id,
        species: 'Red Snapper',
        storageType: SeafoodStorageType.FRESH,
        catchDate: new Date(),
        weight: new Prisma.Decimal('100.00'),
        weightUnit: WeightUnit.POUNDS,
        foodSafetyStatus: lotSafety,
      },
    });
    createdIds.lotIds.add(lot.id);

    const product = await prisma.product.create({
      data: {
        vendorId: vendor.id,
        categoryId: category.id,
        lotId: lot.id,
        catalogueItemId: catalogueItem.id,
        name: `Snapper ${randomUUID()}`,
        description: 'Fresh snapper',
        unit: ProductUnit.PER_POUND,
        price: new Prisma.Decimal('25.00'),
        quantityAvailable: 100,
        imageUrl: 'https://example.com/s.jpg',
      },
    });
    createdIds.productIds.add(product.id);

    return { customerUser, vendorUser, vendor, category, catalogueItem, lot, product };
  }

  async function createListing(
    env: any,
    isExpired = false,
    quantitySold = new Prisma.Decimal('2.00'),
  ) {
    const expiresAt = isExpired
      ? new Date(Date.now() - 86400_000) // expired yesterday
      : new Date(Date.now() + 86400_000); // active tomorrow

    const listing = await prisma.vendorDailyListing.create({
      data: {
        vendorId: env.vendor.id,
        productId: env.product.id,
        catalogueItemId: env.catalogueItem.id,
        lotId: env.lot.id,
        listingTitle: `Listing ${randomUUID()}`,
        catchDate: new Date(),
        expiresAt,
        unit: ProductUnit.PER_POUND,
        price: new Prisma.Decimal('25.00'),
        quantityUploaded: new Prisma.Decimal('50.00'),
        quantityAvailable: new Prisma.Decimal('10.00'),
        quantityReserved: new Prisma.Decimal('0.00'),
        quantitySold,
        status: ListingLifecycleStatus.PUBLISHED,
      },
    });
    createdIds.listingIds.add(listing.id);

    await prisma.listingPhoto.create({
      data: {
        vendorDailyListingId: listing.id,
        url: 'https://example.com/photo.jpg',
        isPrimary: true,
        moderationStatus: ListingPhotoModerationStatus.APPROVED,
      },
    });

    return listing;
  }

  async function createOrderGraph(env: any, listingId: string, quantity = 2) {
    const order = await ordersRepo.create({
      customerId: env.customerUser.id,
      deliveryAddressLine1: '123 Coastal Way',
      deliveryParish: 'KINGSTON',
      deliveryPhone: '+18765551234',
      currency: 'JMD',
      vendorOrders: [
        {
          vendorId: env.vendor.id,
          subtotal: 50.0,
          items: [
            {
              productId: env.product.id,
              productName: 'Red Snapper',
              unitPrice: 25.0,
              unit: 'PER_POUND',
              quantity,
              subtotal: 50.0,
              currency: 'JMD',
              originalListingId: listingId,
            },
          ],
        },
      ],
    });
    createdIds.orderIds.add(order.id);
    return order;
  }

  it('serializes concurrent customer cancel vs vendor reject, ensuring exactly one succeeds and quantitySold is decremented once', async () => {
    const env = await seedTestEnvironment(FoodSafetyStatus.SAFE);
    const listing = await createListing(env, false, new Prisma.Decimal('2.00'));
    const order = await createOrderGraph(env, listing.id, 2);
    const vendorOrderId = order.vendorOrders[0]!.id;

    // Race cancelOrder (customer) vs reject (vendor) concurrently
    const results = await Promise.allSettled([
      ordersService.cancelOrder(env.customerUser.id, order.id),
      vendorOrdersService.reject(env.vendorUser.id, vendorOrderId),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one operation must succeed and one must be rejected
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const error = (rejected[0] as PromiseRejectedResult).reason;
    expect(
      error instanceof ConflictException || error instanceof BadRequestException,
    ).toBe(true);

    // Verify database state: quantitySold decremented by 2 exactly once (2.00 - 2.00 = 0.00)
    const updatedListing = await prisma.vendorDailyListing.findUniqueOrThrow({
      where: { id: listing.id },
    });
    expect(new Prisma.Decimal(updatedListing.quantitySold).toNumber()).toBe(0);

    // Verify quantityAvailable restored once (10.00 + 2.00 = 12.00)
    expect(new Prisma.Decimal(updatedListing.quantityAvailable).toNumber()).toBe(12);

    // Exactly one inventory event created
    const events = await prisma.inventoryEvent.findMany({
      where: { vendorOrderId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('RESTOCKED');
  });

  it('routes inventory to DISPOSED event and does NOT restock quantityAvailable when listing is expired', async () => {
    const env = await seedTestEnvironment(FoodSafetyStatus.SAFE);
    // Listing expired yesterday
    const listing = await createListing(env, true, new Prisma.Decimal('2.00'));
    const order = await createOrderGraph(env, listing.id, 2);
    const vendorOrderId = order.vendorOrders[0]!.id;

    // Customer cancels order
    await ordersService.cancelOrder(env.customerUser.id, order.id);

    // Verify database state:
    const updatedListing = await prisma.vendorDailyListing.findUniqueOrThrow({
      where: { id: listing.id },
    });

    // quantitySold decremented
    expect(new Prisma.Decimal(updatedListing.quantitySold).toNumber()).toBe(0);

    // CRITICAL: quantityAvailable NOT restored because listing has expired!
    expect(new Prisma.Decimal(updatedListing.quantityAvailable).toNumber()).toBe(10);

    // Verify InventoryEvent is DISPOSED with structured notes
    const events = await prisma.inventoryEvent.findMany({
      where: { vendorOrderId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('DISPOSED');
    expect(events[0]!.notes).toContain('EXPIRED_ON_CANCEL');

    const parsedNotes = JSON.parse(events[0]!.notes!);
    expect(parsedNotes.disposition).toBe('EXPIRED_ON_CANCEL');
    expect(parsedNotes.listingId).toBe(listing.id);
    expect(parsedNotes.quantityDisposed).toBe(2);
  });

  it('routes inventory to DISPOSED event when seafood lot is quarantined', async () => {
    // Lot is marked QUARANTINED
    const env = await seedTestEnvironment(FoodSafetyStatus.QUARANTINED);
    const listing = await createListing(env, false, new Prisma.Decimal('2.00'));
    const order = await createOrderGraph(env, listing.id, 2);
    const vendorOrderId = order.vendorOrders[0]!.id;

    // Vendor rejects order
    await vendorOrdersService.reject(env.vendorUser.id, vendorOrderId);

    // Verify database state:
    const updatedListing = await prisma.vendorDailyListing.findUniqueOrThrow({
      where: { id: listing.id },
    });

    // quantitySold decremented
    expect(new Prisma.Decimal(updatedListing.quantitySold).toNumber()).toBe(0);

    // CRITICAL: quantityAvailable NOT restored because lot is quarantined!
    expect(new Prisma.Decimal(updatedListing.quantityAvailable).toNumber()).toBe(10);

    // Verify InventoryEvent is DISPOSED
    const events = await prisma.inventoryEvent.findMany({
      where: { vendorOrderId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('DISPOSED');
  });

  it('enforces conditional decrement preventing negative quantitySold', async () => {
    const env = await seedTestEnvironment(FoodSafetyStatus.SAFE);
    // Listing has only 1.00 quantitySold in DB
    const listing = await createListing(env, false, new Prisma.Decimal('1.00'));
    // Order item was for quantity 2
    const order = await createOrderGraph(env, listing.id, 2);

    // Cancel order - conditional decrement WHERE quantitySold >= 2 fails safely
    await ordersService.cancelOrder(env.customerUser.id, order.id);

    const updatedListing = await prisma.vendorDailyListing.findUniqueOrThrow({
      where: { id: listing.id },
    });

    // quantitySold was NOT decremented to -1.00! It remained >= 0 (1.00)
    expect(new Prisma.Decimal(updatedListing.quantitySold).toNumber()).toBe(1);
  });
});
