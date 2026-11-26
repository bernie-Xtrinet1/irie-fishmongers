import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  CataloguePhotoApprovalStatus,
  InventoryEventType,
  RegulatoryStatus,
  SeafoodLot,
} from '@prisma/client';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { PrismaService } from '../../../database/prisma.service';
import { SeafoodLotsRepository } from '../../food-safety/repositories/seafood-lots.repository';
import { SeafoodLotsService } from '../../food-safety/services/seafood-lots.service';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { MarketplaceConfigService } from '../../marketplace/services/marketplace-config.service';
import { ReviewsQueryService } from '../../reviews/services/reviews-query.service';
import { deriveComplianceBand } from '../../vendor-tiers/utils/compliance-score-band.util';
import { deriveVendorComplianceStatus } from '../../vendor-tiers/utils/vendor-compliance-status.util';
import { VendorDocumentsService } from '../../vendor-tiers/services/vendor-documents.service';
import { VendorPermissionsService } from '../../vendor-tiers/services/vendor-permissions.service';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateProductDto } from '../dto/create-product.dto';
import { SearchProductsDto } from '../dto/search-products.dto';
import { UpdateProductDto } from '../dto/update-product.dto';
import { ProductAvailabilityEntity } from '../entities/product-availability.entity';
import { PaginatedProductsEntity } from '../entities/paginated-products.entity';
import { ProductDetailEntity } from '../entities/product-detail.entity';
import { ProductAvailability, ProductResponseEntity } from '../entities/product-response.entity';
import { CategoriesRepository } from '../repositories/categories.repository';
import {
  ProductsRepository,
  ProductWithCatalogue,
  ProductWithLot,
} from '../repositories/products.repository';

