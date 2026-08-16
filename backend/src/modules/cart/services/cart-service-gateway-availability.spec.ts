import { ConflictException } from '@nestjs/common';

import { PrismaService } from '../../../database/prisma.service';
import { CartMutationBarrierService } from '../../cart-mutation-barrier/services/cart-mutation-barrier.service';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { ReservationGateway } from '../../checkout-reservation/types/reservation-gateway.types';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartRepository } from '../repositories/cart.repository';
import { CartItemAddIdempotencyService } from './cart-item-add-idempotency.service';
import { CartReservationConvergenceService } from './cart-reservation-convergence.service';
import { buildCart, buildProduct, buildVendor } from './cart-service-test-helpers';
import { CartService } from './cart.service';

// Phase 16A.0-DA, Unit DA.3 (see the DA.3 frozen plan). Proves
// assertQuantityAvailable's handling of every ReservationAvailabilityResult
// shape via a MOCKED ReservationGateway - LEGACY is the only mode CartService
// observes in production today, but MIRROR/CART_SCOPED/DRAINING/
// RESERVATION_STRUCTURE_DRIFT/INVALID_INPUT must still compile and behave
// sensibly: every non-`ok:true` shape is treated as zero available,
// producing the exact same ConflictException the LEGACY "not enough
// available" path already throws.
describe('CartService assertQuantityAvailable gateway-mode matrix', () => {
  let gateway: jest.Mocked<Pick<ReservationGateway, 'getCartAdmissionAvailability' | 'reserveForCart'>>;
  let cartRepository: jest.Mocked<Pick<CartRepository, 'findOrCreateByCustomerId' | 'findItemByCartAndProduct' | 'addOrIncrementItem'>>;
  let productsRepository: jest.Mocked<Pick<ProductsRepository, 'findById'>>;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findById'>>;
  let syncState: jest.Mocked<
    Pick<CartReservationSyncStateRepository, 'upsertDesiredState' | 'resolveIfCurrentGeneration' | 'markUnresolved'>
  >;
  let idempotency: jest.Mocked<Pick<CartItemAddIdempotencyService, 'classify' | 'reject' | 'complete'>>;
  let service: CartService;

  beforeEach(() => {
    gateway = {
      getCartAdmissionAvailability: jest.fn(),
      reserveForCart: jest.fn().mockResolvedValue({ ok: true, mode: 'LEGACY', mirror: { status: 'NOT_ATTEMPTED' } }),
    };
    cartRepository = {
      findOrCreateByCustomerId: jest.fn().mockResolvedValue(buildCart()),
      findItemByCartAndProduct: jest.fn().mockResolvedValue(null),
      addOrIncrementItem: jest.fn().mockResolvedValue({
        id: 'item-1',
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 2,
        mutationVersion: 0,
      }),
    };
    productsRepository = { findById: jest.fn().mockResolvedValue(buildProduct()) };
    vendorsRepository = { findById: jest.fn().mockResolvedValue(buildVendor()) };
    syncState = {
      upsertDesiredState: jest.fn().mockResolvedValue({ generation: 1 }),
      resolveIfCurrentGeneration: jest.fn().mockResolvedValue({ count: 1 }),
      markUnresolved: jest.fn().mockResolvedValue({ count: 1 }),
    };
    idempotency = {
      classify: jest.fn().mockResolvedValue({ outcome: 'EXECUTE', attemptId: 'attempt-1', attemptCount: 1 }),
      reject: jest.fn().mockResolvedValue({ count: 1 }),
      complete: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const mutationBarrier: jest.Mocked<Pick<CartMutationBarrierService, 'assertNotActive'>> = {
      assertNotActive: jest.fn().mockResolvedValue(undefined),
    };
    const convergence = new CartReservationConvergenceService(
      { $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb({})) } as unknown as PrismaService,
      cartRepository as unknown as CartRepository,
      gateway as unknown as ReservationGateway,
      syncState as unknown as CartReservationSyncStateRepository,
    );
    service = new CartService(
      { $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb({})) } as unknown as PrismaService,
      cartRepository as unknown as CartRepository,
      productsRepository as unknown as ProductsRepository,
      vendorsRepository as unknown as VendorsRepository,
      gateway as unknown as ReservationGateway,
      syncState as unknown as CartReservationSyncStateRepository,
      convergence,
      idempotency as unknown as CartItemAddIdempotencyService,
      mutationBarrier as unknown as CartMutationBarrierService,
    );
  });

  it('LEGACY: admits when requested quantity is within `available`', async () => {
    gateway.getCartAdmissionAvailability.mockResolvedValue({ ok: true, mode: 'LEGACY', source: 'LEGACY', available: 5 });

    await expect(service.addItem('user-1', { productId: 'product-1', quantity: 2 }, 'key-1')).resolves.toBeDefined();
  });

  it('LEGACY: rejects when requested quantity exceeds `available`', async () => {
    gateway.getCartAdmissionAvailability.mockResolvedValue({ ok: true, mode: 'LEGACY', source: 'LEGACY', available: 1 });

    await expect(
      service.addItem('user-1', { productId: 'product-1', quantity: 2 }, 'key-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('MIRROR: admits using the legacy-derived `available`, ignoring the diagnostic mirrorComparison', async () => {
    gateway.getCartAdmissionAvailability.mockResolvedValue({
      ok: true,
      mode: 'MIRROR',
      source: 'LEGACY',
      available: 5,
      mirrorComparison: { status: 'STRUCTURE_DRIFT_CONFIRMED' },
    });

    await expect(service.addItem('user-1', { productId: 'product-1', quantity: 2 }, 'key-1')).resolves.toBeDefined();
  });

  it('CART_SCOPED: admits using the new-engine `available`', async () => {
    gateway.getCartAdmissionAvailability.mockResolvedValue({ ok: true, mode: 'CART_SCOPED', source: 'CART_SCOPED', available: 5 });

    await expect(service.addItem('user-1', { productId: 'product-1', quantity: 2 }, 'key-1')).resolves.toBeDefined();
  });

  it('DRAINING: treated as zero available, always rejects', async () => {
    gateway.getCartAdmissionAvailability.mockResolvedValue({ ok: false, mode: 'DRAINING', code: 'MODE_NOT_ADMITTING' });

    await expect(
      service.addItem('user-1', { productId: 'product-1', quantity: 2 }, 'key-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('RESERVATION_STRUCTURE_DRIFT: treated as zero available, always rejects', async () => {
    gateway.getCartAdmissionAvailability.mockResolvedValue({ ok: false, code: 'RESERVATION_STRUCTURE_DRIFT' });

    await expect(
      service.addItem('user-1', { productId: 'product-1', quantity: 2 }, 'key-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('INVALID_INPUT: treated as zero available, always rejects', async () => {
    gateway.getCartAdmissionAvailability.mockResolvedValue({ ok: false, code: 'INVALID_INPUT', field: 'cartId', reason: 'malformed' });

    await expect(
      service.addItem('user-1', { productId: 'product-1', quantity: 2 }, 'key-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
