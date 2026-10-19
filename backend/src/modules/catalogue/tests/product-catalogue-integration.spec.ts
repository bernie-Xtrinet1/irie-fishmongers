import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CatalogueLifecycleStatus, InventoryMode, ProductUnit } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { SeafoodLotsRepository } from '../../food-safety/repositories/seafood-lots.repository';
import { SeafoodLotsService } from '../../food-safety/services/seafood-lots.service';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { MarketplaceConfigService } from '../../marketplace/services/marketplace-config.service';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { ProductsService } from '../../products/services/products.service';
import { ReviewsQueryService } from '../../reviews/services/reviews-query.service';
import { VendorDocumentsService } from '../../vendor-tiers/services/vendor-documents.service';
import { VendorPermissionsService } from '../../vendor-tiers/services/vendor-permissions.service';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';

describe('Product Catalogue Anchoring Integration (Phase 16A.2)', () => {
  let productsService: ProductsService;
  let mockProductsRepo: any;
  let mockCategoriesRepo: any;
  let mockVendorsRepo: any;
  let mockPrisma: any;

  const mockVendor = { id: 'v-1', userId: 'user-1', status: 'APPROVED', tier: 'SILVER' };
  const mockCategory = { id: 'cat-1', name: 'Fish', slug: 'fish' };
  const mockCatalogueItem = {
    id: 'cat-item-1',
    name: 'Red Snapper',
    categoryId: 'cat-1',
    lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
  };

  beforeEach(async () => {
    mockProductsRepo = {
      create: jest.fn().mockImplementation((input) => Promise.resolve({
        ...input,
        id: 'prod-1',
        currency: 'JMD',
        isActive: true,
        weightLbs: null,
        inventoryMode: input.catalogueItemId ? InventoryMode.LEGACY_PRODUCT : InventoryMode.LEGACY_PRODUCT,
        createdAt: new Date(),
        updatedAt: new Date(),
        lot: null,
      })),
      findById: jest.fn(),
      update: jest.fn().mockImplementation((id, data) => Promise.resolve({
        id,
        vendorId: 'v-1',
        categoryId: data.categoryId || 'cat-1',
        catalogueItemId: data.catalogueItemId !== undefined ? data.catalogueItemId : null,
        inventoryMode: InventoryMode.LEGACY_PRODUCT,
        name: data.name || 'Product',
        description: 'Desc',
        unit: ProductUnit.PER_POUND,
        price: '100.00',
        currency: 'JMD',
        quantityAvailable: 10,
        imageUrl: 'https://example.com/img.jpg',
        weightLbs: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        lot: null,
      })),
    };

    mockCategoriesRepo = {
      findById: jest.fn().mockImplementation((id) =>
        id === 'cat-1' ? Promise.resolve(mockCategory) : Promise.resolve(null),
      ),
    };

    mockVendorsRepo = {
      findByUserId: jest.fn().mockResolvedValue(mockVendor),
    };

    mockPrisma = {
      seafoodCatalogueItem: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.id === 'cat-item-1') return Promise.resolve(mockCatalogueItem);
          if (where.id === 'cat-item-draft') {
            return Promise.resolve({ ...mockCatalogueItem, id: 'cat-item-draft', lifecycleStatus: CatalogueLifecycleStatus.DRAFT });
          }
          return Promise.resolve(null);
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: ProductsRepository, useValue: mockProductsRepo },
        { provide: CategoriesRepository, useValue: mockCategoriesRepo },
        { provide: VendorsRepository, useValue: mockVendorsRepo },
        { provide: SeafoodLotsRepository, useValue: { findById: jest.fn() } },
        { provide: SeafoodLotsService, useValue: { assertSellable: jest.fn() } },
        { provide: VendorPermissionsService, useValue: { assertListingLimitNotExceeded: jest.fn() } },
        { provide: VendorDocumentsService, useValue: { assertCanSell: jest.fn() } },
        { provide: MarketplaceConfigService, useValue: {} },
        { provide: InventoryEventsRepository, useValue: {} },
        { provide: InventoryReservationsService, useValue: {} },
        { provide: ReviewsQueryService, useValue: {} },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    productsService = module.get<ProductsService>(ProductsService);
  });

  it('creates product anchored to PUBLISHED catalogue item and derives categoryId', async () => {
    const res = await productsService.create('user-1', {
      name: 'Vendor Red Snapper',
      description: 'Fresh local snapper caught today',
      unit: ProductUnit.PER_POUND,
      price: 950.0,
      quantityAvailable: 20,
      imageUrl: 'https://example.com/snapper.jpg',
      catalogueItemId: 'cat-item-1',
    });

    expect(res.id).toBe('prod-1');
    expect(res.categoryId).toBe('cat-1');
    expect(mockProductsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogueItemId: 'cat-item-1',
        categoryId: 'cat-1',
      }),
    );
  });

  it('rejects product anchoring to a DRAFT catalogue item', async () => {
    await expect(
      productsService.create('user-1', {
        name: 'Vendor Red Snapper',
        description: 'Fresh local snapper caught today',
        unit: ProductUnit.PER_POUND,
        price: 950.0,
        quantityAvailable: 20,
        imageUrl: 'https://example.com/snapper.jpg',
        catalogueItemId: 'cat-item-draft',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects product anchoring to non-existent catalogue item', async () => {
    await expect(
      productsService.create('user-1', {
        name: 'Vendor Red Snapper',
        description: 'Fresh local snapper caught today',
        unit: ProductUnit.PER_POUND,
        price: 950.0,
        quantityAvailable: 20,
        imageUrl: 'https://example.com/snapper.jpg',
        catalogueItemId: 'cat-item-unknown',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('enforces ADR-005 category-sync rule: rejects setting categoryId directly on catalogue-linked product', async () => {
    mockProductsRepo.findById.mockResolvedValue({
      id: 'prod-linked',
      vendorId: 'v-1',
      categoryId: 'cat-1',
      catalogueItemId: 'cat-item-1',
      isActive: true,
      quantityAvailable: 10,
      lot: null,
    });

    await expect(
      productsService.update('user-1', 'prod-linked', {
        categoryId: 'cat-different',
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'Category cannot be set directly on a catalogue-linked product; it is derived from the master catalogue item',
      ),
    );
  });

  it('allows category update on unlinked legacy product', async () => {
    mockProductsRepo.findById.mockResolvedValue({
      id: 'prod-unlinked',
      vendorId: 'v-1',
      categoryId: 'cat-1',
      catalogueItemId: null,
      isActive: true,
      quantityAvailable: 10,
      lot: null,
    });

    const res = await productsService.update('user-1', 'prod-unlinked', {
      categoryId: 'cat-1',
      name: 'Updated Name',
    });

    expect(res).toBeDefined();
    expect(mockProductsRepo.update).toHaveBeenCalledWith(
      'prod-unlinked',
      expect.objectContaining({ categoryId: 'cat-1', name: 'Updated Name' }),
    );
  });
});
