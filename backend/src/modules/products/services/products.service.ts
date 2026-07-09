import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { SeafoodLotsRepository } from '../../food-safety/repositories/seafood-lots.repository';
import { SeafoodLotsService } from '../../food-safety/services/seafood-lots.service';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { MarketplaceConfigService } from '../../marketplace/services/marketplace-config.service';
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
import { ProductsRepository, ProductWithLot } from '../repositories/products.repository';

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

    const category = await this.categoriesRepository.findById(dto.categoryId);
    if (!category) {
      throw new BadRequestException('Category does not exist');
    }

    await this.vendorPermissionsService.assertListingLimitNotExceeded(vendor.id, vendor.tier);

    if (dto.lotId) {
      const lot = await this.seafoodLotsRepository.findById(dto.lotId);
      if (!lot || lot.vendorId !== vendor.id) {
        throw new BadRequestException('Seafood lot does not exist or does not belong to you');
      }
      if (lot.foodSafetyStatus !== 'SAFE') {
        throw new BadRequestException(
          'This seafood lot is not currently cleared for sale (must be SAFE)',
        );
      }
      this.seafoodLotsService.assertSellable(lot);
    }

    const product = await this.productsRepository.create({ ...dto, vendorId: vendor.id });
    return ProductsService.toResponse(product);
  }

  async update(
    userId: string,
    productId: string,
    dto: UpdateProductDto,
  ): Promise<ProductResponseEntity> {
    const product = await this.getOwnedProduct(userId, productId);

    if (dto.categoryId) {
      const category = await this.categoriesRepository.findById(dto.categoryId);
      if (!category) {
        throw new BadRequestException('Category does not exist');
      }
    }

    const updated = await this.productsRepository.update(product.id, dto);
    return ProductsService.toResponse(updated);
  }

  async adjustStock(
    userId: string,
    productId: string,
    delta: number,
  ): Promise<ProductResponseEntity> {
    const product = await this.getOwnedProduct(userId, productId);
    const updated = await this.productsRepository.adjustStock(product.id, delta);
    await this.inventoryEventsRepository.create({
      productId: product.id,
      eventType: 'MANUAL_ADJUSTMENT',
      quantityDelta: delta,
      triggeredById: userId,
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

    const [lot, permissions, modeConfig] = await Promise.all([
      product.lotId ? this.seafoodLotsService.getPublicById(product.lotId) : Promise.resolve(null),
      this.vendorPermissionsService.getPermissions(vendor.tier),
      this.marketplaceConfigService.getCurrentModeConfig(),
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

  private static toResponse(product: ProductWithLot): ProductResponseEntity {
    let availability: ProductAvailability;
    if (!product.isActive) {
      availability = ProductAvailability.INACTIVE;
    } else if (
      product.lot &&
      (product.lot.foodSafetyStatus !== 'SAFE' || !SeafoodLotsService.isGradingSellable(product.lot))
    ) {
      availability = ProductAvailability.ON_HOLD;
    } else if (product.quantityAvailable === 0) {
      availability = ProductAvailability.OUT_OF_STOCK;
    } else {
      availability = ProductAvailability.ACTIVE;
    }

    return {
      id: product.id,
      vendorId: product.vendorId,
      categoryId: product.categoryId,
      lotId: product.lotId,
      name: product.name,
      description: product.description,
      unit: product.unit,
      price: product.price.toString(),
      currency: product.currency,
      quantityAvailable: product.quantityAvailable,
      imageUrl: product.imageUrl,
      isActive: product.isActive,
      availability,
      createdAt: product.createdAt,
    };
  }
}
