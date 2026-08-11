import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../../database/prisma.service';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartRepository } from '../repositories/cart.repository';
import { buildCart, buildCartItem, buildLot, buildProduct, buildVendor } from './cart-service-test-helpers';
import { CartService } from './cart.service';

// Compensation/Redis-failure-convergence tests live in
// cart-service-compensation.spec.ts (Phase 16A.0-DA, Unit DA.1A) - split to
// stay under the 400-line file cap.
describe('CartService', () => {
  let prisma: { $transaction: jest.Mock };
  let cartRepository: jest.Mocked<
    Pick<
      CartRepository,
      | 'findOrCreateByCustomerId'
      | 'addOrIncrementItem'
      | 'updateItemQuantity'
      | 'removeItem'
      | 'findItemById'
      | 'findItemByCartAndProduct'
      | 'compensateItemQuantity'
      | 'compensateItemDeleteIfUnchanged'
      | 'compensateItemRestore'
    >
  >;
  let productsRepository: jest.Mocked<Pick<ProductsRepository, 'findById'>>;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findById'>>;
  let inventoryReservations: jest.Mocked<
    Pick<InventoryReservationsService, 'getAvailableToPurchase' | 'reserve' | 'release'>
  >;
  let syncState: jest.Mocked<
    Pick<CartReservationSyncStateRepository, 'upsertDesiredState' | 'resolveIfCurrentGeneration' | 'markUnresolved'>
  >;
  let service: CartService;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn((callback: (tx: unknown) => unknown) => callback({})),
    };
    cartRepository = {
      findOrCreateByCustomerId: jest.fn(),
      addOrIncrementItem: jest.fn(),
      updateItemQuantity: jest.fn(),
      removeItem: jest.fn(),
      findItemById: jest.fn(),
      findItemByCartAndProduct: jest.fn().mockResolvedValue(null),
      compensateItemQuantity: jest.fn(),
      compensateItemDeleteIfUnchanged: jest.fn(),
      compensateItemRestore: jest.fn(),
    };
    productsRepository = { findById: jest.fn() };
    vendorsRepository = { findById: jest.fn() };
    inventoryReservations = {
      getAvailableToPurchase: jest.fn().mockResolvedValue(999),
      reserve: jest.fn(),
      release: jest.fn(),
    };
    syncState = {
      upsertDesiredState: jest.fn().mockResolvedValue({ generation: 0 }),
      resolveIfCurrentGeneration: jest.fn().mockResolvedValue({ count: 1 }),
      markUnresolved: jest.fn().mockResolvedValue({ count: 1 }),
    };

    service = new CartService(
      prisma as unknown as PrismaService,
      cartRepository as unknown as CartRepository,
      productsRepository as unknown as ProductsRepository,
      vendorsRepository as unknown as VendorsRepository,
      inventoryReservations as unknown as InventoryReservationsService,
      syncState as unknown as CartReservationSyncStateRepository,
    );
  });

  describe('getCart', () => {
    it('returns the cart mapped with computed subtotals and total', async () => {
      const cart = buildCart({
        items: [
          {
            ...buildCartItem({ quantity: 2 }),
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
      cartRepository.addOrIncrementItem.mockResolvedValue(buildCartItem({ quantity: 2, mutationVersion: 0 }));

      await service.addItem('user-1', { productId: 'product-1', quantity: 2 });

      expect(cartRepository.addOrIncrementItem).toHaveBeenCalledWith(
        'cart-1',
        'product-1',
        2,
        expect.anything(),
      );
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
      cartRepository.addOrIncrementItem.mockResolvedValue(buildCartItem({ quantity: 2, mutationVersion: 0 }));

      await service.addItem('user-1', { productId: 'product-1', quantity: 2 });

      expect(inventoryReservations.reserve).toHaveBeenCalledWith('product-1', 'cart-1', 2);
    });

    it('resolves the sync marker (by generation) after a successful reserve', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.addOrIncrementItem.mockResolvedValue(buildCartItem({ quantity: 2, mutationVersion: 3 }));
      syncState.upsertDesiredState.mockResolvedValue({ generation: 7 });

      await service.addItem('user-1', { productId: 'product-1', quantity: 2 });

      expect(syncState.upsertDesiredState).toHaveBeenCalledWith('cart-1', 'product-1', 3, 2, expect.anything());
      expect(syncState.resolveIfCurrentGeneration).toHaveBeenCalledWith('cart-1', 'product-1', 7);
    });

    it('marks the marker unresolved (never falsely resolved) when a just-completed reserve write is stale', async () => {
      // Phase 16A.0-DA, Unit DA.1A concurrency-proof correction: reserve/
      // release carry no CAS predicate, so a successful write's own
      // resolveIfCurrentGeneration call can still miss if a newer mutation
      // has since advanced the marker's generation - proving the write may
      // have physically landed after a fresher one. That must never be
      // treated as convergence.
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.addOrIncrementItem.mockResolvedValue(buildCartItem({ quantity: 2, mutationVersion: 0 }));
      syncState.upsertDesiredState.mockResolvedValue({ generation: 7 });
      syncState.resolveIfCurrentGeneration.mockResolvedValue({ count: 0 });

      await service.addItem('user-1', { productId: 'product-1', quantity: 2 });

      expect(syncState.resolveIfCurrentGeneration).toHaveBeenCalledWith('cart-1', 'product-1', 7);
      expect(syncState.markUnresolved).toHaveBeenCalledWith('cart-1', 'product-1');
    });

    it('adds the existing cart quantity to the new request before checking availability', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemByCartAndProduct.mockResolvedValue(buildCartItem({ quantity: 3 }));
      cartRepository.addOrIncrementItem.mockResolvedValue(buildCartItem({ quantity: 5, mutationVersion: 1 }));

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
      cartRepository.findItemById.mockResolvedValue(buildCartItem({ quantity: 1 }));
      cartRepository.updateItemQuantity.mockResolvedValue(buildCartItem({ quantity: 5, mutationVersion: 1 }));
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());

      await service.updateItemQuantity('user-1', 'item-1', { quantity: 5 });

      expect(cartRepository.updateItemQuantity).toHaveBeenCalledWith('item-1', 5, expect.anything());
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
      cartRepository.findItemById.mockResolvedValue(buildCartItem({ quantity: 1 }));
      cartRepository.updateItemQuantity.mockResolvedValue(buildCartItem({ quantity: 5, mutationVersion: 1 }));
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());

      await service.updateItemQuantity('user-1', 'item-1', { quantity: 5 });

      expect(inventoryReservations.reserve).toHaveBeenCalledWith('product-1', 'cart-1', 5);
    });

    it('rejects updating to a quantity above what is currently available', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemById.mockResolvedValue(buildCartItem({ quantity: 1 }));
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
      cartRepository.findItemById.mockResolvedValue(buildCartItem({ quantity: 1 }));
      cartRepository.removeItem.mockResolvedValue(buildCartItem({ quantity: 1, mutationVersion: 2 }));

      await service.removeItem('user-1', 'item-1');
      expect(cartRepository.removeItem).toHaveBeenCalledWith('item-1', expect.anything());
      expect(inventoryReservations.release).toHaveBeenCalledWith('product-1', 'cart-1');
    });

    it('throws when the item does not belong to the cart', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemById.mockResolvedValue(null);

      await expect(service.removeItem('user-1', 'item-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('resolves the sync marker (by generation) for the deleted state after a successful release', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemById.mockResolvedValue(buildCartItem({ quantity: 1 }));
      cartRepository.removeItem.mockResolvedValue(buildCartItem({ quantity: 1, mutationVersion: 2 }));
      syncState.upsertDesiredState.mockResolvedValue({ generation: 4 });

      await service.removeItem('user-1', 'item-1');

      expect(syncState.upsertDesiredState).toHaveBeenCalledWith('cart-1', 'product-1', 2, null, expect.anything());
      expect(syncState.resolveIfCurrentGeneration).toHaveBeenCalledWith('cart-1', 'product-1', 4);
    });

    it('marks the marker unresolved when a just-completed release write is stale', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemById.mockResolvedValue(buildCartItem({ quantity: 1 }));
      cartRepository.removeItem.mockResolvedValue(buildCartItem({ quantity: 1, mutationVersion: 2 }));
      syncState.upsertDesiredState.mockResolvedValue({ generation: 4 });
      syncState.resolveIfCurrentGeneration.mockResolvedValue({ count: 0 });

      await service.removeItem('user-1', 'item-1');

      expect(syncState.resolveIfCurrentGeneration).toHaveBeenCalledWith('cart-1', 'product-1', 4);
      expect(syncState.markUnresolved).toHaveBeenCalledWith('cart-1', 'product-1');
    });
  });
});
