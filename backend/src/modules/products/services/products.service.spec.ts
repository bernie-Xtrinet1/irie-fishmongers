import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Category, SeafoodLot, Vendor } from '@prisma/client';

import { SeafoodLotsRepository } from '../../food-safety/repositories/seafood-lots.repository';
import { SeafoodLotsService } from '../../food-safety/services/seafood-lots.service';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { MarketplaceConfigService } from '../../marketplace/services/marketplace-config.service';
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
    name: 'Fresh Snapper',
    description: 'Caught this morning off the north coast.',
    unit: 'PER_POUND',
    price: { toString: () => '850' } as unknown as ProductWithLot['price'],
    currency: 'JMD',
    quantityAvailable: 10,
    imageUrl: 'https://cdn.example.com/snapper.jpg',
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
    vendorId: 'vendor-1',
    species: 'Snapper',
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
  let seafoodLotsService: jest.Mocked<Pick<SeafoodLotsService, 'getPublicById'>>;
  let vendorPermissionsService: jest.Mocked<
    Pick<VendorPermissionsService, 'assertListingLimitNotExceeded' | 'getPermissions'>
  >;
  let vendorDocumentsService: jest.Mocked<Pick<VendorDocumentsService, 'assertCanSell'>>;
  let marketplaceConfigService: jest.Mocked<Pick<MarketplaceConfigService, 'getCurrentModeConfig'>>;
  let inventoryEventsRepository: jest.Mocked<Pick<InventoryEventsRepository, 'create'>>;
  let inventoryReservations: jest.Mocked<Pick<InventoryReservationsService, 'getAvailableToPurchase'>>;
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
    seafoodLotsService = { getPublicById: jest.fn() };
    vendorPermissionsService = {
      assertListingLimitNotExceeded: jest.fn().mockResolvedValue(undefined),
      getPermissions: jest.fn(),
    };
    vendorDocumentsService = { assertCanSell: jest.fn().mockResolvedValue(undefined) };
    marketplaceConfigService = { getCurrentModeConfig: jest.fn() };
    inventoryEventsRepository = { create: jest.fn().mockResolvedValue(undefined) };
    inventoryReservations = { getAvailableToPurchase: jest.fn().mockResolvedValue(10) };

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
});