// Structural subset of ProductWithLot that computeAvailability() actually
// needs - lets 12B Inventory Analytics pass a narrow Prisma `select`
// result instead of the full lot-included product shape.
export interface ProductAvailabilityInput {
  isActive: boolean;
  quantityAvailable: number;
  lot: Pick<SeafoodLot, 'foodSafetyStatus' | 'freshnessGrade' | 'qualityScore'> | null;
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly productsRepository: ProductsRepository,
    private readonly categoriesRepository: CategoriesRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly seafoodLotsRepository: SeafoodLotsRepository,
    private readonly seafoodLotsService: SeafoodLotsService,
    private readonly vendorPermissionsService: VendorPermissionsService,
    private readonly vendorDocumentsService: VendorDocumentsService,
    private readonly marketplaceConfigService: MarketplaceConfigService,
    private readonly inventoryEventsRepository: InventoryEventsRepository,
    private readonly inventoryReservations: InventoryReservationsService,
    private readonly reviewsQueryService: ReviewsQueryService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async create(userId: string, dto: CreateProductDto): Promise<ProductResponseEntity> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }
    if (vendor.status !== 'APPROVED') {
      throw new ForbiddenException('Only approved vendors may list products');
    }
    await this.vendorDocumentsService.assertCanSell(vendor.id, vendor.tier);

    let finalCategoryId = dto.categoryId;

    if (dto.catalogueItemId) {
      if (!this.prisma) {
        throw new BadRequestException('Catalogue verification unavailable');
      }
      const catalogueItem = await this.prisma.seafoodCatalogueItem.findUnique({
        where: { id: dto.catalogueItemId },
      });
      if (!catalogueItem) {
        throw new BadRequestException('Catalogue item does not exist');
      }
      if (catalogueItem.lifecycleStatus !== 'PUBLISHED') {
        throw new BadRequestException('Only PUBLISHED catalogue items may be linked to products');
      }
      finalCategoryId = catalogueItem.categoryId;
    }

    if (!finalCategoryId) {
      throw new BadRequestException('Category ID is required when not linking to a catalogue item');
    }

    const category = await this.categoriesRepository.findById(finalCategoryId);
    if (!category) {
      throw new BadRequestException('Category does not exist');
    }

    await this.vendorPermissionsService.assertListingLimitNotExceeded(vendor.id, vendor.tier);

    if (dto.lotId) {
      await this.assertOwnedSellableLot(vendor.id, dto.lotId);
    }

    const mediaAndSpecies = await this.resolveSpeciesAndCataloguePhoto({
      requestedSpeciesId: dto.speciesId,
      requestedCataloguePhotoId: dto.cataloguePhotoId,
      requestedImageUrl: dto.imageUrl,
    });

    const product = await this.productsRepository.create({
      ...dto,
      categoryId: finalCategoryId,
      vendorId: vendor.id,
      ...(mediaAndSpecies.speciesId !== undefined
        ? { speciesId: mediaAndSpecies.speciesId }
        : {}),
      ...(mediaAndSpecies.cataloguePhotoId !== undefined
        ? { cataloguePhotoId: mediaAndSpecies.cataloguePhotoId }
        : {}),
      imageUrl: mediaAndSpecies.imageUrl ?? dto.imageUrl,
    });
    return ProductsService.toResponse(product);
  }

  async update(
    userId: string,
    productId: string,
    dto: UpdateProductDto,
  ): Promise<ProductResponseEntity> {
    const product = await this.getOwnedProduct(userId, productId);

    let finalCategoryId = dto.categoryId;

    // ADR-005 API write rule: a request supplying categoryId for a catalogue-linked product is rejected, not silently overwritten.
    if (dto.categoryId && (product.catalogueItemId || dto.catalogueItemId)) {
      throw new BadRequestException(
        'Category cannot be set directly on a catalogue-linked product; it is derived from the master catalogue item',
      );
    }

    if (dto.catalogueItemId) {
      if (!this.prisma) {
        throw new BadRequestException('Catalogue verification unavailable');
      }
      const catalogueItem = await this.prisma.seafoodCatalogueItem.findUnique({
        where: { id: dto.catalogueItemId },
      });
      if (!catalogueItem) {
        throw new BadRequestException('Catalogue item does not exist');
      }
      if (catalogueItem.lifecycleStatus !== 'PUBLISHED') {
        throw new BadRequestException('Only PUBLISHED catalogue items may be linked to products');
      }
      finalCategoryId = catalogueItem.categoryId;
    } else if (dto.categoryId) {
      const category = await this.categoriesRepository.findById(dto.categoryId);
      if (!category) {
        throw new BadRequestException('Category does not exist');
      }
    }

    if (dto.lotId) {
      await this.assertOwnedSellableLot(product.vendorId, dto.lotId);
    }

    const mediaAndSpecies = await this.resolveSpeciesAndCataloguePhoto({
      requestedSpeciesId: dto.speciesId,
      requestedCataloguePhotoId: dto.cataloguePhotoId,
      requestedImageUrl: dto.imageUrl,
      existingProduct: product,
    });

    const updated = await this.productsRepository.update(product.id, {
      ...dto,
      categoryId: finalCategoryId,
      ...(mediaAndSpecies.speciesId !== undefined
        ? { speciesId: mediaAndSpecies.speciesId }
        : {}),
      ...(mediaAndSpecies.cataloguePhotoId !== undefined
        ? { cataloguePhotoId: mediaAndSpecies.cataloguePhotoId }
        : {}),
      ...(mediaAndSpecies.imageUrl !== undefined
        ? { imageUrl: mediaAndSpecies.imageUrl }
        : {}),
    });
    return ProductsService.toResponse(updated);
  }

  private async assertOwnedSellableLot(vendorId: string, lotId: string): Promise<void> {
    const lot = await this.seafoodLotsRepository.findById(lotId);
    if (!lot || lot.vendorId !== vendorId) {
      throw new BadRequestException('Seafood lot does not exist or does not belong to you');
    }
    if (lot.foodSafetyStatus !== 'SAFE') {
      throw new BadRequestException(
        'This seafood lot is not currently cleared for sale (must be SAFE)',
      );
    }
    this.seafoodLotsService.assertSellable(lot);
  }

  private async resolveSpeciesAndCataloguePhoto(params: {
    requestedSpeciesId?: string | null;
    requestedCataloguePhotoId?: string | null;
    requestedImageUrl?: string;
    existingProduct?: ProductWithCatalogue | ProductWithLot;
  }): Promise<{
    speciesId?: string | null;
    cataloguePhotoId?: string | null;
    imageUrl?: string;
  }> {
    const {
      requestedSpeciesId,
      requestedCataloguePhotoId,
      requestedImageUrl,
      existingProduct,
    } = params;

    let resolvedSpeciesId: string | null | undefined = requestedSpeciesId;

    if (typeof requestedSpeciesId === 'string') {
      if (!this.prisma) {
        throw new BadRequestException('Species verification unavailable');
      }
      const species = await this.prisma.species.findUnique({ where: { id: requestedSpeciesId } });
      if (!species) {
        throw new BadRequestException('Selected seafood species does not exist');
      }
      if (species.regulatoryStatus !== RegulatoryStatus.UNRESTRICTED) {
        throw new BadRequestException(
          `Species ${species.commercialName} (${species.scientificName}) is ${species.regulatoryStatus} and cannot be listed without regulatory clearance`,
        );
      }
    }

    if (typeof requestedCataloguePhotoId === 'string') {
      if (!this.prisma) {
        throw new BadRequestException('Catalogue photo verification unavailable');
      }
      const photo = await this.prisma.cataloguePhoto.findUnique({
        where: { id: requestedCataloguePhotoId },
        include: { species: true },
      });
      if (!photo) {
        throw new BadRequestException('Selected catalogue reference photo does not exist');
      }
      if (photo.approvalStatus !== CataloguePhotoApprovalStatus.APPROVED) {
        throw new BadRequestException('Only APPROVED catalogue reference photos may be used');
      }
      if (photo.species.regulatoryStatus !== RegulatoryStatus.UNRESTRICTED) {
        throw new BadRequestException(
          `Species ${photo.species.commercialName} (${photo.species.scientificName}) is ${photo.species.regulatoryStatus} and cannot be listed without regulatory clearance`,
        );
      }

      const targetSpeciesId =
        requestedSpeciesId === null
          ? null
          : requestedSpeciesId ?? existingProduct?.speciesId ?? null;
      if (targetSpeciesId && targetSpeciesId !== photo.speciesId) {
        throw new BadRequestException(
          'Selected catalogue reference photo does not match the selected species',
        );
      }

      resolvedSpeciesId = requestedSpeciesId === undefined ? photo.speciesId : requestedSpeciesId;
      return {
        speciesId: resolvedSpeciesId,
        cataloguePhotoId: photo.id,
        imageUrl: photo.imageUrl,
      };
    }

    if (requestedCataloguePhotoId === null) {
      return {
        speciesId: resolvedSpeciesId,
        cataloguePhotoId: null,
        imageUrl: requestedImageUrl,
      };
    }

    if (
      existingProduct &&
      requestedImageUrl !== undefined &&
      requestedImageUrl.trim() !== existingProduct.imageUrl
    ) {
      return {
        speciesId: resolvedSpeciesId,
        cataloguePhotoId: null,
        imageUrl: requestedImageUrl,
      };
    }

    return {
      speciesId: resolvedSpeciesId,
      imageUrl: requestedImageUrl,
    };
  }

  async adjustStock(
    userId: string,
    productId: string,
    delta: number,
  ): Promise<ProductResponseEntity> {
    const product = await this.getOwnedProduct(userId, productId);
    return this.applyStockAdjustment(product.id, delta, 'MANUAL_ADJUSTMENT', userId);
  }

  // Called by WasteDisposalRecordsService after it has already run its own
  // ownership/admin check (which allows an admin to record disposal on a
  // vendor's behalf) - skips getOwnedProduct's vendor-only lookup rather
  // than re-implementing quantity decrement + InventoryEvent writing.
  async adjustStockForDisposal(
    productId: string,
    delta: number,
    triggeredById: string,
  ): Promise<ProductResponseEntity> {
    const product = await this.productsRepository.findById(productId);
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return this.applyStockAdjustment(product.id, delta, 'DISPOSED', triggeredById);
  }

  private async applyStockAdjustment(
    productId: string,
    delta: number,
    eventType: InventoryEventType,
    triggeredById: string,
  ): Promise<ProductResponseEntity> {
    const updated = await this.productsRepository.adjustStock(productId, delta);
    await this.inventoryEventsRepository.create({
      productId,
      eventType,
      quantityDelta: delta,
      triggeredById,
    });
    return ProductsService.toResponse(updated);
  }

  async getAvailability(productId: string): Promise<ProductAvailabilityEntity> {
    const product = await this.productsRepository.findById(productId);
    if (!product || !product.isActive) {
      throw new NotFoundException('Product not found');
    }

    const availableToPurchase = await this.inventoryReservations.getAvailableToPurchase(
      product.id,
      product.quantityAvailable,
      '',
    );
    const reserved = product.quantityAvailable - availableToPurchase;

    return {
      productId: product.id,
      quantityAvailable: product.quantityAvailable,
      reserved,
      availableToPurchase,
    };
  }

  async setActive(
    userId: string,
    productId: string,
    isActive: boolean,
  ): Promise<ProductResponseEntity> {
    const product = await this.getOwnedProduct(userId, productId);
    const updated = await this.productsRepository.setActive(product.id, isActive);
    return ProductsService.toResponse(updated);
  }

  async findPublicById(id: string): Promise<ProductResponseEntity> {
    const product = await this.productsRepository.findById(id);
    if (!product || !product.isActive) {
      throw new NotFoundException('Product not found');
    }
    return ProductsService.toResponse(product);
  }

  async getPublicDetail(id: string): Promise<ProductDetailEntity> {
    const product = await this.productsRepository.findById(id);
    if (!product || !product.isActive) {
      throw new NotFoundException('Product not found');
    }

    const vendor = await this.vendorsRepository.findById(product.vendorId);
    if (!vendor) {
      throw new NotFoundException('Product not found');
    }

    const [lot, permissions, modeConfig, ratingSummary] = await Promise.all([
      product.lotId ? this.seafoodLotsService.getPublicById(product.lotId) : Promise.resolve(null),
      this.vendorPermissionsService.getPermissions(vendor.tier),
      this.marketplaceConfigService.getCurrentModeConfig(),
      this.reviewsQueryService.getVendorRatingSummary(vendor.id),
    ]);

    return {
      ...ProductsService.toResponse(product),
      lot,
      vendor: {
        id: vendor.id,
        businessName: vendor.businessName,
        tier: vendor.tier,
        badge: permissions.badge,
        parish: vendor.parish,
        complianceScore: vendor.complianceScore,
        complianceStatus: deriveVendorComplianceStatus(vendor.complianceScore),
        complianceBand: deriveComplianceBand(vendor.complianceScore),
        rating: ratingSummary.averageRating,
        logoUrl: vendor.logoUrl,
      },
      marketplaceModes: {
        customerSelectedEnabled: modeConfig.customerSelectedEnabled,
        bestAvailableEnabled: modeConfig.bestAvailableEnabled,
      },
    };
  }

  async search(dto: SearchProductsDto): Promise<PaginatedProductsEntity> {
    const { items, total } = await this.productsRepository.findMany(
      {
        categoryId: dto.categoryId,
        vendorId: dto.vendorId,
        search: dto.search,
        activeOnly: true,
      },
      { skip: (dto.page - 1) * dto.pageSize, take: dto.pageSize },
    );

    return {
      items: items.map((product) => ProductsService.toResponse(product)),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  async findOwnProducts(userId: string, dto: PaginationDto): Promise<PaginatedProductsEntity> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }

    const { items, total } = await this.productsRepository.findMany(
      { vendorId: vendor.id, activeOnly: false },
      { skip: (dto.page - 1) * dto.pageSize, take: dto.pageSize },
    );

    return {
      items: items.map((product) => ProductsService.toResponse(product)),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  private async getOwnedProduct(userId: string, productId: string): Promise<ProductWithLot> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }

    const product = await this.productsRepository.findById(productId);
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    if (product.vendorId !== vendor.id) {
      throw new ForbiddenException('You do not own this product');
    }

    return product;
  }

  // Public + static so 12B Inventory Analytics can tally availability
  // counts across the whole catalog using this exact same rule, rather
  // than re-deriving "is this product sellable" a second way.
  static computeAvailability(product: ProductAvailabilityInput): ProductAvailability {
    if (!product.isActive) {
      return ProductAvailability.INACTIVE;
    }
    if (
      product.lot &&
      (product.lot.foodSafetyStatus !== 'SAFE' || !SeafoodLotsService.isGradingSellable(product.lot))
    ) {
      return ProductAvailability.ON_HOLD;
    }
    if (product.quantityAvailable === 0) {
      return ProductAvailability.OUT_OF_STOCK;
    }
    return ProductAvailability.ACTIVE;
  }

  private static toResponse(
    product: ProductWithCatalogue | ProductWithLot,
  ): ProductResponseEntity {
    const withCatalogue = product as Partial<ProductWithCatalogue>;
    const species = withCatalogue.species ?? withCatalogue.cataloguePhoto?.species ?? null;
    const photo = withCatalogue.cataloguePhoto ?? null;

    return {
      id: product.id,
      vendorId: product.vendorId,
      categoryId: product.categoryId,
      lotId: product.lotId,
      catalogueItemId: product.catalogueItemId,
      speciesId: product.speciesId ?? null,
      speciesName: species ? `${species.commercialName} (${species.scientificName})` : null,
      cataloguePhotoId: product.cataloguePhotoId ?? null,
      isCatalogueReferencePhoto: Boolean(product.cataloguePhotoId),
      cataloguePhoto: photo
        ? {
            id: photo.id,
            speciesId: photo.speciesId,
            catalogueItemId: photo.catalogueItemId,
            title: photo.title,
            scientificName: photo.scientificName,
            jamaicanAliases: photo.jamaicanAliases,
            imageUrl: photo.imageUrl,
            sourceName: photo.sourceName,
            sourceUrl: photo.sourceUrl,
            photographer: photo.photographer,
            licenseName: photo.licenseName,
            licenseUrl: photo.licenseUrl,
            modifications: photo.modifications,
            requiresAttribution: photo.requiresAttribution,
            approvalStatus: photo.approvalStatus,
            species: photo.species
              ? {
                  id: photo.species.id,
                  commercialName: photo.species.commercialName,
                  scientificName: photo.species.scientificName,
                  regulatoryStatus: photo.species.regulatoryStatus,
                }
              : undefined,
          }
        : null,
      inventoryMode: product.inventoryMode,
      name: product.name,
      description: product.description,
      unit: product.unit,
      price: product.price.toString(),
      currency: product.currency,
      quantityAvailable: product.quantityAvailable,
      imageUrl: product.imageUrl,
      weightLbs: product.weightLbs?.toString() ?? null,
      isActive: product.isActive,
      availability: ProductsService.computeAvailability(product),
      createdAt: product.createdAt,
    };
  }
}
