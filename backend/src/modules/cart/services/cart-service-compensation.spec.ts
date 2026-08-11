import { PrismaService } from '../../../database/prisma.service';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartRepository } from '../repositories/cart.repository';
import { buildCart, buildCartItem, buildProduct, buildVendor } from './cart-service-test-helpers';
import { CartService } from './cart.service';

// Phase 16A.0-DA, Unit DA.1A (see the DA.1 architecture review, including
// the concurrency-proof correction). Covers the convergence algorithm's
// Redis-failure/compensation branching in isolation - split from
// cart.service.spec.ts to stay under the 400-line file cap. Basic
// CRUD/validation behavior lives there.
//
// applyCompensation attempts the CartItem-level compensation FIRST and the
// marker-generation gate SECOND, both inside the same transaction -
// deliberately matching the primary-mutation path's own lock order, to
// eliminate the opposite-order deadlock a marker-first gate would create
// (see the DA.1 architecture review's lock-ordering correction). The
// marker's permanent generation remains the actual correctness boundary: a
// late gate miss throws StaleCompensationGenerationError, rolling back the
// WHOLE transaction (including any tentative CartItem write already made),
// so nothing commits regardless of which check ran first.
describe('CartService compensation (DA.1A)', () => {
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
    Pick<
      CartReservationSyncStateRepository,
      'upsertDesiredState' | 'resolveIfCurrentGeneration' | 'advanceIfCurrentGeneration' | 'markUnresolved'
    >
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
      advanceIfCurrentGeneration: jest.fn(),
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

  describe('addItem', () => {
    it('gates on marker generation, then compensates a fresh insert by conditionally deleting it', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      cartRepository.addOrIncrementItem.mockResolvedValue(buildCartItem({ quantity: 2, mutationVersion: 0 }));
      syncState.upsertDesiredState.mockResolvedValue({ generation: 5 });
      inventoryReservations.reserve.mockRejectedValue(new Error('redis down'));
      syncState.advanceIfCurrentGeneration.mockResolvedValue({ count: 1, generation: 6 });
      cartRepository.compensateItemDeleteIfUnchanged.mockResolvedValue({ count: 1 });

      await service.addItem('user-1', { productId: 'product-1', quantity: 2 });

      expect(syncState.advanceIfCurrentGeneration).toHaveBeenCalledWith(
        'cart-1',
        'product-1',
        5,
        0,
        null,
        expect.anything(),
      );
      expect(cartRepository.compensateItemDeleteIfUnchanged).toHaveBeenCalledWith(
        'cart-1',
        'product-1',
        0,
        expect.anything(),
      );
    });

    it('gates on marker generation, then compensates an increment by reverting to the previous quantity', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemByCartAndProduct.mockResolvedValue(buildCartItem({ quantity: 3, mutationVersion: 5 }));
      cartRepository.addOrIncrementItem.mockResolvedValue(buildCartItem({ quantity: 5, mutationVersion: 6 }));
      syncState.upsertDesiredState.mockResolvedValue({ generation: 2 });
      inventoryReservations.reserve.mockRejectedValue(new Error('redis down'));
      syncState.advanceIfCurrentGeneration.mockResolvedValue({ count: 1, generation: 3 });
      cartRepository.compensateItemQuantity.mockResolvedValue({ count: 1 });

      await service.addItem('user-1', { productId: 'product-1', quantity: 2 });

      // newExpectedMutationVersion is mutationVersion+1: the exact value
      // compensateItemQuantity's own {increment:1} will produce, computed
      // in advance rather than re-read after the fact.
      expect(syncState.advanceIfCurrentGeneration).toHaveBeenCalledWith(
        'cart-1',
        'product-1',
        2,
        7,
        3,
        expect.anything(),
      );
      expect(cartRepository.compensateItemQuantity).toHaveBeenCalledWith(
        'cart-1',
        'product-1',
        6,
        3,
        expect.anything(),
      );
    });

    it('never reaches the marker-generation gate when the CartItem-level guard itself misses', async () => {
      // Phase 16A.0-DA, Unit DA.1A concurrency-proof correction: applyCompensation
      // now attempts the CartItem-level write FIRST (matching the primary-
      // mutation path's own lock order), so a miss here short-circuits
      // before the marker is ever touched.
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      cartRepository.addOrIncrementItem.mockResolvedValue(buildCartItem({ quantity: 2, mutationVersion: 0 }));
      inventoryReservations.reserve.mockRejectedValue(new Error('redis down'));
      cartRepository.compensateItemDeleteIfUnchanged.mockResolvedValue({ count: 0 });

      await service.addItem('user-1', { productId: 'product-1', quantity: 2 });

      expect(syncState.advanceIfCurrentGeneration).not.toHaveBeenCalled();
      expect(inventoryReservations.reserve).toHaveBeenCalledTimes(1); // no retry
      expect(syncState.resolveIfCurrentGeneration).not.toHaveBeenCalled();
    });

    it('rolls back the tentative CartItem-level write when the marker-generation gate misses afterward', async () => {
      // The CartItem-level guard alone can tentatively match (e.g. a stale
      // mutationVersion collision after a delete/recreate cycle - see the
      // DA.1 architecture review's ABA finding), but the marker's
      // permanent generation is the actual correctness boundary: a miss
      // there throws StaleCompensationGenerationError, rolling back the
      // WHOLE transaction (including the tentative CartItem write just
      // made) - applyCompensation still reports 'MISSED' to its caller, so
      // no Redis retry and no marker resolution follow.
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      cartRepository.addOrIncrementItem.mockResolvedValue(buildCartItem({ quantity: 2, mutationVersion: 0 }));
      inventoryReservations.reserve.mockRejectedValue(new Error('redis down'));
      cartRepository.compensateItemDeleteIfUnchanged.mockResolvedValue({ count: 1 });
      syncState.advanceIfCurrentGeneration.mockResolvedValue({ count: 0, generation: null });

      // Phase 16A.0-DA, Unit DA.1A (Review #3, Section 6 - "unit-level
      // proof"). Direct proof that the marker miss is signaled by
      // THROWING inside the transaction callback - which Prisma's real
      // $transaction would roll back - rather than by the callback
      // returning a normal resolved value (e.g. {..., missed: true}) that
      // Prisma would happily COMMIT. Instrumented on $transaction's own
      // mock so this observes the callback's actual settlement, not just
      // applyCompensation's already-translated 'MISSED' return value.
      let transactionCallbackRejected = false;
      prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
        try {
          return await callback({});
        } catch (error) {
          transactionCallbackRejected = true;
          throw error;
        }
      });

      await service.addItem('user-1', { productId: 'product-1', quantity: 2 });

      expect(cartRepository.compensateItemDeleteIfUnchanged).toHaveBeenCalled();
      expect(transactionCallbackRejected).toBe(true);
      expect(inventoryReservations.reserve).toHaveBeenCalledTimes(1); // no retry
      expect(syncState.resolveIfCurrentGeneration).not.toHaveBeenCalled();
    });

    it('re-asserts the reverted value in Redis after a successful compensation, resolved by the new generation', async () => {
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      cartRepository.addOrIncrementItem.mockResolvedValue(buildCartItem({ quantity: 2, mutationVersion: 0 }));
      inventoryReservations.reserve.mockRejectedValue(new Error('redis down'));
      syncState.advanceIfCurrentGeneration.mockResolvedValue({ count: 1, generation: 9 });
      cartRepository.compensateItemDeleteIfUnchanged.mockResolvedValue({ count: 1 });

      await service.addItem('user-1', { productId: 'product-1', quantity: 2 });

      expect(inventoryReservations.release).toHaveBeenCalledWith('product-1', 'cart-1');
      expect(syncState.resolveIfCurrentGeneration).toHaveBeenCalledWith('cart-1', 'product-1', 9);
    });

    it('marks the marker unresolved when the compensation retry write itself is stale', async () => {
      // Same required invariant as the primary-mutation path (see
      // confirmOrUnresolve): the compensation retry's own reserve/release
      // call succeeding is not proof it wasn't overwritten by a still-newer
      // mutation - a resolve miss must never be silently treated as
      // convergence.
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      cartRepository.addOrIncrementItem.mockResolvedValue(buildCartItem({ quantity: 2, mutationVersion: 0 }));
      inventoryReservations.reserve.mockRejectedValue(new Error('redis down'));
      syncState.advanceIfCurrentGeneration.mockResolvedValue({ count: 1, generation: 9 });
      cartRepository.compensateItemDeleteIfUnchanged.mockResolvedValue({ count: 1 });
      syncState.resolveIfCurrentGeneration.mockResolvedValue({ count: 0 });

      await service.addItem('user-1', { productId: 'product-1', quantity: 2 });

      expect(syncState.resolveIfCurrentGeneration).toHaveBeenCalledWith('cart-1', 'product-1', 9);
      expect(syncState.markUnresolved).toHaveBeenCalledWith('cart-1', 'product-1');
    });
  });

  describe('updateItemQuantity', () => {
    it('gates on marker generation before compensating by reverting to the previous quantity', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemById.mockResolvedValue(buildCartItem({ quantity: 1, mutationVersion: 4 }));
      cartRepository.updateItemQuantity.mockResolvedValue(buildCartItem({ quantity: 5, mutationVersion: 5 }));
      syncState.upsertDesiredState.mockResolvedValue({ generation: 1 });
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      inventoryReservations.reserve.mockRejectedValue(new Error('redis down'));
      syncState.advanceIfCurrentGeneration.mockResolvedValue({ count: 1, generation: 2 });
      cartRepository.compensateItemQuantity.mockResolvedValue({ count: 1 });

      await service.updateItemQuantity('user-1', 'item-1', { quantity: 5 });

      expect(syncState.advanceIfCurrentGeneration).toHaveBeenCalledWith(
        'cart-1',
        'product-1',
        1,
        6,
        1,
        expect.anything(),
      );
      expect(cartRepository.compensateItemQuantity).toHaveBeenCalledWith(
        'cart-1',
        'product-1',
        5,
        1,
        expect.anything(),
      );
    });

    it('never reaches the marker-generation gate when the CartItem-level guard itself misses', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemById.mockResolvedValue(buildCartItem({ quantity: 1, mutationVersion: 4 }));
      cartRepository.updateItemQuantity.mockResolvedValue(buildCartItem({ quantity: 5, mutationVersion: 5 }));
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      inventoryReservations.reserve.mockRejectedValue(new Error('redis down'));
      cartRepository.compensateItemQuantity.mockResolvedValue({ count: 0 });

      await service.updateItemQuantity('user-1', 'item-1', { quantity: 5 });

      expect(syncState.advanceIfCurrentGeneration).not.toHaveBeenCalled();
      expect(syncState.resolveIfCurrentGeneration).not.toHaveBeenCalled();
      expect(inventoryReservations.reserve).toHaveBeenCalledTimes(1); // no retry
    });

    it('rolls back the tentative CartItem-level write when the marker-generation gate misses afterward', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemById.mockResolvedValue(buildCartItem({ quantity: 1, mutationVersion: 4 }));
      cartRepository.updateItemQuantity.mockResolvedValue(buildCartItem({ quantity: 5, mutationVersion: 5 }));
      productsRepository.findById.mockResolvedValue(buildProduct());
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      inventoryReservations.reserve.mockRejectedValue(new Error('redis down'));
      cartRepository.compensateItemQuantity.mockResolvedValue({ count: 1 });
      syncState.advanceIfCurrentGeneration.mockResolvedValue({ count: 0, generation: null });

      await service.updateItemQuantity('user-1', 'item-1', { quantity: 5 });

      expect(cartRepository.compensateItemQuantity).toHaveBeenCalled();
      expect(syncState.resolveIfCurrentGeneration).not.toHaveBeenCalled();
      expect(inventoryReservations.reserve).toHaveBeenCalledTimes(1); // no retry
    });
  });

  describe('removeItem', () => {
    it('gates on marker generation before compensating by restoring the item', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemById.mockResolvedValue(buildCartItem({ quantity: 4 }));
      cartRepository.removeItem.mockResolvedValue(buildCartItem({ quantity: 4, mutationVersion: 9 }));
      syncState.upsertDesiredState.mockResolvedValue({ generation: 3 });
      inventoryReservations.release.mockRejectedValue(new Error('redis down'));
      syncState.advanceIfCurrentGeneration.mockResolvedValue({ count: 1, generation: 4 });
      cartRepository.compensateItemRestore.mockResolvedValue({
        restored: true,
        item: buildCartItem({ quantity: 4, mutationVersion: 0 }),
      });

      await service.removeItem('user-1', 'item-1');

      // RESTORE's newExpectedMutationVersion is always 0 - a fresh create
      // always starts there, regardless of what the deleted row's own
      // version was.
      expect(syncState.advanceIfCurrentGeneration).toHaveBeenCalledWith(
        'cart-1',
        'product-1',
        3,
        0,
        4,
        expect.anything(),
      );
      expect(cartRepository.compensateItemRestore).toHaveBeenCalledWith(
        'cart-1',
        'product-1',
        4,
        expect.anything(),
      );
      expect(inventoryReservations.reserve).toHaveBeenCalledWith('product-1', 'cart-1', 4);
    });

    it('never reaches the marker-generation gate when the CartItem-level restore itself misses', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemById.mockResolvedValue(buildCartItem({ quantity: 4 }));
      cartRepository.removeItem.mockResolvedValue(buildCartItem({ quantity: 4, mutationVersion: 9 }));
      inventoryReservations.release.mockRejectedValue(new Error('redis down'));
      cartRepository.compensateItemRestore.mockResolvedValue({ restored: false, item: null });

      await service.removeItem('user-1', 'item-1');

      expect(syncState.advanceIfCurrentGeneration).not.toHaveBeenCalled();
      expect(inventoryReservations.reserve).not.toHaveBeenCalled();
      expect(syncState.resolveIfCurrentGeneration).not.toHaveBeenCalled();
    });

    it('rolls back the tentative CartItem-level restore when the marker-generation gate misses afterward', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      cartRepository.findItemById.mockResolvedValue(buildCartItem({ quantity: 4 }));
      cartRepository.removeItem.mockResolvedValue(buildCartItem({ quantity: 4, mutationVersion: 9 }));
      inventoryReservations.release.mockRejectedValue(new Error('redis down'));
      cartRepository.compensateItemRestore.mockResolvedValue({
        restored: true,
        item: buildCartItem({ quantity: 4, mutationVersion: 0 }),
      });
      syncState.advanceIfCurrentGeneration.mockResolvedValue({ count: 0, generation: null });

      await service.removeItem('user-1', 'item-1');

      expect(cartRepository.compensateItemRestore).toHaveBeenCalled();
      expect(inventoryReservations.reserve).not.toHaveBeenCalled(); // no retry
      expect(syncState.resolveIfCurrentGeneration).not.toHaveBeenCalled();
    });
  });
});
