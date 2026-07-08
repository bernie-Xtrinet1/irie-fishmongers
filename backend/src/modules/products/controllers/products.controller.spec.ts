import { VendorComplianceStatusLabel } from '../../vendor-tiers/entities/vendor-profile-response.entity';
import { ProductAvailabilityEntity } from '../entities/product-availability.entity';
import { ProductDetailEntity } from '../entities/product-detail.entity';
import { ProductAvailability, ProductResponseEntity } from '../entities/product-response.entity';
import { ProductsService } from '../services/products.service';
import { ProductsController } from './products.controller';

const product: ProductResponseEntity = {
  id: 'product-1',
  vendorId: 'vendor-1',
  categoryId: 'cat-1',
  lotId: null,
  name: 'Fresh Snapper',
  description: 'Caught this morning off the north coast.',
  unit: 'PER_POUND',
  price: '850',
  currency: 'JMD',
  quantityAvailable: 10,
  imageUrl: 'https://cdn.example.com/snapper.jpg',
  isActive: true,
  availability: ProductAvailability.ACTIVE,
  createdAt: new Date(),
};

const productDetail: ProductDetailEntity = {
  ...product,
  lot: null,
  vendor: {
    id: 'vendor-1',
    businessName: "Vera's Catch",
    tier: 'COMMUNITY_FISHER',
    badge: '🐟 Community Fisher',
    parish: 'KINGSTON',
    complianceScore: null,
    complianceStatus: VendorComplianceStatusLabel.NOT_YET_ASSESSED,
    logoUrl: null,
  },
  marketplaceModes: { customerSelectedEnabled: true, bestAvailableEnabled: false },
};

const availability: ProductAvailabilityEntity = {
  productId: 'product-1',
  quantityAvailable: 10,
  reserved: 4,
  availableToPurchase: 6,
};

const user = { id: 'user-1', email: 'vendor@example.com', roles: ['VENDOR' as const] };

describe('ProductsController', () => {
  let productsService: jest.Mocked<
    Pick<
      ProductsService,
      | 'create'
      | 'update'
      | 'adjustStock'
      | 'setActive'
      | 'search'
      | 'findPublicById'
      | 'findOwnProducts'
      | 'getPublicDetail'
      | 'getAvailability'
    >
  >;
  let controller: ProductsController;

  beforeEach(() => {
    productsService = {
      create: jest.fn().mockResolvedValue(product),
      update: jest.fn().mockResolvedValue(product),
      adjustStock: jest.fn().mockResolvedValue(product),
      setActive: jest.fn().mockResolvedValue(product),
      search: jest.fn().mockResolvedValue({ items: [product], total: 1, page: 1, pageSize: 20 }),
      findPublicById: jest.fn().mockResolvedValue(product),
      findOwnProducts: jest
        .fn()
        .mockResolvedValue({ items: [product], total: 1, page: 1, pageSize: 20 }),
      getPublicDetail: jest.fn().mockResolvedValue(productDetail),
      getAvailability: jest.fn().mockResolvedValue(availability),
    };
    controller = new ProductsController(productsService as unknown as ProductsService);
  });

  it('creates a product', async () => {
    const dto = {
      categoryId: 'cat-1',
      name: 'Fresh Snapper',
      description: 'Caught this morning off the north coast.',
      unit: 'PER_POUND' as const,
      price: 850,
      quantityAvailable: 10,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    };
    await expect(controller.create(user, dto)).resolves.toEqual(product);
    expect(productsService.create).toHaveBeenCalledWith('user-1', dto);
  });

  it('updates a product', async () => {
    await expect(controller.update(user, 'product-1', { name: 'Updated' })).resolves.toEqual(
      product,
    );
    expect(productsService.update).toHaveBeenCalledWith('user-1', 'product-1', { name: 'Updated' });
  });

  it('adjusts stock', async () => {
    await expect(controller.adjustStock(user, 'product-1', { delta: -3 })).resolves.toEqual(
      product,
    );
    expect(productsService.adjustStock).toHaveBeenCalledWith('user-1', 'product-1', -3);
  });

  it('deactivates a product', async () => {
    await expect(controller.deactivate(user, 'product-1')).resolves.toEqual(product);
    expect(productsService.setActive).toHaveBeenCalledWith('user-1', 'product-1', false);
  });

  it('reactivates a product', async () => {
    await expect(controller.reactivate(user, 'product-1')).resolves.toEqual(product);
    expect(productsService.setActive).toHaveBeenCalledWith('user-1', 'product-1', true);
  });

  it('searches products', async () => {
    const result = await controller.search({ page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
  });

  it('finds a product by id', async () => {
    await expect(controller.findById('product-1')).resolves.toEqual(product);
  });

  it('gets the product detail view', async () => {
    await expect(controller.getDetail('product-1')).resolves.toEqual(productDetail);
    expect(productsService.getPublicDetail).toHaveBeenCalledWith('product-1');
  });

  it('gets product availability', async () => {
    await expect(controller.getAvailability('product-1')).resolves.toEqual(availability);
    expect(productsService.getAvailability).toHaveBeenCalledWith('product-1');
  });

  it("lists the authenticated vendor's own products", async () => {
    const result = await controller.findOwnProducts(user, { page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
    expect(productsService.findOwnProducts).toHaveBeenCalledWith('user-1', {
      page: 1,
      pageSize: 20,
    });
  });
});
