import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Category, SeafoodLot, Vendor } from '@prisma/client';

import { SeafoodLotsRepository } from '../../food-safety/repositories/seafood-lots.repository';
import { SeafoodLotsService } from '../../food-safety/services/seafood-lots.service';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { MarketplaceConfigService } from '../../marketplace/services/marketplace-config.service';
import { ReviewsQueryService } from '../../reviews/services/reviews-query.service';
import { VendorDocumentsService } from '../../vendor-tiers/services/vendor-documents.service';
import { VendorPermissionsService } from '../../vendor-tiers/services/vendor-permissions.service';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CategoriesRepository } from '../repositories/categories.repository';
import { ProductsRepository, ProductWithLot } from '../repositories/products.repository';
import { ProductAvailability } from '../entities/product-response.entity';
import { ProductsService } from './products.service';

function buildVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'vendor-1',
    userId: 'user-1',
    businessName: "Vera's Catch",
    description: null,
    phone: null,
    parish: 'KINGSTON',
    logoUrl: null,
    status: 'APPROVED',
    tier: 'COMMUNITY_FISHER',
    complianceScore: null,
    complianceScoreUpdatedAt: null,
    termsAcceptedAt: new Date(),
    primaryZoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: 'cat-1',
    name: 'Fish',
    slug: 'fish',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildProduct(overrides: Partial<ProductWithLot> = {}): ProductWithLot {
  return {
    id: 'product-1',
    vendorId: 'vendor-1',
    categoryId: 'cat-1',
    lotId: null,
    lot: null,
    catalogueItemId: null,
    speciesId: null,
    cataloguePhotoId: null,
    inventoryMode: 'LEGACY_PRODUCT',
    name: 'Fresh Snapper',
    description: 'Caught this morning off the north coast.',
    unit: 'PER_POUND',
    price: { toString: () => '850' } as unknown as ProductWithLot['price'],
    currency: 'JMD',
    quantityAvailable: 10,
    imageUrl: 'https://cdn.example.com/snapper.jpg',
    weightLbs: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildLot(overrides: Partial<SeafoodLot> = {}): SeafoodLot {
  return {
    id: 'lot-1',
    lotNumber: 'LOT-2026-000001',
    publicTraceToken: 'trace-token-1',
    vendorId: 'vendor-1',
    catchItemId: null,
    species: 'Snapper',
    speciesId: null,
    storageType: 'FRESH',
    catchDate: new Date(),
    catchLocation: null,
    landingSite: null,
    weight: { toString: () => '20' } as unknown as SeafoodLot['weight'],
    weightUnit: 'POUNDS',
    freshnessGrade: null,
    qualityScore: null,
    foodSafetyStatus: 'SAFE',
    statusNotes: null,
    originType: null,
    acquisitionType: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('ProductsService', () => {
  let productsRepository: jest.Mocked<
    Pick<ProductsRepository, 'create' | 'findById' | 'update' | 'setActive' | 'findMany' | 'adjustStock'>
  >;
  let categoriesRepository: jest.Mocked<Pick<CategoriesRepository, 'findById'>>;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findByUserId' | 'findById'>>;
  let seafoodLotsRepository: jest.Mocked<Pick<SeafoodLotsRepository, 'findById'>>;
  let seafoodLotsService: jest.Mocked<Pick<SeafoodLotsService, 'getPublicById' | 'assertSellable'>>;
  let vendorPermissionsService: jest.Mocked<
    Pick<VendorPermissionsService, 'assertListingLimitNotExceeded' | 'getPermissions'>
  >;
  let vendorDocumentsService: jest.Mocked<Pick<VendorDocumentsService, 'assertCanSell'>>;
  let marketplaceConfigService: jest.Mocked<Pick<MarketplaceConfigService, 'getCurrentModeConfig'>>;
  let inventoryEventsRepository: jest.Mocked<Pick<InventoryEventsRepository, 'create'>>;
  let inventoryReservations: jest.Mocked<Pick<InventoryReservationsService, 'getAvailableToPurchase'>>;
  let reviewsQueryService: jest.Mocked<Pick<ReviewsQueryService, 'getVendorRatingSummary'>>;
  let service: ProductsService;

  beforeEach(() => {
    productsRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      setActive: jest.fn(),
      findMany: jest.fn(),
      adjustStock: jest.fn(),
    };
    categoriesRepository = { findById: jest.fn() };
    vendorsRepository = { findByUserId: jest.fn(), findById: jest.fn() };
    seafoodLotsRepository = { findById: jest.fn() };
    seafoodLotsService = { getPublicById: jest.fn(), assertSellable: jest.fn() };
    vendorPermissionsService = {
      assertListingLimitNotExceeded: jest.fn().mockResolvedValue(undefined),
      getPermissions: jest.fn(),
    };
    vendorDocumentsService = { assertCanSell: jest.fn().mockResolvedValue(undefined) };
    marketplaceConfigService = { getCurrentModeConfig: jest.fn() };
    inventoryEventsRepository = { create: jest.fn().mockResolvedValue(undefined) };
    inventoryReservations = { getAvailableToPurchase: jest.fn().mockResolvedValue(10) };
    reviewsQueryService = {
      getVendorRatingSummary: jest.fn().mockResolvedValue({ averageRating: null, reviewCount: 0 }),
    };

    service = new ProductsService(
      productsRepository as unknown as ProductsRepository,
      categoriesRepository as unknown as CategoriesRepository,
      vendorsRepository as unknown as VendorsRepository,
      seafoodLotsRepository as unknown as SeafoodLotsRepository,
      seafoodLotsService as unknown as SeafoodLotsService,
      vendorPermissionsService as unknown as VendorPermissionsService,
      vendorDocumentsService as unknown as VendorDocumentsService,
      marketplaceConfigService as unknown as MarketplaceConfigService,
      inventoryEventsRepository as unknown as InventoryEventsRepository,
      inventoryReservations as unknown as InventoryReservationsService,
      reviewsQueryService as unknown as ReviewsQueryService,
    );
  });

  describe('create', () => {
    const dto = {
      categoryId: 'cat-1',
      name: 'Fresh Snapper',
      description: 'Caught this morning off the north coast.',
      unit: 'PER_POUND' as const,
      price: 850,
      quantityAvailable: 10,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    };

    it('creates a product for an approved vendor', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      categoriesRepository.findById.mockResolvedValue(buildCategory());
      productsRepository.create.mockResolvedValue(buildProduct());

      const result = await service.create('user-1', dto);

      expect(result.availability).toBe(ProductAvailability.ACTIVE);
      expect(productsRepository.create).toHaveBeenCalledWith({ ...dto, vendorId: 'vendor-1' });
    });

    it('throws when the user has no vendor profile', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      await expect(service.create('user-1', dto)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the vendor is not approved', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor({ status: 'PENDING' }));
      await expect(service.create('user-1', dto)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws when the category does not exist', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      categoriesRepository.findById.mockResolvedValue(null);
      await expect(service.create('user-1', dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the vendor is missing required compliance documents', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      vendorDocumentsService.assertCanSell.mockRejectedValue(
        new ForbiddenException(
          'This vendor is missing required, approved compliance documents for their tier',
        ),
      );

      await expect(service.create('user-1', dto)).rejects.toBeInstanceOf(ForbiddenException);
      expect(vendorDocumentsService.assertCanSell).toHaveBeenCalledWith(
        'vendor-1',
        'COMMUNITY_FISHER',
      );
      expect(categoriesRepository.findById).not.toHaveBeenCalled();
    });

    it('creates a product linked to a SAFE lot owned by the same vendor', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      categoriesRepository.findById.mockResolvedValue(buildCategory());
      seafoodLotsRepository.findById.mockResolvedValue(buildLot());
      productsRepository.create.mockResolvedValue(buildProduct({ lotId: 'lot-1' }));

      const result = await service.create('user-1', { ...dto, lotId: 'lot-1' });

      expect(result.lotId).toBe('lot-1');
    });

    it('throws when the lot does not belong to the requesting vendor', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      categoriesRepository.findById.mockResolvedValue(buildCategory());
      seafoodLotsRepository.findById.mockResolvedValue(buildLot({ vendorId: 'vendor-2' }));

      await expect(service.create('user-1', { ...dto, lotId: 'lot-1' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws when the lot is not SAFE', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      categoriesRepository.findById.mockResolvedValue(buildCategory());
      seafoodLotsRepository.findById.mockResolvedValue(buildLot({ foodSafetyStatus: 'QUARANTINED' }));

      await expect(service.create('user-1', { ...dto, lotId: 'lot-1' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('update / adjustStock / setActive (ownership)', () => {
    it('allows the owning vendor to update their product', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      productsRepository.findById.mockResolvedValue(buildProduct());
      productsRepository.update.mockResolvedValue(buildProduct({ name: 'Updated' }));

      const result = await service.update('user-1', 'product-1', { name: 'Updated' });
      expect(result.name).toBe('Updated');
    });

    it('rejects updates from a non-owning vendor', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor({ id: 'vendor-2' }));
      productsRepository.findById.mockResolvedValue(buildProduct({ vendorId: 'vendor-1' }));

      await expect(service.update('user-2', 'product-1', { name: 'x' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws when the product does not exist', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      productsRepository.findById.mockResolvedValue(null);

      await expect(service.update('user-1', 'missing', { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws when updating to a non-existent category', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      productsRepository.findById.mockResolvedValue(buildProduct());
      categoriesRepository.findById.mockResolvedValue(null);

      await expect(
        service.update('user-1', 'product-1', { categoryId: 'missing-cat' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('adjusts stock for an owned product and writes a MANUAL_ADJUSTMENT inventory event', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      productsRepository.findById.mockResolvedValue(buildProduct());
      productsRepository.adjustStock.mockResolvedValue(buildProduct({ quantityAvailable: 7 }));

      const result = await service.adjustStock('user-1', 'product-1', -3);
      expect(result.quantityAvailable).toBe(7);
      expect(inventoryEventsRepository.create).toHaveBeenCalledWith({
        productId: 'product-1',
        eventType: 'MANUAL_ADJUSTMENT',
        quantityDelta: -3,
        triggeredById: 'user-1',
      });
    });

    it('deactivates and reactivates an owned product', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      productsRepository.findById.mockResolvedValue(buildProduct());
      productsRepository.setActive.mockResolvedValue(buildProduct({ isActive: false }));

      const result = await service.setActive('user-1', 'product-1', false);
      expect(result.availability).toBe(ProductAvailability.INACTIVE);
    });
  });

  describe('findPublicById', () => {
    it('returns an active product', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct());
      const result = await service.findPublicById('product-1');
      expect(result.id).toBe('product-1');
    });

    it('throws for an inactive product', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct({ isActive: false }));
      await expect(service.findPublicById('product-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the product does not exist', async () => {
      productsRepository.findById.mockResolvedValue(null);
      await expect(service.findPublicById('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getPublicDetail', () => {
    const permissions = {
      tier: 'COMMUNITY_FISHER' as const,
      badge: '🐟 Community Fisher',
      dailySalesLimit: null,
      monthlySalesLimit: null,
      maxActiveListings: null,
      canSellRetail: true,
      canSellWholesale: false,
      canAcceptHotelOrders: false,
      canAcceptRestaurantOrders: false,
      canAcceptGovernmentOrders: false,
      canExportProducts: false,
      canAccessAnalytics: false,
      canAccessPromotions: false,
      canUseApiAccess: false,
      canOperateMultipleZones: false,
    };
    const modeConfig = {
      id: 'mode-config-1',
      customerSelectedEnabled: true,
      bestAvailableEnabled: false,
      createdAt: new Date(),
    };

    it('composes product, vendor, and marketplace mode data when there is no lot', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      vendorPermissionsService.getPermissions.mockResolvedValue(permissions);
      marketplaceConfigService.getCurrentModeConfig.mockResolvedValue(modeConfig);

      const result = await service.getPublicDetail('product-1');

      expect(result.lot).toBeNull();
      expect(result.vendor.badge).toBe('🐟 Community Fisher');
      expect(result.marketplaceModes.bestAvailableEnabled).toBe(false);
      expect(seafoodLotsService.getPublicById).not.toHaveBeenCalled();
    });

    it('includes traceability data when the product is linked to a lot', async () => {
      const publicLot = {
        lotNumber: 'LOT-2026-000001',
        species: 'Snapper',
        storageType: 'FRESH' as const,
        catchDate: new Date(),
        catchLocation: 'North Coast',
        landingSite: 'Falmouth Landing Site',
        freshnessGrade: null,
        qualityScore: null,
        lastInspectedAt: null,
        vendorBusinessName: "Vera's Catch",
        temperatureVerified: true,
      };
      productsRepository.findById.mockResolvedValue(buildProduct({ lotId: 'lot-1' }));
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      vendorPermissionsService.getPermissions.mockResolvedValue(permissions);
      marketplaceConfigService.getCurrentModeConfig.mockResolvedValue(modeConfig);
      seafoodLotsService.getPublicById.mockResolvedValue(publicLot);

      const result = await service.getPublicDetail('product-1');

      expect(result.lot?.catchLocation).toBe('North Coast');
      expect(seafoodLotsService.getPublicById).toHaveBeenCalledWith('lot-1');
    });

    it('throws for an inactive product', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct({ isActive: false }));
      await expect(service.getPublicDetail('product-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the product does not exist', async () => {
      productsRepository.findById.mockResolvedValue(null);
      await expect(service.getPublicDetail('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('search', () => {
    it('maps repository results to paginated response entities', async () => {
      productsRepository.findMany.mockResolvedValue({
        items: [buildProduct({ quantityAvailable: 0 })],
        total: 1,
      });

      const result = await service.search({ page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(result.items[0]?.availability).toBe(ProductAvailability.OUT_OF_STOCK);
      expect(productsRepository.findMany).toHaveBeenCalledWith(
        { categoryId: undefined, vendorId: undefined, search: undefined, activeOnly: true },
        { skip: 0, take: 20 },
      );
    });

    it('marks a product whose lot is not SAFE as ON_HOLD', async () => {
      productsRepository.findMany.mockResolvedValue({
        items: [buildProduct({ lotId: 'lot-1', lot: buildLot({ foodSafetyStatus: 'UNDER_REVIEW' }) })],
        total: 1,
      });

      const result = await service.search({ page: 1, pageSize: 20 });

      expect(result.items[0]?.availability).toBe(ProductAvailability.ON_HOLD);
    });
  });

  describe('findOwnProducts', () => {
    it("returns the vendor's own products, including inactive ones", async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      productsRepository.findMany.mockResolvedValue({
        items: [buildProduct({ isActive: false })],
        total: 1,
      });

      const result = await service.findOwnProducts('user-1', { page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(result.items[0]?.availability).toBe(ProductAvailability.INACTIVE);
      expect(productsRepository.findMany).toHaveBeenCalledWith(
        { vendorId: 'vendor-1', activeOnly: false },
        { skip: 0, take: 20 },
      );
    });

    it('throws when the user has no vendor profile', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      await expect(
        service.findOwnProducts('user-1', { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getAvailability', () => {
    it('returns quantity, reserved, and availableToPurchase for an active product', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct({ quantityAvailable: 10 }));
      inventoryReservations.getAvailableToPurchase.mockResolvedValue(6);

      const result = await service.getAvailability('product-1');

      expect(result).toEqual({
        productId: 'product-1',
        quantityAvailable: 10,
        reserved: 4,
        availableToPurchase: 6,
      });
      expect(inventoryReservations.getAvailableToPurchase).toHaveBeenCalledWith(
        'product-1',
        10,
        '',
      );
    });

    it('throws for an inactive product', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct({ isActive: false }));
      await expect(service.getAvailability('product-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws when the product does not exist', async () => {
      productsRepository.findById.mockResolvedValue(null);
      await expect(service.getAvailability('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('species and catalogue reference photo library rules', () => {
    const tilapiaSpecies = {
      id: 'sp-tilapia',
      commercialName: 'Tilapia',
      scientificName: 'Oreochromis niloticus',
      regulatoryStatus: 'UNRESTRICTED' as const,
      seasonalStartMonth: null,
      seasonalEndMonth: null,
      minimumSizeCm: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const conchSpecies = {
      ...tilapiaSpecies,
      id: 'sp-conch',
      commercialName: 'Conch',
      scientificName: 'Lobatus gigas',
      regulatoryStatus: 'RESTRICTED' as const,
    };

    const tilapiaPhoto = {
      id: 'photo-tilapia-1',
      speciesId: 'sp-tilapia',
      catalogueItemId: 'cat-tilapia',
      title: 'Nile Tilapia / Red Belly (Oreochromis niloticus)',
      scientificName: 'Oreochromis niloticus',
      jamaicanAliases: ['Tilapia', 'Red Belly'],
      imageUrl: '/catalogue-photos/oreochromis-niloticus.png',
      sourceName: 'Wikimedia Commons',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Oreochromis-niloticus-Nairobi.JPG',
      photographer: 'Bjørn Christian Tørrissen',
      licenseName: 'CC BY-SA 3.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
      modifications: 'Cropped/resized to 900x600 PNG',
      requiresAttribution: true,
      approvalStatus: 'APPROVED' as const,
      versionGroupId: 'photo-tilapia-1',
      versionNumber: 1,
      replacesPhotoId: null,
      isDefault: true,
      storageProvider: 'BUNDLED',
      storageContainer: null,
      storageKey: null,
      mimeType: 'image/png',
      fileSizeBytes: null,
      widthPx: null,
      heightPx: null,
      uploadedByUserId: null,
      publishedAt: new Date(),
      publishedByUserId: null,
      rejectedAt: null,
      rejectedByUserId: null,
      rejectionReason: null,
      retiredAt: null,
      retiredByUserId: null,
      retirementReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      species: tilapiaSpecies,
    };

    function createServiceWithPrisma(prismaMock: Record<string, unknown>): ProductsService {
      return new ProductsService(
        productsRepository as unknown as ProductsRepository,
        categoriesRepository as unknown as CategoriesRepository,
        vendorsRepository as unknown as VendorsRepository,
        seafoodLotsRepository as unknown as SeafoodLotsRepository,
        seafoodLotsService as unknown as SeafoodLotsService,
        vendorPermissionsService as unknown as VendorPermissionsService,
        vendorDocumentsService as unknown as VendorDocumentsService,
        marketplaceConfigService as unknown as MarketplaceConfigService,
        inventoryEventsRepository as unknown as InventoryEventsRepository,
        inventoryReservations as unknown as InventoryReservationsService,
        reviewsQueryService as unknown as ReviewsQueryService,
        prismaMock as any,
      );
    }

    it('creates a product with an approved Tilapia catalogue photo and preserves it on price edits', async () => {
      const prismaMock = {
        species: { findUnique: jest.fn().mockResolvedValue(tilapiaSpecies) },
        cataloguePhoto: { findUnique: jest.fn().mockResolvedValue(tilapiaPhoto) },
      };
      const svc = createServiceWithPrisma(prismaMock);
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      categoriesRepository.findById.mockResolvedValue(buildCategory());
      const createdRow = buildProduct({
        name: 'Whole Fresh Tilapia',
        speciesId: 'sp-tilapia',
        cataloguePhotoId: 'photo-tilapia-1',
        imageUrl: '/catalogue-photos/oreochromis-niloticus.png',
      });
      productsRepository.create.mockResolvedValue({
        ...createdRow,
        species: tilapiaSpecies,
        cataloguePhoto: tilapiaPhoto,
      });

      const created = await svc.create('user-1', {
        categoryId: 'cat-1',
        speciesId: 'sp-tilapia',
        cataloguePhotoId: 'photo-tilapia-1',
        name: 'Whole Fresh Tilapia',
        description: 'Fresh pond-raised Tilapia from St. Elizabeth.',
        unit: 'PER_POUND',
        price: 750,
        quantityAvailable: 20,
        imageUrl: '/catalogue-photos/oreochromis-niloticus.png',
      });

      expect(created.isCatalogueReferencePhoto).toBe(true);
      expect(created.cataloguePhotoId).toBe('photo-tilapia-1');
      expect(created.speciesId).toBe('sp-tilapia');
      expect(created.cataloguePhoto?.licenseName).toBe('CC BY-SA 3.0');

      productsRepository.findById.mockResolvedValue({
        ...createdRow,
        species: tilapiaSpecies,
        cataloguePhoto: tilapiaPhoto,
      });
      productsRepository.update.mockResolvedValue({
        ...createdRow,
        price: { toString: () => '800' } as unknown as ProductWithLot['price'],
        species: tilapiaSpecies,
        cataloguePhoto: tilapiaPhoto,
      });

      const updated = await svc.update('user-1', 'product-1', { price: 800 });
      expect(productsRepository.update).toHaveBeenCalledWith(
        'product-1',
        expect.not.objectContaining({ cataloguePhotoId: null }),
      );
      expect(updated.cataloguePhotoId).toBe('photo-tilapia-1');
      expect(updated.isCatalogueReferencePhoto).toBe(true);
    });

    it('rejects RESTRICTED species such as Conch on standard product creation', async () => {
      const prismaMock = {
        species: { findUnique: jest.fn().mockResolvedValue(conchSpecies) },
        cataloguePhoto: { findUnique: jest.fn() },
      };
      const svc = createServiceWithPrisma(prismaMock);
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      categoriesRepository.findById.mockResolvedValue(buildCategory());

      await expect(
        svc.create('user-1', {
          categoryId: 'cat-1',
          speciesId: 'sp-conch',
          name: 'Queen Conch',
          description: 'Restricted queen conch harvest attempt.',
          unit: 'PER_POUND',
          price: 1500,
          quantityAvailable: 5,
          imageUrl: 'https://cdn.example.com/conch.jpg',
        }),
      ).rejects.toThrow(/RESTRICTED/i);
    });

    it('clears cataloguePhotoId when switching back to a custom HTTPS image URL', async () => {
      const prismaMock = {
        species: { findUnique: jest.fn().mockResolvedValue(tilapiaSpecies) },
        cataloguePhoto: { findUnique: jest.fn().mockResolvedValue(tilapiaPhoto) },
      };
      const svc = createServiceWithPrisma(prismaMock);
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      productsRepository.findById.mockResolvedValue(
        buildProduct({
          speciesId: 'sp-tilapia',
          cataloguePhotoId: 'photo-tilapia-1',
          imageUrl: '/catalogue-photos/oreochromis-niloticus.png',
        }),
      );
      productsRepository.update.mockResolvedValue(
        buildProduct({
          speciesId: 'sp-tilapia',
          cataloguePhotoId: null,
          imageUrl: 'https://cdn.example.com/vendor-tilapia.jpg',
        }),
      );

      const res = await svc.update('user-1', 'product-1', {
        imageUrl: 'https://cdn.example.com/vendor-tilapia.jpg',
      });
      expect(productsRepository.update).toHaveBeenCalledWith(
        'product-1',
        expect.objectContaining({ cataloguePhotoId: null }),
      );
      expect(res.isCatalogueReferencePhoto).toBe(false);
    });

    it('rejects selecting a retired catalogue photo on create or photo change while preserving existing products already linked to it', async () => {
      const retiredPhoto = {
        ...tilapiaPhoto,
        id: 'photo-tilapia-v1-retired',
        retiredAt: new Date(),
        imageUrl: 'https://stiriestaging.blob.core.windows.net/catalogue-photos/published/tilapia/grp/v1.png',
      };
      const prismaMock = {
        species: { findUnique: jest.fn().mockResolvedValue(tilapiaSpecies) },
        cataloguePhoto: { findUnique: jest.fn().mockResolvedValue(retiredPhoto) },
      };
      const svc = createServiceWithPrisma(prismaMock);
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      categoriesRepository.findById.mockResolvedValue(buildCategory());

      await expect(
        svc.create('user-1', {
          categoryId: 'cat-1',
          speciesId: 'sp-tilapia',
          cataloguePhotoId: retiredPhoto.id,
          name: 'Tilapia New Listing',
          description: 'Fresh Tilapia attempt.',
          unit: 'PER_POUND',
          price: 850,
          quantityAvailable: 10,
          imageUrl: retiredPhoto.imageUrl,
        }),
      ).rejects.toThrow(/retired/i);

      // Existing product linked to retiredPhoto BEFORE retirement can still edit price
      const existingRow = buildProduct({
        speciesId: 'sp-tilapia',
        cataloguePhotoId: retiredPhoto.id,
        imageUrl: retiredPhoto.imageUrl,
      });
      productsRepository.findById.mockResolvedValue({
        ...existingRow,
        species: tilapiaSpecies,
        cataloguePhoto: retiredPhoto,
      });
      productsRepository.update.mockResolvedValue({
        ...existingRow,
        price: { toString: () => '900' } as unknown as ProductWithLot['price'],
        species: tilapiaSpecies,
        cataloguePhoto: retiredPhoto,
      });

      const kept = await svc.update('user-1', 'product-1', {
        price: 900,
        cataloguePhotoId: retiredPhoto.id,
      });
      expect(kept.cataloguePhotoId).toBe(retiredPhoto.id);
      expect(kept.imageUrl).toBe(retiredPhoto.imageUrl);
    });
  });
});
