import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  ListingLifecycleStatus,
  ListingPhotoModerationStatus,
  CatalogueLifecycleStatus,
  ProductUnit,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { DailyListingsRepository } from '../repositories/daily-listings.repository';

describe('DailyListingsRepository Publication Concurrency & Guards (F-16B-02)', () => {
  let repository: DailyListingsRepository;
  let prisma: jest.Mocked<PrismaService>;
  let mockTx: any;

  const validPhoto = {
    id: 'photo-1',
    vendorDailyListingId: 'listing-1',
    url: 'https://example.com/photo1.jpg',
    caption: 'Fresh catch',
    isPrimary: true,
    moderationStatus: ListingPhotoModerationStatus.APPROVED,
    uploadedAt: new Date(),
    captureDate: null,
    withdrawnAt: null,
    withdrawnByUserId: null,
    withdrawnReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const validListing = {
    id: 'listing-1',
    vendorId: 'vendor-1',
    productId: 'prod-1',
    catalogueItemId: 'cat-1',
    lotId: 'lot-1',
    landingSiteId: null,
    listingTitle: 'Fresh Snapper',
    description: null,
    catchDate: new Date(),
    availableFrom: new Date(),
    expiresAt: new Date(Date.now() + 86400_000), // Valid future expiry
    unit: ProductUnit.PER_POUND,
    price: new Prisma.Decimal(800),
    currency: 'JMD',
    quantityUploaded: new Prisma.Decimal(50),
    quantityAvailable: new Prisma.Decimal(50),
    quantityReserved: new Prisma.Decimal(0),
    quantitySold: new Prisma.Decimal(0),
    preparationOptions: null,
    deliveryAvailable: true,
    pickupAvailable: true,
    status: ListingLifecycleStatus.DRAFT,
    withdrawnAt: null,
    withdrawnReason: null,
    suspendedAt: null,
    suspensionReason: null,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    catalogueItem: {
      id: 'cat-1',
      name: 'Snapper',
      lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
    },
    lot: {
      id: 'lot-1',
      foodSafetyStatus: 'SAFE',
    },
    photos: [validPhoto],
  };

  beforeEach(() => {
    mockTx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      vendorDailyListing: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(validListing),
        findUniqueOrThrow: jest.fn().mockResolvedValue(validListing),
        findMany: jest.fn().mockResolvedValue([validListing]),
        update: jest.fn().mockResolvedValue({
          ...validListing,
          status: ListingLifecycleStatus.PUBLISHED,
          publishedAt: new Date(),
        }),
      },
      product: {
        findUnique: jest.fn().mockResolvedValue({ id: 'prod-1', inventoryMode: 'LEGACY_PRODUCT', quantityAvailable: 50 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      listingPhoto: {
        count: jest.fn().mockResolvedValue(1),
        findFirst: jest.fn().mockResolvedValue(validPhoto),
        update: jest.fn().mockResolvedValue(validPhoto),
      },
    };

    prisma = {
      $transaction: jest.fn().mockImplementation((fn: (tx: any) => Promise<any>) => fn(mockTx)),
      vendorDailyListing: mockTx.vendorDailyListing,
      product: mockTx.product,
      listingPhoto: mockTx.listingPhoto,
    } as unknown as jest.Mocked<PrismaService>;

    repository = new DailyListingsRepository(prisma);
  });

  it('acquires row lock on vendor_daily_listings during publication', async () => {
    await repository.publishListing('listing-1');

    expect(mockTx.$queryRaw).toHaveBeenCalled();
    expect(mockTx.vendorDailyListing.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'listing-1' },
        data: expect.objectContaining({
          status: ListingLifecycleStatus.PUBLISHED,
        }),
      }),
    );
  });

  it('rejects publication if current status is not DRAFT (concurrent update detection)', async () => {
    mockTx.vendorDailyListing.findUniqueOrThrow.mockResolvedValue({
      ...validListing,
      status: ListingLifecycleStatus.WITHDRAWN,
    });

    await expect(repository.publishListing('listing-1')).rejects.toThrow(
      new BadRequestException('Cannot publish listing: current status is WITHDRAWN, expected DRAFT'),
    );
  });

  it('rejects publication if listing has already expired under lock', async () => {
    mockTx.vendorDailyListing.findUniqueOrThrow.mockResolvedValue({
      ...validListing,
      expiresAt: new Date(Date.now() - 5000), // Expired 5 seconds ago
    });

    await expect(repository.publishListing('listing-1')).rejects.toThrow(
      new BadRequestException('Cannot publish an already expired listing'),
    );
  });

  it('rejects publication if backing catalogue item is retired or non-published', async () => {
    mockTx.vendorDailyListing.findUniqueOrThrow.mockResolvedValue({
      ...validListing,
      catalogueItem: {
        id: 'cat-1',
        name: 'Snapper',
        lifecycleStatus: CatalogueLifecycleStatus.RETIRED,
      },
    });

    await expect(repository.publishListing('listing-1')).rejects.toThrow(
      new BadRequestException('Cannot publish listing: backing catalogue item is in RETIRED status (must be PUBLISHED)'),
    );
  });

  it('rejects publication if seafood lot food safety status is not SAFE', async () => {
    mockTx.vendorDailyListing.findUniqueOrThrow.mockResolvedValue({
      ...validListing,
      lot: {
        id: 'lot-1',
        foodSafetyStatus: 'RECALLED',
      },
    });

    await expect(repository.publishListing('listing-1')).rejects.toThrow(
      new BadRequestException('Cannot publish listing: seafood lot food safety status is RECALLED (must be SAFE)'),
    );
  });

  it('rejects publication if all photos have been withdrawn', async () => {
    mockTx.vendorDailyListing.findUniqueOrThrow.mockResolvedValue({
      ...validListing,
      photos: [
        {
          ...validPhoto,
          withdrawnAt: new Date(),
        },
      ],
    });

    await expect(repository.publishListing('listing-1')).rejects.toThrow(
      new BadRequestException('Listing must have at least one approved actual-catch photograph before publication'),
    );
  });

  it('designates first approved photo as primary if none was designated', async () => {
    mockTx.vendorDailyListing.findUniqueOrThrow.mockResolvedValue({
      ...validListing,
      photos: [
        {
          ...validPhoto,
          isPrimary: false,
        },
      ],
    });

    await repository.publishListing('listing-1');

    expect(mockTx.listingPhoto.update).toHaveBeenCalledWith({
      where: { id: 'photo-1' },
      data: { isPrimary: true },
    });
  });

  it('executes regulatory validator within transaction under locks and aborts if it fails', async () => {
    const mockValidator = jest.fn().mockRejectedValue(new BadRequestException('Regulatory prohibited species'));

    await expect(repository.publishListing('listing-1', mockValidator)).rejects.toThrow(
      new BadRequestException('Regulatory prohibited species'),
    );
    expect(mockValidator).toHaveBeenCalledWith(mockTx, expect.objectContaining({ id: 'listing-1' }));
    expect(mockTx.vendorDailyListing.update).not.toHaveBeenCalled();
  });

  it('rejects publication if an active published listing already exists for the product', async () => {
    mockTx.vendorDailyListing.findFirst.mockResolvedValueOnce({ id: 'existing-active-1' });

    await expect(repository.publishListing('listing-1')).rejects.toThrow(ConflictException);
    expect(mockTx.vendorDailyListing.update).not.toHaveBeenCalled();
  });

  it('rejects reinstatement if an active published listing already exists for the product', async () => {
    mockTx.vendorDailyListing.findUniqueOrThrow.mockResolvedValueOnce({
      ...validListing,
      status: ListingLifecycleStatus.SUSPENDED,
    });
    mockTx.vendorDailyListing.findFirst.mockResolvedValueOnce({ id: 'existing-active-1' });

    await expect(repository.reinstateListing('listing-1')).rejects.toThrow(ConflictException);
    expect(mockTx.vendorDailyListing.update).not.toHaveBeenCalled();
  });

  describe('syncProductProjectionUnderLock (F-16B-01)', () => {
    it('preserves LEGACY_PRODUCT quantityAvailable untouched without overwriting', async () => {
      mockTx.product.findUnique.mockResolvedValue({
        id: 'prod-1',
        inventoryMode: 'LEGACY_PRODUCT',
      });

      await repository.syncProductProjectionUnderLock(mockTx, 'prod-1');

      expect(mockTx.product.updateMany).not.toHaveBeenCalled();
    });

    it('calculates sum of active, published, non-expired listings for LISTING_BACKED products', async () => {
      mockTx.product.findUnique.mockResolvedValue({
        id: 'prod-1',
        inventoryMode: 'LISTING_BACKED',
      });
      mockTx.vendorDailyListing.findMany.mockResolvedValue([
        { quantityAvailable: new Prisma.Decimal(25) },
        { quantityAvailable: new Prisma.Decimal(15) },
      ]);

      await repository.syncProductProjectionUnderLock(mockTx, 'prod-1');

      expect(mockTx.product.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'prod-1',
          inventoryMode: 'LISTING_BACKED',
        },
        data: {
          quantityAvailable: 40,
        },
      });
    });

    it('filters out expired or inactive listings from projection query', async () => {
      mockTx.product.findUnique.mockResolvedValue({
        id: 'prod-1',
        inventoryMode: 'LISTING_BACKED',
      });

      const testNow = new Date('2026-10-19T12:00:00Z');
      await repository.syncProductProjectionUnderLock(mockTx, 'prod-1', testNow);

      expect(mockTx.vendorDailyListing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            productId: 'prod-1',
            status: ListingLifecycleStatus.PUBLISHED,
            expiresAt: { gt: testNow },
            availableFrom: { lte: testNow },
            quantityAvailable: { gt: 0 },
          }),
        }),
      );
    });

    it('fails closed if mandatory product lock cannot be acquired', async () => {
      mockTx.$queryRaw.mockRejectedValue(new Error('Lock acquisition failed'));

      await expect(repository.syncProductProjectionUnderLock(mockTx, 'prod-1')).rejects.toThrow(
        'Lock acquisition failed',
      );
      expect(mockTx.product.findUnique).not.toHaveBeenCalled();
    });

    it('fails closed if mandatory lock cannot be acquired during publication', async () => {
      mockTx.$queryRaw.mockRejectedValue(new Error('Deadlock or lock timeout'));

      await expect(repository.publishListing('listing-1')).rejects.toThrow(
        'Deadlock or lock timeout',
      );
      expect(mockTx.vendorDailyListing.update).not.toHaveBeenCalled();
    });
  });

  describe('Phase 16C Discovery and Filtering (buildWhereClause)', () => {
    it('applies comprehensive activeOnly fail-closed filters for public discovery', async () => {
      (prisma.vendorDailyListing.findMany as jest.Mock).mockResolvedValue([]);

      await repository.findMany({ page: 1, pageSize: 20, activeOnly: true });

      expect(prisma.vendorDailyListing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: ListingLifecycleStatus.PUBLISHED,
            expiresAt: expect.any(Object),
            availableFrom: expect.any(Object),
            quantityAvailable: { gt: 0 },
            vendor: expect.objectContaining({ status: 'APPROVED' }),
            catalogueItem: expect.objectContaining({
              lifecycleStatus: 'PUBLISHED',
              speciesLinks: expect.objectContaining({
                none: expect.objectContaining({
                  species: expect.objectContaining({
                    regulatoryStatus: 'PROHIBITED',
                  }),
                }),
              }),
            }),
            lot: expect.objectContaining({ foodSafetyStatus: 'SAFE' }),
            photos: expect.objectContaining({
              some: expect.objectContaining({
                withdrawnAt: null,
                moderationStatus: ListingPhotoModerationStatus.APPROVED,
              }),
            }),
          }),
        }),
      );
    });

    it('applies search, price range, category, species, and fulfillment filters', async () => {
      (prisma.vendorDailyListing.findMany as jest.Mock).mockResolvedValue([]);

      await repository.findMany({
        page: 1,
        pageSize: 20,
        search: 'Snapper',
        categoryId: 'cat-1',
        speciesId: 'sp-1',
        minPrice: 500,
        maxPrice: 1200,
        deliveryAvailable: true,
        pickupAvailable: true,
      });

      expect(prisma.vendorDailyListing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            catalogueItem: expect.objectContaining({ categoryId: 'cat-1' }),
            speciesDeclarations: expect.objectContaining({
              some: { speciesId: 'sp-1' },
            }),
            price: {
              gte: new Prisma.Decimal(500),
              lte: new Prisma.Decimal(1200),
            },
            deliveryAvailable: true,
            pickupAvailable: true,
            AND: expect.arrayContaining([
              expect.objectContaining({
                OR: expect.arrayContaining([
                  { listingTitle: { contains: 'Snapper', mode: 'insensitive' } },
                ]),
              }),
            ]),
          }),
        }),
      );
    });
  });

  describe('withdrawPhoto listing scope isolation', () => {
    it('throws NotFoundException when photo belongs to a different listing', async () => {
      mockTx.listingPhoto.findUnique = jest.fn().mockResolvedValue({
        ...validPhoto,
        vendorDailyListingId: 'other-listing',
      });

      await expect(
        repository.withdrawPhoto('photo-1', 'user-1', 'Cleanup reason', 'listing-1'),
      ).rejects.toThrow(new NotFoundException('Photo not found on this listing'));
      expect(mockTx.listingPhoto.update).not.toHaveBeenCalled();
    });
  });
});
