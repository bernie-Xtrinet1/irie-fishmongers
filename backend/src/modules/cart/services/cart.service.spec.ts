import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, SeafoodLot, Vendor } from '@prisma/client';

import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ProductsRepository, ProductWithLot } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartRepository, CartWithItems } from '../repositories/cart.repository';
import { CartService } from './cart.service';

function buildProduct(overrides: Partial<ProductWithLot> = {}): ProductWithLot {
  return {
    id: 'product-1',
    vendorId: 'vendor-1',
    categoryId: 'cat-1',
    lotId: null,
    lot: null,
    name: 'Fresh Snapper',
    description: 'Caught this morning.',
    unit: 'PER_POUND',
    price: new Prisma.Decimal(500),
    currency: 'JMD',
    quantityAvailable: 20,
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
    weight: new Prisma.Decimal(20),
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

function buildVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'vendor-1',
    userId: 'vendor-user-1',
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

function buildCart(overrides: Partial<CartWithItems> = {}): CartWithItems {
  return {
    id: 'cart-1',
    customerId: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [],
    ...overrides,
  };
}

describe('CartService', () => {
  let cartRepository: jest.Mocked<
    Pick<
      CartRepository,
      'findOrCreateByCustomerId' | 'addOrIncrementItem' | 'updateItemQuantity' | 'removeItem' | 'findItemById'
    >
  >;
  let productsRepository: jest.Mocked<Pick<ProductsRepository, 'findById'>>;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findById'>>;
  let inventoryReservations: jest.Mocked<
    Pick<InventoryReservationsService, 'getAvailableToPurchase' | 'reserve' | 'release'>
  >;
  let service: CartService;

  beforeEach(() => {
    cartRepository = {
      findOrCreateByCustomerId: jest.fn(),
      addOrIncrementItem: jest.fn(),
      updateItemQuantity: jest.fn(),
      removeItem: jest.fn(),
      findItemById: jest.fn(),
    };
    productsRepository = { findById: jest.fn() };
    vendorsRepository = { findById: jest.fn() };
    inventoryReservations = {
      getAvailableToPurchase: jest.fn().mockResolvedValue(999),
      reserve: jest.fn(),
      release: jest.fn(),
    };

    service = new CartService(
      cartRepository as unknown as CartRepository,
      productsRepository as unknown as ProductsRepository,
      vendorsRepository as unknown as VendorsRepository,
      inventoryReservations as unknown as InventoryReservationsService,
    );
  });

  describe('getCart', () => {
    it('returns the cart mapped with computed subtotals and total', async () => {
      const cart = buildCart({
        items: [
          {
            id: 'item-1',
            cartId: 'cart-1',
            productId: 'product-1',
            quantity: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
            product: buildProduct(),
          },
        ],
      });
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(cart);

      const result = await service.getCart('user-1');

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.subtotal).toBe('1000');
      expect(result.total).toBe('1000');
    });

    it('returns a zero total for an empty cart', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      const result = await service.getCart('user-1');
      expect(result.total).toBe('0');
    });
  });

  describe('addItem', () => {
    it('adds an item for an active product from an approved vendor', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());

      await service.addItem('user-1', { productId: 'product-1', quantity: 2 });

      expect(cartRepository.addOrIncrementItem).toHaveBeenCalledWith('cart-1', 'product-1', 2);
    });

    it('rejects adding an inactive product', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct({ isActive: false }));

      await expect(
        service.addItem('user-1', { productId: 'product-1', quantity: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects adding a product that does not exist', async () => {
      productsRepository.findById.mockResolvedValue(null);

      await expect(
        service.addItem('user-1', { productId: 'missing', quantity: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects adding a product from an unapproved vendor', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor({ status: 'SUSPENDED' }));

      await expect(
        service.addItem('user-1', { productId: 'product-1', quantity: 1 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects adding a product whose lot is not SAFE', async () => {
      productsRepository.findById.mockResolvedValue(
        buildProduct({ lotId: 'lot-1', lot: buildLot({ foodSafetyStatus: 'RECALLED' }) }),
      );

      await expect(
        service.addItem('user-1', { productId: 'product-1', quantity: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('reserves the new total quantity in Redis after a successful add', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());

      await service.addItem('user-1', { productId: 'product-1', quantity: 2 });

      expect(inventoryReservations.reserve).toHaveBeenCalledWith('product-1', 'cart-1', 2);
    });

    it('adds the existing cart quantity to the new request before checking availability', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(
        buildCart({
          items: [
            {
              id: 'item-1',
              cartId: 'cart-1',
              productId: 'product-1',
              quantity: 3,
              createdAt: new Date(),
              updatedAt: new Date(),
              product: buildProduct(),
            },
          ],
        }),
      );

      await service.addItem('user-1', { productId: 'product-1', quantity: 2 });

      expect(inventoryReservations.getAvailableToPurchase).toHaveBeenCalledWith(
        'product-1',
        20,
        'cart-1',
      );
      expect(inventoryReservations.reserve).toHaveBeenCalledWith('product-1', 'cart-1', 5);
    });

    it('rejects adding more than is currently available to purchase', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      inventoryReservations.getAvailableToPurchase.mockResolvedValue(1);

      await expect(
        service.addItem('user-1', { productId: 'product-1', quantity: 2 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(cartRepository.addOrIncrementItem).not.toHaveBeenCalled();
      expect(inventoryReservations.reserve).not.toHaveBeenCalled();
    });
  });

  describe('updateItemQuantity', () => {
    it('updates the quantity of an owned item', async () => {
      const cart = buildCart();
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(cart);
      cartRepository.findItemById.mockResolvedValue({
        id: 'item-1',
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());

      await service.updateItemQuantity('user-1', 'item-1', { quantity: 5 });

      expect(cartRepository.updateItemQuantity).toHaveBeenCalledWith('item-1', 5);
    });

    it('throws when the item does not belong to the cart', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemById.mockResolvedValue(null);

      await expect(
        service.updateItemQuantity('user-1', 'item-1', { quantity: 5 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reserves the new quantity after a successful update', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemById.mockResolvedValue({
        id: 'item-1',
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());

      await service.updateItemQuantity('user-1', 'item-1', { quantity: 5 });

      expect(inventoryReservations.reserve).toHaveBeenCalledWith('product-1', 'cart-1', 5);
    });

    it('rejects updating to a quantity above what is currently available', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemById.mockResolvedValue({
        id: 'item-1',
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      inventoryReservations.getAvailableToPurchase.mockResolvedValue(2);

      await expect(
        service.updateItemQuantity('user-1', 'item-1', { quantity: 5 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(cartRepository.updateItemQuantity).not.toHaveBeenCalled();
    });
  });

  describe('removeItem', () => {
    it('removes an owned item', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemById.mockResolvedValue({
        id: 'item-1',
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await service.removeItem('user-1', 'item-1');
      expect(cartRepository.removeItem).toHaveBeenCalledWith('item-1');
      expect(inventoryReservations.release).toHaveBeenCalledWith('product-1', 'cart-1');
    });

    it('throws when the item does not belong to the cart', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemById.mockResolvedValue(null);

      await expect(service.removeItem('user-1', 'item-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
