import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
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

import { PrismaService } from '../../../database/prisma.service';
import { DailyListingsRepository } from '../repositories/daily-listings.repository';

jest.setTimeout(60_000);

describe('DailyListingsRepository Single-Active-Listing Concurrency (real Postgres)', () => {
  let prisma: PrismaService;
  let repository: DailyListingsRepository;
  const createdIds = {
    userIds: new Set<string>(),
    vendorIds: new Set<string>(),
    categoryIds: new Set<string>(),
    catalogueItemIds: new Set<string>(),
    lotIds: new Set<string>(),
    productIds: new Set<string>(),
    listingIds: new Set<string>(),
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new DailyListingsRepository(prisma);
  });

  afterAll(async () => {
    // Teardown in reverse dependency order
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

  async function seedTestEnvironment() {
    const vendorRole = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });

    const user = await prisma.user.create({
      data: {
        email: `vendor-${randomUUID()}@example.com`,
        passwordHash: 'hash',
        firstName: 'Test',
        lastName: 'Vendor',
        roles: {
          create: {
            roleId: vendorRole.id,
          },
        },
      },
    });
    createdIds.userIds.add(user.id);

    const vendor = await prisma.vendor.create({
      data: {
        userId: user.id,
        businessName: `Test Vendor ${randomUUID()}`,
        parish: 'KINGSTON',
        termsAcceptedAt: new Date(),
      },
    });
    createdIds.vendorIds.add(vendor.id);

    const category = await prisma.category.create({
      data: {
        name: `Fish Category ${randomUUID()}`,
        slug: `fish-${randomUUID()}`,
      },
    });
    createdIds.categoryIds.add(category.id);

    const catalogueItem = await prisma.seafoodCatalogueItem.create({
      data: {
        name: `Snapper ${randomUUID()}`,
        commonName: 'Red Snapper',
        scientificName: 'Lutjanus campechanus',
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
        foodSafetyStatus: FoodSafetyStatus.SAFE,
      },
    });
    createdIds.lotIds.add(lot.id);

    const product = await prisma.product.create({
      data: {
        vendorId: vendor.id,
        categoryId: category.id,
        lotId: lot.id,
        catalogueItemId: catalogueItem.id,
        name: `Red Snapper ${randomUUID()}`,
        description: 'Fresh red snapper',
        unit: ProductUnit.PER_POUND,
        price: new Prisma.Decimal('25.00'),
        quantityAvailable: 100,
        imageUrl: 'https://example.com/snapper.jpg',
      },
    });
    createdIds.productIds.add(product.id);

    return { user, vendor, category, catalogueItem, lot, product };
  }

  async function createDraftListing(
    vendorId: string,
    productId: string,
    catalogueItemId: string,
    lotId: string,
  ) {
    const listing = await prisma.vendorDailyListing.create({
      data: {
        vendorId,
        productId,
        catalogueItemId,
        lotId,
        listingTitle: `Draft Listing ${randomUUID()}`,
        catchDate: new Date(),
        expiresAt: new Date(Date.now() + 86400_000),
        unit: ProductUnit.PER_POUND,
        price: new Prisma.Decimal('25.00'),
        quantityUploaded: new Prisma.Decimal('50.00'),
        quantityAvailable: new Prisma.Decimal('50.00'),
        quantityReserved: new Prisma.Decimal('0.00'),
        quantitySold: new Prisma.Decimal('0.00'),
        status: ListingLifecycleStatus.DRAFT,
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

  it('rejects concurrent publication attempts on the same Product.id, ensuring exactly one succeeds', async () => {
    const env = await seedTestEnvironment();

    const listing1 = await createDraftListing(
      env.vendor.id,
      env.product.id,
      env.catalogueItem.id,
      env.lot.id,
    );
    const listing2 = await createDraftListing(
      env.vendor.id,
      env.product.id,
      env.catalogueItem.id,
      env.lot.id,
    );

    // Launch both publications concurrently
    const results = await Promise.allSettled([
      repository.publishListing(listing1.id),
      repository.publishListing(listing2.id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one must succeed and one must be rejected
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectedReason).toBeInstanceOf(ConflictException);
    expect(rejectedReason.message).toMatch(/an active published listing.*already exists/i);

    // Verify database state: only one listing is PUBLISHED
    const publishedCount = await prisma.vendorDailyListing.count({
      where: {
        productId: env.product.id,
        status: ListingLifecycleStatus.PUBLISHED,
      },
    });
    expect(publishedCount).toBe(1);
  });

  it('rejects concurrent publishListing vs reinstateListing on the same Product.id', async () => {
    const env = await seedTestEnvironment();

    // Listing 1 was suspended
    const listing1 = await createDraftListing(
      env.vendor.id,
      env.product.id,
      env.catalogueItem.id,
      env.lot.id,
    );
    await prisma.vendorDailyListing.update({
      where: { id: listing1.id },
      data: {
        status: ListingLifecycleStatus.SUSPENDED,
        suspendedAt: new Date(),
        suspensionReason: 'Audit review',
      },
    });

    // Listing 2 is a new draft
    const listing2 = await createDraftListing(
      env.vendor.id,
      env.product.id,
      env.catalogueItem.id,
      env.lot.id,
    );

    // Race reinstatement of listing1 against publication of listing2
    const results = await Promise.allSettled([
      repository.reinstateListing(listing1.id),
      repository.publishListing(listing2.id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectedReason).toBeInstanceOf(ConflictException);
    expect(rejectedReason.message).toMatch(/an active published listing.*already exists/i);

    // Exactly 1 published in DB
    const publishedCount = await prisma.vendorDailyListing.count({
      where: {
        productId: env.product.id,
        status: ListingLifecycleStatus.PUBLISHED,
      },
    });
    expect(publishedCount).toBe(1);
  });

  it('allows publication of a new listing after existing active listing is withdrawn', async () => {
    const env = await seedTestEnvironment();

    const listing1 = await createDraftListing(
      env.vendor.id,
      env.product.id,
      env.catalogueItem.id,
      env.lot.id,
    );
    const listing2 = await createDraftListing(
      env.vendor.id,
      env.product.id,
      env.catalogueItem.id,
      env.lot.id,
    );

    // Publish listing 1
    const pub1 = await repository.publishListing(listing1.id);
    expect(pub1.status).toBe(ListingLifecycleStatus.PUBLISHED);

    // Attempting to publish listing 2 now must fail
    await expect(
      repository.publishListing(listing2.id),
    ).rejects.toThrow(ConflictException);

    // Withdraw listing 1
    await repository.withdrawListing(listing1.id, 'Sold out locally');

    // Now publishing listing 2 must succeed
    const pub2 = await repository.publishListing(listing2.id);
    expect(pub2.status).toBe(ListingLifecycleStatus.PUBLISHED);

    const publishedListings = await prisma.vendorDailyListing.findMany({
      where: {
        productId: env.product.id,
        status: ListingLifecycleStatus.PUBLISHED,
      },
    });
    expect(publishedListings).toHaveLength(1);
    expect(publishedListings[0]?.id).toBe(listing2.id);
  });
});
