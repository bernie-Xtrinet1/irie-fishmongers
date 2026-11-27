import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  CatalogueCompositionMode,
  CatalogueLifecycleStatus,
  FoodSafetyStatus,
  ListingLifecycleStatus,
  ListingPhotoModerationStatus,
  Prisma,
  ProductUnit,
  RegulatoryStatus,
  VendorStatus,
  VendorTier,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { SeafoodLotsRepository } from '../../food-safety/repositories/seafood-lots.repository';
import { RegulatoryEligibilityService } from '../../catalogue/services/regulatory-eligibility.service';
import { SeafoodCatalogueRepository } from '../../catalogue/repositories/seafood-catalogue.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorDocumentsService } from '../../vendor-tiers/services/vendor-documents.service';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateDailyListingDto } from '../dto/create-daily-listing.dto';
import { RepeatDailyListingDto } from '../dto/repeat-daily-listing.dto';
import {
  DailyListingWithDetails,
  DailyListingsRepository,
} from '../repositories/daily-listings.repository';
import { DailyListingsService } from '../services/daily-listings.service';

describe('DailyListingsService', () => {
  let service: DailyListingsService;
  let dailyListingsRepo: jest.Mocked<DailyListingsRepository>;
  let vendorsRepo: jest.Mocked<VendorsRepository>;
  let vendorDocsService: jest.Mocked<VendorDocumentsService>;
  let catalogueRepo: jest.Mocked<SeafoodCatalogueRepository>;
  let seafoodLotsRepo: jest.Mocked<SeafoodLotsRepository>;
  let productsRepo: jest.Mocked<ProductsRepository>;
  let regulatoryService: jest.Mocked<RegulatoryEligibilityService>;
  let prisma: jest.Mocked<PrismaService>;

  const mockVendor = {
    id: 'vendor-1',
    userId: 'user-1',
    businessName: 'Port Royal Fish Co',
    description: 'Fresh seafood from Port Royal',
    phone: '876-555-0100',
    parish: 'KINGSTON' as const,
    logoUrl: null,
    status: VendorStatus.APPROVED,
    tier: VendorTier.COMMUNITY_FISHER,
    complianceScore: 90,
    complianceScoreUpdatedAt: null,
    termsAcceptedAt: new Date(),
    primaryZoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockCatalogueItem = {
    id: 'cat-item-1',
    name: 'Yellowtail Snapper',
    scientificName: 'Ocyurus chrysurus',
    scientificFamily: 'Lutjanidae',
    commonName: 'Yellowtail Snapper',
    jamaicanNames: ['Yellowtail'],
    description: 'Fine-flaked white meat',
    categoryId: 'cat-1',
    compositionMode: CatalogueCompositionMode.SINGLE_SPECIES,
    lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
    retirementReason: null,
    retirementNotes: null,
    consolidatedIntoId: null,
    referenceImageUrl: 'https://images.example.com/snapper.jpg',
    imageSourceLicense: 'Public Domain',
    typicalUnit: ProductUnit.PER_POUND,
    typicalSizeMinCm: null,
    typicalSizeMaxCm: null,
    typicalWeightMinLbs: null,
    typicalWeightMaxLbs: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    category: { id: 'cat-1', name: 'Fish', slug: 'fish', createdAt: new Date(), updatedAt: new Date() },
    speciesLinks: [],
    regulatoryOverrides: [],
    consolidatedInto: null,
  };

  const mockLot = {
    id: 'lot-1',
    lotNumber: 'LOT-2026-000101',
    publicTraceToken: 'trace-token-101',
    vendorId: 'vendor-1',
    catchItemId: null,
    species: 'Yellowtail Snapper',
    speciesId: 'sp-1',
    storageType: 'FRESH' as const,
    catchDate: new Date(Date.now() - 3600_000),
    catchLocation: 'Old Harbour Bay',
    landingSite: 'Old Harbour Bay Landing Site',
    weight: new Prisma.Decimal(100),
    weightUnit: 'POUNDS' as const,
    freshnessGrade: 'GRADE_A' as const,
    qualityScore: 95,
    foodSafetyStatus: FoodSafetyStatus.SAFE,
    statusNotes: null,
    originType: 'WILD_CAUGHT' as const,
    acquisitionType: 'DIRECT_CATCH' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPhoto = {
    id: 'photo-1',
    vendorDailyListingId: 'listing-1',
    url: 'https://cdn.example.com/listings/catch1.jpg',
    caption: 'Fresh snapper catch',
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

  const mockListing: DailyListingWithDetails = {
    id: 'listing-1',
    vendorId: 'vendor-1',
    productId: 'prod-1',
    catalogueItemId: 'cat-item-1',
    lotId: 'lot-1',
    landingSiteId: null,
    listingTitle: 'Morning Snapper Catch',
    description: 'Landed at dawn',
    catchDate: new Date(Date.now() - 3600_000),
    availableFrom: new Date(Date.now() - 1800_000),
    expiresAt: new Date(Date.now() + 86400_000),
    unit: ProductUnit.PER_POUND,
    price: new Prisma.Decimal(850),
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
    photos: [mockPhoto],
    speciesDeclarations: [],
    vendor: {
      id: 'vendor-1',
      businessName: 'Port Royal Fish Co',
      tier: VendorTier.COMMUNITY_FISHER,
      parish: 'KINGSTON',
      status: VendorStatus.APPROVED,
    },
    catalogueItem: {
      id: 'cat-item-1',
      name: 'Yellowtail Snapper',
      commonName: 'Yellowtail Snapper',
      categoryId: 'cat-1',
      compositionMode: CatalogueCompositionMode.SINGLE_SPECIES,
      lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
      referenceImageUrl: 'https://images.example.com/snapper.jpg',
    },
    lot: {
      id: 'lot-1',
      lotNumber: 'LOT-2026-000101',
      publicTraceToken: 'trace-token-101',
      freshnessGrade: 'GRADE_A',
      foodSafetyStatus: FoodSafetyStatus.SAFE,
      originType: 'WILD_CAUGHT',
      acquisitionType: 'DIRECT_CATCH',
    },
    landingSite: null,
    product: {
      id: 'prod-1',
      name: 'Morning Snapper Catch',
      inventoryMode: 'LEGACY_PRODUCT',
      quantityAvailable: 50,
    },
  };

  beforeEach(() => {
    dailyListingsRepo = {
      findById: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      addPhoto: jest.fn(),
      withdrawPhoto: jest.fn(),
      setPrimaryPhoto: jest.fn(),
      publishListing: jest.fn(),
      withdrawListing: jest.fn(),
      suspendListing: jest.fn(),
      reinstateListing: jest.fn(),
      updateQuantities: jest.fn(),
      syncProductProjectionUnderLock: jest.fn(),
      findActiveByCatalogueItemId: jest.fn(),
    } as unknown as jest.Mocked<DailyListingsRepository>;

    vendorsRepo = {
      findByUserId: jest.fn().mockResolvedValue(mockVendor),
      findById: jest.fn().mockResolvedValue(mockVendor),
    } as unknown as jest.Mocked<VendorsRepository>;

    vendorDocsService = {
      assertCanSell: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<VendorDocumentsService>;

    catalogueRepo = {
      findById: jest.fn().mockResolvedValue(mockCatalogueItem),
    } as unknown as jest.Mocked<SeafoodCatalogueRepository>;

    seafoodLotsRepo = {
      findById: jest.fn().mockResolvedValue(mockLot),
    } as unknown as jest.Mocked<SeafoodLotsRepository>;

    productsRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'prod-1',
        vendorId: 'vendor-1',
        catalogueItemId: 'cat-item-1',
        name: 'Snapper',
      }),
      update: jest.fn(),
    } as unknown as jest.Mocked<ProductsRepository>;

    regulatoryService = {
      evaluate: jest.fn().mockResolvedValue({
        eligible: true,
        reasons: [],
        evaluatedAt: new Date(),
        mode: 'ENFORCING',
      }),
    } as unknown as jest.Mocked<RegulatoryEligibilityService>;

    prisma = {
      product: {
        findFirst: jest.fn().mockResolvedValue({ id: 'prod-1', inventoryMode: 'LEGACY_PRODUCT', quantityAvailable: 50 }),
        findUnique: jest.fn().mockResolvedValue({ id: 'prod-1', inventoryMode: 'LEGACY_PRODUCT', quantityAvailable: 50 }),
        create: jest.fn().mockResolvedValue({ id: 'prod-new', inventoryMode: 'LEGACY_PRODUCT', quantityAvailable: 0 }),
        update: jest.fn().mockResolvedValue({ id: 'prod-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      landingSite: {
        findUnique: jest.fn().mockResolvedValue({ id: 'site-1', name: 'Old Harbour' }),
      },
      listingPhoto: {
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn().mockResolvedValue({ id: 'photo-1', isPrimary: true }),
      },
      vendorDailyListing: {
        findMany: jest.fn().mockResolvedValue([{ quantityAvailable: new Prisma.Decimal(50) }]),
      },
      $transaction: jest.fn().mockImplementation((fn: (tx: any) => Promise<any>) => fn(prisma)),
    } as unknown as jest.Mocked<PrismaService>;

    service = new DailyListingsService(
      dailyListingsRepo,
      vendorsRepo,
      vendorDocsService,
      catalogueRepo,
      seafoodLotsRepo,
      productsRepo,
      regulatoryService,
      prisma,
    );
  });

  describe('create', () => {
    const createDto: CreateDailyListingDto = {
      catalogueItemId: 'cat-item-1',
      lotId: 'lot-1',
      catchDate: new Date(Date.now() - 3600_000).toISOString(),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      unit: ProductUnit.PER_POUND,
      price: 850,
      quantityUploaded: 50,
    };

    it('creates a daily listing in DRAFT status when parameters are valid', async () => {
      dailyListingsRepo.create.mockResolvedValue(mockListing);

      const result = await service.create('user-1', createDto);

      expect(vendorsRepo.findByUserId).toHaveBeenCalledWith('user-1');
      expect(vendorDocsService.assertCanSell).toHaveBeenCalledWith('vendor-1', VendorTier.COMMUNITY_FISHER);
      expect(catalogueRepo.findById).toHaveBeenCalledWith('cat-item-1');
      expect(seafoodLotsRepo.findById).toHaveBeenCalledWith('lot-1');
      expect(dailyListingsRepo.create).toHaveBeenCalled();
      expect(result.status).toBe(ListingLifecycleStatus.DRAFT);
      expect(result.derivedStatus).toBe(ListingLifecycleStatus.DRAFT);
    });

    it('rejects creation if vendor is not APPROVED', async () => {
      vendorsRepo.findByUserId.mockResolvedValue({
        ...mockVendor,
        status: VendorStatus.PENDING,
      });

      await expect(service.create('user-1', createDto)).rejects.toThrow(ForbiddenException);
    });

    it('rejects creation if master catalogue item is not PUBLISHED', async () => {
      catalogueRepo.findById.mockResolvedValue({
        ...mockCatalogueItem,
        lifecycleStatus: CatalogueLifecycleStatus.DRAFT,
      });

      await expect(service.create('user-1', createDto)).rejects.toThrow(BadRequestException);
    });

    it('rejects creation if seafood lot does not belong to vendor', async () => {
      seafoodLotsRepo.findById.mockResolvedValue({
        ...mockLot,
        vendorId: 'other-vendor',
      });

      await expect(service.create('user-1', createDto)).rejects.toThrow(ForbiddenException);
    });

    it('rejects creation if seafood lot food safety status is not SAFE', async () => {
      seafoodLotsRepo.findById.mockResolvedValue({
        ...mockLot,
        foodSafetyStatus: FoodSafetyStatus.RECALLED,
      });

      await expect(service.create('user-1', createDto)).rejects.toThrow(BadRequestException);
    });

    it('rejects creation for VARIABLE_COMPOSITE item without species declarations', async () => {
      catalogueRepo.findById.mockResolvedValue({
        ...mockCatalogueItem,
        compositionMode: CatalogueCompositionMode.VARIABLE_COMPOSITE,
      });

      await expect(service.create('user-1', createDto)).rejects.toThrow(BadRequestException);
    });

    it('rejects catch date in future', async () => {
      const futureCatchDto = {
        ...createDto,
        catchDate: new Date(Date.now() + 100_000).toISOString(),
      };

      await expect(service.create('user-1', futureCatchDto)).rejects.toThrow(BadRequestException);
    });

    it('rejects expiresAt before or equal to availableFrom', async () => {
      const invalidExpiryDto = {
        ...createDto,
        availableFrom: new Date(Date.now() + 1000).toISOString(),
        expiresAt: new Date(Date.now() + 500).toISOString(),
      };

      await expect(service.create('user-1', invalidExpiryDto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('publish', () => {
    it('publishes listing after verifying photos and regulatory compliance', async () => {
      dailyListingsRepo.findById.mockResolvedValue(mockListing);
      dailyListingsRepo.publishListing.mockResolvedValue({
        ...mockListing,
        status: ListingLifecycleStatus.PUBLISHED,
        publishedAt: new Date(),
      });

      const result = await service.publish('user-1', 'listing-1');

      expect(regulatoryService.evaluate).toHaveBeenCalledWith({
        catalogueItemId: 'cat-item-1',
        vendorDailyListingId: 'listing-1',
        seafoodLotId: 'lot-1',
        atDate: expect.any(Date),
      });
      expect(dailyListingsRepo.publishListing).toHaveBeenCalledWith('listing-1', expect.any(Function));
      // LEGACY_PRODUCT quantityAvailable must NOT be overwritten
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(prisma.product.updateMany).not.toHaveBeenCalled();
      expect(result.status).toBe(ListingLifecycleStatus.PUBLISHED);
      expect(result.derivedStatus).toBe(ListingLifecycleStatus.PUBLISHED);
    });

    it('rejects publication if listing has no approved non-withdrawn photos', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...mockListing,
        photos: [],
      });

      await expect(service.publish('user-1', 'listing-1')).rejects.toThrow(BadRequestException);
    });

    it('rejects publication if listing has only withdrawn photos', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...mockListing,
        photos: [
          {
            ...mockPhoto,
            withdrawnAt: new Date(),
          },
        ],
      });

      await expect(service.publish('user-1', 'listing-1')).rejects.toThrow(BadRequestException);
    });

    it('rejects publication if listing is already expired', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...mockListing,
        expiresAt: new Date(Date.now() - 10_000),
      });

      await expect(service.publish('user-1', 'listing-1')).rejects.toThrow(BadRequestException);
    });

    it('rejects publication if regulatory eligibility check fails', async () => {
      dailyListingsRepo.findById.mockResolvedValue(mockListing);
      regulatoryService.evaluate.mockResolvedValue({
        eligible: false,
        reasons: ['Species Parrotfish is legally prohibited'],
        evaluatedAt: new Date(),
        mode: 'ENFORCING',
      });

      await expect(service.publish('user-1', 'listing-1')).rejects.toThrow(BadRequestException);
      expect(dailyListingsRepo.publishListing).not.toHaveBeenCalled();
    });

    it('rejects publication if regulatory safe-mode defaults to fail-closed', async () => {
      dailyListingsRepo.findById.mockResolvedValue(mockListing);
      regulatoryService.evaluate.mockResolvedValue({
        eligible: false,
        reasons: ['Regulatory evaluation degraded fail-closed mode'],
        evaluatedAt: new Date(),
        mode: 'DEGRADED_FAIL_CLOSED',
      });

      await expect(service.publish('user-1', 'listing-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('update and ownership security', () => {
    it('prevents non-owner vendor from updating listing', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...mockListing,
        vendorId: 'other-vendor-id',
      });

      await expect(
        service.update('user-1', 'listing-1', { listingTitle: 'Hacked' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects updating withdrawn or suspended listing', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...mockListing,
        status: ListingLifecycleStatus.WITHDRAWN,
      });

      await expect(
        service.update('user-1', 'listing-1', { price: 900 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects modifying quantityUploaded on already published listing', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...mockListing,
        status: ListingLifecycleStatus.PUBLISHED,
      });

      await expect(
        service.update('user-1', 'listing-1', { quantityUploaded: 100 }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('photos and withdrawal governance', () => {
    it('adds a photo to listing', async () => {
      dailyListingsRepo.findById.mockResolvedValue(mockListing);
      dailyListingsRepo.addPhoto.mockResolvedValue({
        id: 'photo-2',
        vendorDailyListingId: 'listing-1',
        url: 'https://cdn.example.com/listings/catch2.jpg',
        caption: 'Second angle',
        isPrimary: false,
        moderationStatus: ListingPhotoModerationStatus.APPROVED,
        uploadedAt: new Date(),
        captureDate: null,
        withdrawnAt: null,
        withdrawnByUserId: null,
        withdrawnReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const photo = await service.addPhoto('user-1', 'listing-1', {
        url: 'https://cdn.example.com/listings/catch2.jpg',
        caption: 'Second angle',
      });

      expect(photo.id).toBe('photo-2');
      expect(dailyListingsRepo.addPhoto).toHaveBeenCalled();
    });

    it('withdraws photo with reason and automatically withdraws published listing if 0 photos remain', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...mockListing,
        status: ListingLifecycleStatus.PUBLISHED,
      });
      dailyListingsRepo.withdrawPhoto.mockResolvedValue({
        ...mockPhoto,
        withdrawnAt: new Date(),
        withdrawnReason: 'Wrong batch photo',
      });
      (prisma.listingPhoto.count as jest.Mock).mockResolvedValue(0);

      await service.withdrawPhoto('user-1', 'listing-1', 'photo-1', {
        reason: 'Wrong batch photo',
      });

      expect(dailyListingsRepo.withdrawPhoto).toHaveBeenCalledWith(
        'photo-1',
        'user-1',
        'Wrong batch photo',
        'listing-1',
      );
      expect(dailyListingsRepo.withdrawListing).toHaveBeenCalledWith(
        'listing-1',
        'Automatically withdrawn: all listing photographs withdrawn',
      );
    });

    it('denies cross-vendor read via findOwnedById', async () => {
      vendorsRepo.findByUserId.mockResolvedValue({ ...mockVendor, id: 'vendor-2', userId: 'user-2' });
      dailyListingsRepo.findById.mockResolvedValue(mockListing);

      await expect(service.findOwnedById('user-2', 'listing-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('repeat previous listing', () => {
    it('creates an independent new DRAFT listing with fresh lot and fresh date, without copying photos', async () => {
      dailyListingsRepo.findById.mockResolvedValue(mockListing);
      const freshLot = {
        ...mockLot,
        id: 'lot-2',
        lotNumber: 'LOT-2026-000102',
      };
      seafoodLotsRepo.findById.mockResolvedValue(freshLot);

      const createdRepeatListing: DailyListingWithDetails = {
        ...mockListing,
        id: 'listing-2',
        lotId: 'lot-2',
        status: ListingLifecycleStatus.DRAFT,
        photos: [], // fresh listing has no photos copied over
        createdAt: new Date(),
      };
      dailyListingsRepo.create.mockResolvedValue(createdRepeatListing);

      const repeatDto: RepeatDailyListingDto = {
        catchDate: new Date(Date.now() - 1800_000).toISOString(),
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        quantityUploaded: 40,
        price: 880,
        lotId: 'lot-2',
      };

      const result = await service.repeat('user-1', 'listing-1', repeatDto);

      expect(result.id).toBe('listing-2');
      expect(result.status).toBe(ListingLifecycleStatus.DRAFT);
      expect(result.photos).toEqual([]);
      expect(dailyListingsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ListingLifecycleStatus.DRAFT,
          lotId: 'lot-2',
          price: 880,
          quantityUploaded: 40,
        }),
        expect.any(Array),
      );
    });
  });

  describe('derived read-time lifecycle status', () => {
    it('derives EXPIRED if expiresAt <= now even if stored status is PUBLISHED', () => {
      const derived = service.computeDerivedStatus({
        status: ListingLifecycleStatus.PUBLISHED,
        expiresAt: new Date(Date.now() - 5000),
        quantityAvailable: 25,
      });
      expect(derived).toBe('EXPIRED');
    });

    it('derives SOLD_OUT if quantityAvailable <= 0 when status is PUBLISHED and not expired', () => {
      const derived = service.computeDerivedStatus({
        status: ListingLifecycleStatus.PUBLISHED,
        expiresAt: new Date(Date.now() + 100_000),
        quantityAvailable: 0,
      });
      expect(derived).toBe('SOLD_OUT');
    });

    it('derives PUBLISHED when active, non-expired, and quantityAvailable > 0', () => {
      const derived = service.computeDerivedStatus({
        status: ListingLifecycleStatus.PUBLISHED,
        expiresAt: new Date(Date.now() + 100_000),
        quantityAvailable: 15,
      });
      expect(derived).toBe('PUBLISHED');
    });

    it('preserves actor-driven stored states (DRAFT, WITHDRAWN, SUSPENDED)', () => {
      expect(
        service.computeDerivedStatus({
          status: ListingLifecycleStatus.DRAFT,
          expiresAt: new Date(Date.now() + 100_000),
          quantityAvailable: 10,
        }),
      ).toBe('DRAFT');

      expect(
        service.computeDerivedStatus({
          status: ListingLifecycleStatus.WITHDRAWN,
          expiresAt: new Date(Date.now() + 100_000),
          quantityAvailable: 10,
        }),
      ).toBe('WITHDRAWN');

      expect(
        service.computeDerivedStatus({
          status: ListingLifecycleStatus.SUSPENDED,
          expiresAt: new Date(Date.now() + 100_000),
          quantityAvailable: 10,
        }),
      ).toBe('SUSPENDED');
    });
  });

  describe('admin suspension and reinstatement', () => {
    it('suspends listing with audit reason', async () => {
      dailyListingsRepo.findById.mockResolvedValue(mockListing);
      dailyListingsRepo.suspendListing.mockResolvedValue({
        ...mockListing,
        status: ListingLifecycleStatus.SUSPENDED,
        suspendedAt: new Date(),
        suspensionReason: 'Inspection defect',
      });

      const result = await service.suspend('admin-user', 'listing-1', {
        reason: 'Inspection defect',
      });

      expect(result.status).toBe(ListingLifecycleStatus.SUSPENDED);
      expect(dailyListingsRepo.suspendListing).toHaveBeenCalledWith('listing-1', 'Inspection defect');
    });

    it('reinstates listing after re-verifying regulatory eligibility', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...mockListing,
        status: ListingLifecycleStatus.SUSPENDED,
      });
      regulatoryService.evaluate.mockResolvedValue({
        eligible: true,
        reasons: [],
        evaluatedAt: new Date(),
        mode: 'ENFORCING',
      });
      dailyListingsRepo.reinstateListing.mockResolvedValue({
        ...mockListing,
        status: ListingLifecycleStatus.PUBLISHED,
      });

      const result = await service.reinstate('admin-user', 'listing-1');

      expect(regulatoryService.evaluate).toHaveBeenCalled();
      expect(dailyListingsRepo.reinstateListing).toHaveBeenCalledWith('listing-1', expect.any(Function));
      expect(result.status).toBe(ListingLifecycleStatus.PUBLISHED);
    });

    it('rejects reinstatement if regulatory eligibility fails', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...mockListing,
        status: ListingLifecycleStatus.SUSPENDED,
      });
      regulatoryService.evaluate.mockResolvedValue({
        eligible: false,
        reasons: ['Species closed season active'],
        evaluatedAt: new Date(),
        mode: 'ENFORCING',
      });

      await expect(service.reinstate('admin-user', 'listing-1')).rejects.toThrow(BadRequestException);
      expect(dailyListingsRepo.reinstateListing).not.toHaveBeenCalled();
    });
  });

  describe('inventory authority and projection boundaries (F-16B-01)', () => {
    it('preserves LEGACY_PRODUCT quantityAvailable untouched upon listing publication', async () => {
      // Product is in LEGACY_PRODUCT mode with 50 units of authoritative inventory
      (prisma.product.findUnique as jest.Mock).mockResolvedValue({
        id: 'prod-1',
        inventoryMode: 'LEGACY_PRODUCT',
        quantityAvailable: 50,
      });
      dailyListingsRepo.findById.mockResolvedValue(mockListing);
      dailyListingsRepo.publishListing.mockResolvedValue({
        ...mockListing,
        status: ListingLifecycleStatus.PUBLISHED,
      });

      await service.publish('user-1', 'listing-1');

      // Crucial invariant: product.update and updateMany must NEVER be called to overwrite legacy stock
      expect(prisma.product.updateMany).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('preserves LEGACY_PRODUCT quantityAvailable untouched upon listing withdrawal', async () => {
      (prisma.product.findUnique as jest.Mock).mockResolvedValue({
        id: 'prod-1',
        inventoryMode: 'LEGACY_PRODUCT',
        quantityAvailable: 50,
      });
      dailyListingsRepo.findById.mockResolvedValue({
        ...mockListing,
        status: ListingLifecycleStatus.PUBLISHED,
      });
      dailyListingsRepo.withdrawListing.mockResolvedValue({
        ...mockListing,
        status: ListingLifecycleStatus.WITHDRAWN,
      });

      await service.withdraw('user-1', 'listing-1', { reason: 'End of sales day' });

      expect(prisma.product.updateMany).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('preserves LEGACY_PRODUCT quantityAvailable untouched upon listing suspension and reinstatement', async () => {
      (prisma.product.findUnique as jest.Mock).mockResolvedValue({
        id: 'prod-1',
        inventoryMode: 'LEGACY_PRODUCT',
        quantityAvailable: 50,
      });
      dailyListingsRepo.findById.mockResolvedValue({
        ...mockListing,
        status: ListingLifecycleStatus.PUBLISHED,
      });
      dailyListingsRepo.suspendListing.mockResolvedValue({
        ...mockListing,
        status: ListingLifecycleStatus.SUSPENDED,
      });

      await service.suspend('admin-user', 'listing-1', { reason: 'Administrative audit' });
      expect(prisma.product.updateMany).not.toHaveBeenCalled();
    });

    it('delegates refreshProductQuantityProjection to repository syncProductProjectionUnderLock', async () => {
      await service.refreshProductQuantityProjection('prod-1');

      expect(dailyListingsRepo.syncProductProjectionUnderLock).toHaveBeenCalledWith(
        expect.anything(),
        'prod-1',
      );
    });

    it('does not silently change inventoryMode when creating a listing or backing product', async () => {
      (productsRepo.findById as jest.Mock).mockResolvedValue(null);
      (prisma.product.findFirst as jest.Mock).mockResolvedValue(null);
      dailyListingsRepo.create.mockResolvedValue(mockListing);

      await service.create('user-1', {
        catalogueItemId: 'cat-item-1',
        lotId: 'lot-1',
        unit: ProductUnit.PER_POUND,
        price: 800,
        quantityUploaded: 30,
        catchDate: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      });

      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            inventoryMode: 'LEGACY_PRODUCT',
            quantityAvailable: 0,
          }),
        }),
      );
    });
  });

  describe('Phase 16C Customer Available-Today Discovery & Gating', () => {
    const activePublishedListing: DailyListingWithDetails = {
      ...mockListing,
      status: ListingLifecycleStatus.PUBLISHED,
      availableFrom: new Date(Date.now() - 3600_000),
      expiresAt: new Date(Date.now() + 86400_000),
      quantityAvailable: new Prisma.Decimal(25),
      publishedAt: new Date(),
      vendor: {
        id: 'vendor-1',
        businessName: 'Port Royal Fish Co',
        tier: VendorTier.COMMUNITY_FISHER,
        parish: 'KINGSTON',
        status: VendorStatus.APPROVED,
      },
      catalogueItem: {
        id: 'cat-item-1',
        name: 'Yellowtail Snapper',
        commonName: 'Yellowtail Snapper',
        categoryId: 'cat-1',
        compositionMode: CatalogueCompositionMode.SINGLE_SPECIES,
        lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
        referenceImageUrl: 'https://images.example.com/snapper.jpg',
      },
      lot: {
        id: 'lot-1',
        lotNumber: 'LOT-2026-000101',
        publicTraceToken: 'trace-token-101',
        freshnessGrade: 'GRADE_A',
        foodSafetyStatus: FoodSafetyStatus.SAFE,
        originType: 'WILD_CAUGHT',
        acquisitionType: 'DIRECT_CATCH',
      },
      photos: [mockPhoto],
    };

    it('returns public listing detail when listing is active, published, and regulatory eligible', async () => {
      dailyListingsRepo.findById.mockResolvedValue(activePublishedListing);
      regulatoryService.evaluate.mockResolvedValue({
        eligible: true,
        reasons: [],
        evaluatedAt: new Date(),
        mode: 'ENFORCING',
      });

      const result = await service.findPublicById('listing-1');

      expect(result.id).toBe('listing-1');
      expect(result.status).toBe(ListingLifecycleStatus.PUBLISHED);
      expect(result.quantityAvailable).toBe(25);
    });

    it('fails closed (404) when listing is in DRAFT status', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...activePublishedListing,
        status: ListingLifecycleStatus.DRAFT,
      });

      await expect(service.findPublicById('listing-1')).rejects.toThrow(NotFoundException);
    });

    it('fails closed (404) when listing is expired', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...activePublishedListing,
        expiresAt: new Date(Date.now() - 60_000),
      });

      await expect(service.findPublicById('listing-1')).rejects.toThrow(NotFoundException);
    });

    it('fails closed (404) when listing has 0 available quantity', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...activePublishedListing,
        quantityAvailable: new Prisma.Decimal(0),
      });

      await expect(service.findPublicById('listing-1')).rejects.toThrow(NotFoundException);
    });

    it('fails closed (404) when vendor is not APPROVED', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...activePublishedListing,
        vendor: {
          ...activePublishedListing.vendor!,
          status: VendorStatus.SUSPENDED,
        },
      });

      await expect(service.findPublicById('listing-1')).rejects.toThrow(NotFoundException);
    });

    it('fails closed (404) when backing seafood lot is RECALLED', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...activePublishedListing,
        lot: {
          ...activePublishedListing.lot!,
          foodSafetyStatus: 'RECALLED',
        },
      });

      await expect(service.findPublicById('listing-1')).rejects.toThrow(NotFoundException);
    });

    it('fails closed (404) when listing has no active approved photos', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...activePublishedListing,
        photos: [
          {
            ...mockPhoto,
            withdrawnAt: new Date(),
            withdrawnReason: 'Violation',
          },
        ],
      });

      await expect(service.findPublicById('listing-1')).rejects.toThrow(NotFoundException);
    });

    it('fails closed (404) when regulatory evaluation returns eligible: false', async () => {
      dailyListingsRepo.findById.mockResolvedValue(activePublishedListing);
      regulatoryService.evaluate.mockResolvedValue({
        eligible: false,
        reasons: ['Species closed season in effect'],
        evaluatedAt: new Date(),
        mode: 'ENFORCING',
      });

      await expect(service.findPublicById('listing-1')).rejects.toThrow(NotFoundException);
    });

    it('aggregates available today items by catalogue item with distinct sellers and price bounds', async () => {
      const listing2: DailyListingWithDetails = {
        ...activePublishedListing,
        id: 'listing-2',
        vendorId: 'vendor-2',
        price: new Prisma.Decimal(950),
        quantityAvailable: new Prisma.Decimal(40),
        vendor: {
          id: 'vendor-2',
          businessName: 'Kingston Fishery',
          tier: VendorTier.COMMUNITY_FISHER,
          parish: 'KINGSTON',
          status: VendorStatus.APPROVED,
        },
      };

      dailyListingsRepo.findMany.mockResolvedValue([activePublishedListing, listing2]);
      dailyListingsRepo.count.mockResolvedValue(2);
      regulatoryService.evaluate.mockResolvedValue({
        eligible: true,
        reasons: [],
        evaluatedAt: new Date(),
        mode: 'ENFORCING',
      });

      const result = await service.getAvailableTodayMarketplace({ page: 1, pageSize: 20 });

      expect(result.items).toHaveLength(1);
      const item = result.items[0]!;
      expect(item.catalogueItemId).toBe('cat-item-1');
      expect(item.totalQuantityAvailable).toBe(65);
      expect(item.sellerCount).toBe(2);
      expect(item.minPrice).toBe(850);
      expect(item.maxPrice).toBe(950);
      expect(item.listingsPreview).toHaveLength(2);
    });

    it('excludes regulatory-ineligible listings from active public findMany discovery', async () => {
      const listingIneligible: DailyListingWithDetails = {
        ...activePublishedListing,
        id: 'listing-ineligible',
      };

      dailyListingsRepo.findMany.mockResolvedValue([activePublishedListing, listingIneligible]);
      dailyListingsRepo.count.mockResolvedValue(2);

      regulatoryService.evaluate
        .mockResolvedValueOnce({
          eligible: true,
          reasons: [],
          evaluatedAt: new Date(),
          mode: 'ENFORCING',
        })
        .mockResolvedValueOnce({
          eligible: false,
          reasons: ['Closed season'],
          evaluatedAt: new Date(),
          mode: 'ENFORCING',
        });

      const result = await service.findMany({ page: 1, pageSize: 20, activeOnly: true });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.id).toBe('listing-1');
      expect(result.total).toBe(1);
    });

    it('segregates listings with different units (PER_POUND vs PER_ITEM) into separate aggregated items', async () => {
      const listingPerItem: DailyListingWithDetails = {
        ...activePublishedListing,
        id: 'listing-item',
        unit: ProductUnit.PER_ITEM,
        price: new Prisma.Decimal(2500),
        quantityAvailable: new Prisma.Decimal(15),
      };

      dailyListingsRepo.findMany.mockResolvedValue([activePublishedListing, listingPerItem]);
      regulatoryService.evaluate.mockResolvedValue({
        eligible: true,
        reasons: [],
        evaluatedAt: new Date(),
        mode: 'ENFORCING',
      });

      const result = await service.getAvailableTodayMarketplace({ page: 1, pageSize: 20 });

      expect(result.items).toHaveLength(2);
      const poundItem = result.items.find((i) => i.unit === ProductUnit.PER_POUND)!;
      const itemUnit = result.items.find((i) => i.unit === ProductUnit.PER_ITEM)!;

      expect(poundItem).toBeDefined();
      expect(poundItem.totalQuantityAvailable).toBe(25);
      expect(poundItem.minPrice).toBe(850);
      expect(poundItem.maxPrice).toBe(850);

      expect(itemUnit).toBeDefined();
      expect(itemUnit.totalQuantityAvailable).toBe(15);
      expect(itemUnit.minPrice).toBe(2500);
      expect(itemUnit.maxPrice).toBe(2500);
    });

    it('excludes listings with foodSafetyStatus !== SAFE from aggregation', async () => {
      const recalledListing: DailyListingWithDetails = {
        ...activePublishedListing,
        id: 'listing-recalled',
        lot: {
          ...activePublishedListing.lot!,
          foodSafetyStatus: FoodSafetyStatus.RECALLED,
        },
      };
      const quarantineListing: DailyListingWithDetails = {
        ...activePublishedListing,
        id: 'listing-quarantine',
        lot: {
          ...activePublishedListing.lot!,
          foodSafetyStatus: FoodSafetyStatus.QUARANTINED,
        },
      };

      dailyListingsRepo.findMany.mockResolvedValue([
        activePublishedListing,
        recalledListing,
        quarantineListing,
      ]);
      regulatoryService.evaluate.mockResolvedValue({
        eligible: true,
        reasons: [],
        evaluatedAt: new Date(),
        mode: 'ENFORCING',
      });

      const result = await service.getAvailableTodayMarketplace({ page: 1, pageSize: 20 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.totalQuantityAvailable).toBe(25);
      expect(result.items[0]!.activeListingsCount).toBe(1);
    });

    it('fails closed when regulatory evaluation throws an exception', async () => {
      dailyListingsRepo.findMany.mockResolvedValue([activePublishedListing]);
      regulatoryService.evaluate.mockRejectedValue(new Error('PostgreSQL connection drop'));

      const result = await service.getAvailableTodayMarketplace({ page: 1, pageSize: 20 });

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('Catalogue reference photo guard on Catch of the Day', () => {
    it('rejects adding a /catalogue-photos/* library reference image to Catch of the Day', async () => {
      dailyListingsRepo.findById.mockResolvedValue(mockListing);

      await expect(
        service.addPhoto('user-1', 'listing-1', {
          url: 'https://ca-irie-web.agreeablerock-458effa7.eastus2.azurecontainerapps.io/catalogue-photos/oreochromis-niloticus.png',
        }),
      ).rejects.toThrow(/Catalogue reference photos cannot be used for Catch of the Day/i);
    });

    it('rejects adding a Blob-hosted catalogue image URL (published, draft, or versioned) to Catch of the Day', async () => {
      dailyListingsRepo.findById.mockResolvedValue(mockListing);

      await expect(
        service.addPhoto('user-1', 'listing-1', {
          url: 'https://stiriestaging.blob.core.windows.net/catalogue-photos/published/tilapia/grp-1/v2-abc123.png?sv=2024',
        }),
      ).rejects.toThrow(/Catalogue reference photos cannot be used for Catch of the Day/i);
    });

    it('rejects publishing if the attached photo is a Blob-hosted catalogue image or bundled catalogue photo', async () => {
      dailyListingsRepo.findById.mockResolvedValue({
        ...mockListing,
        photos: [
          {
            ...mockPhoto,
            url: '/catalogue-photos/lutjanus-analis.png',
          },
        ],
      });

      await expect(service.publish('user-1', 'listing-1')).rejects.toThrow(
        /Catalogue reference photos cannot satisfy Catch of the Day/i,
      );

      dailyListingsRepo.findById.mockResolvedValue({
        ...mockListing,
        photos: [
          {
            ...mockPhoto,
            url: 'https://stiriestaging.blob.core.windows.net/catalogue-photos/published/tilapia/grp-1/v1-uuid.png',
          },
        ],
      });

      await expect(service.publish('user-1', 'listing-1')).rejects.toThrow(
        /Catalogue reference photos cannot satisfy Catch of the Day/i,
      );
    });
  });
});
