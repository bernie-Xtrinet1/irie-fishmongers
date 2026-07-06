import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Product } from '@prisma/client';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateProductDto } from '../dto/create-product.dto';
import { SearchProductsDto } from '../dto/search-products.dto';
import { UpdateProductDto } from '../dto/update-product.dto';
import { PaginatedProductsEntity } from '../entities/paginated-products.entity';
import { ProductAvailability, ProductResponseEntity } from '../entities/product-response.entity';
import { CategoriesRepository } from '../repositories/categories.repository';
import { ProductsRepository } from '../repositories/products.repository';

@Injectable()
export class ProductsService {
  constructor(
    private readonly productsRepository: ProductsRepository,
    private readonly categoriesRepository: CategoriesRepository,
    private readonly vendorsRepository: VendorsRepository,
  ) {}

  async create(userId: string, dto: CreateProductDto): Promise<ProductResponseEntity> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }
    if (vendor.status !== 'APPROVED') {
      throw new ForbiddenException('Only approved vendors may list products');
    }

    const category = await this.categoriesRepository.findById(dto.categoryId);
    if (!category) {
      throw new BadRequestException('Category does not exist');
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
    return ProductsService.toResponse(updated);
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

  private async getOwnedProduct(userId: string, productId: string): Promise<Product> {
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

  private static toResponse(product: Product): ProductResponseEntity {
    let availability: ProductAvailability;
    if (!product.isActive) {
      availability = ProductAvailability.INACTIVE;
    } else if (product.quantityAvailable === 0) {
      availability = ProductAvailability.OUT_OF_STOCK;
    } else {
      availability = ProductAvailability.ACTIVE;
    }

    return {
      id: product.id,
      vendorId: product.vendorId,
      categoryId: product.categoryId,
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
