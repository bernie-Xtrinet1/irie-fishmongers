import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Category, Product, Vendor } from '@prisma/client';

import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CategoriesRepository } from '../repositories/categories.repository';
import { ProductsRepository } from '../repositories/products.repository';
import { ProductAvailability } from '../entities/product-response.entity';
import { ProductsService } from './products.service';

function buildVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'vendor-1',
    userId: 'user-1',
    businessName: "Vera's Catch",
    status: 'APPROVED',
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

function buildProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-1',
    vendorId: 'vendor-1',
    categoryId: 'cat-1',
    name: 'Fresh Snapper',
    description: 'Caught this morning off the north coast.',
    unit: 'PER_POUND',
    price: { toString: () => '850' } as unknown as Product['price'],
    currency: 'JMD',
    quantityAvailable: 10,
    imageUrl: 'https://cdn.example.com/snapper.jpg',
    isActive: true,
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
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findByUserId'>>;
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
    vendorsRepository = { findByUserId: jest.fn() };

    service = new ProductsService(
      productsRepository as unknown as ProductsRepository,
      categoriesRepository as unknown as CategoriesRepository,
      vendorsRepository as unknown as VendorsRepository,
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

    it('adjusts stock for an owned product', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      productsRepository.findById.mockResolvedValue(buildProduct());
      productsRepository.adjustStock.mockResolvedValue(buildProduct({ quantityAvailable: 7 }));

      const result = await service.adjustStock('user-1', 'product-1', -3);
      expect(result.quantityAvailable).toBe(7);
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
  });
});
