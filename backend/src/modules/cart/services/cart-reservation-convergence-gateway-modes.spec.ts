import { PrismaService } from '../../../database/prisma.service';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { ReservationGateway } from '../../checkout-reservation/types/reservation-gateway.types';
import { CartRepository } from '../repositories/cart.repository';
import { CartReservationConvergenceService } from './cart-reservation-convergence.service';

// Phase 16A.0-DA, Unit DA.3 (see the DA.3 frozen plan). Proves tryRedisWrite's
// contract against a MOCKED ReservationGateway across all four modes' result
// shapes - LEGACY is the only mode CartService can observe in production
// today (nothing calls setMode()), but the type union forces every branch to
// compile and behave correctly, and this is the only way to exercise
// MIRROR/CART_SCOPED/DRAINING without activating a real mode. Frozen plan
// decisions under direct test here: (1) a thrown error and every `ok:false`
// route through the identical compensation/unresolved-marker path: (2) only
// an explicit `ok:true` counts as convergence success.
describe('CartReservationConvergenceService gateway-mode matrix', () => {
  let gateway: jest.Mocked<Pick<ReservationGateway, 'reserveForCart' | 'releaseForCart'>>;
  let syncState: jest.Mocked<
    Pick<CartReservationSyncStateRepository, 'resolveIfCurrentGeneration' | 'markUnresolved' | 'advanceIfCurrentGeneration'>
  >;
  let cartRepository: jest.Mocked<Pick<CartRepository, 'compensateItemDeleteIfUnchanged'>>;
  let prisma: { $transaction: jest.Mock };
  let convergence: CartReservationConvergenceService;

  beforeEach(() => {
    gateway = { reserveForCart: jest.fn(), releaseForCart: jest.fn() };
    syncState = {
      resolveIfCurrentGeneration: jest.fn().mockResolvedValue({ count: 1 }),
      markUnresolved: jest.fn().mockResolvedValue({ count: 1 }),
      advanceIfCurrentGeneration: jest.fn().mockResolvedValue({ count: 1, generation: 2 }),
    };
    cartRepository = { compensateItemDeleteIfUnchanged: jest.fn().mockResolvedValue({ count: 1 }) };
    prisma = { $transaction: jest.fn((callback: (tx: unknown) => unknown) => callback({})) };
    convergence = new CartReservationConvergenceService(
      prisma as unknown as PrismaService,
      cartRepository as unknown as CartRepository,
      gateway as unknown as ReservationGateway,
      syncState as unknown as CartReservationSyncStateRepository,
    );
  });

  const compensationPlan = { kind: 'DELETE_IF_UNCHANGED' as const, mutationVersion: 0 };

  describe('reserveForCart result shapes', () => {
    it('LEGACY ok:true resolves the marker, no compensation attempted', async () => {
      gateway.reserveForCart.mockResolvedValue({ ok: true, mode: 'LEGACY', mirror: { status: 'NOT_ATTEMPTED' } });

      await convergence.convergeReservation('cart-1', 'product-1', 'user-1', 5, 2, compensationPlan);

      expect(syncState.resolveIfCurrentGeneration).toHaveBeenCalledWith('cart-1', 'product-1', 5);
      expect(cartRepository.compensateItemDeleteIfUnchanged).not.toHaveBeenCalled();
    });

    it('MIRROR ok:true resolves the marker even when the diagnostic mirror sub-status is FAILED', async () => {
      gateway.reserveForCart.mockResolvedValue({
        ok: true,
        mode: 'MIRROR',
        mirror: { status: 'FAILED', operation: 'RESERVE', reasonCode: 'UNKNOWN_INFRA_FAILURE' },
      });

      await convergence.convergeReservation('cart-1', 'product-1', 'user-1', 5, 2, compensationPlan);

      expect(syncState.resolveIfCurrentGeneration).toHaveBeenCalledWith('cart-1', 'product-1', 5);
      expect(cartRepository.compensateItemDeleteIfUnchanged).not.toHaveBeenCalled();
    });

    it('CART_SCOPED ok:true resolves the marker', async () => {
      gateway.reserveForCart.mockResolvedValue({ ok: true, mode: 'CART_SCOPED', mirror: { status: 'NOT_ATTEMPTED' } });

      await convergence.convergeReservation('cart-1', 'product-1', 'user-1', 5, 2, compensationPlan);

      expect(syncState.resolveIfCurrentGeneration).toHaveBeenCalledWith('cart-1', 'product-1', 5);
    });

    it('CART_SCOPED ok:false (RESERVATION_PRODUCT_SUSPENDED) triggers compensation, never resolves', async () => {
      gateway.reserveForCart.mockResolvedValue({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });

      await convergence.convergeReservation('cart-1', 'product-1', 'user-1', 5, 2, compensationPlan);

      expect(cartRepository.compensateItemDeleteIfUnchanged).toHaveBeenCalled();
      expect(syncState.resolveIfCurrentGeneration).not.toHaveBeenCalled();
    });

    it('DRAINING ok:false (MODE_NOT_ADMITTING) triggers compensation identically to any other ok:false', async () => {
      gateway.reserveForCart.mockResolvedValue({ ok: false, mode: 'DRAINING', code: 'MODE_NOT_ADMITTING' });

      await convergence.convergeReservation('cart-1', 'product-1', 'user-1', 5, 2, compensationPlan);

      expect(cartRepository.compensateItemDeleteIfUnchanged).toHaveBeenCalled();
      expect(syncState.resolveIfCurrentGeneration).not.toHaveBeenCalled();
    });

    it('INVALID_INPUT ok:false triggers compensation identically to any other ok:false', async () => {
      gateway.reserveForCart.mockResolvedValue({ ok: false, code: 'INVALID_INPUT', field: 'cartId', reason: 'malformed' });

      await convergence.convergeReservation('cart-1', 'product-1', 'user-1', 5, 2, compensationPlan);

      expect(cartRepository.compensateItemDeleteIfUnchanged).toHaveBeenCalled();
    });

    it('a thrown error triggers compensation identically to a typed ok:false', async () => {
      gateway.reserveForCart.mockRejectedValue(new Error('redis down'));

      await convergence.convergeReservation('cart-1', 'product-1', 'user-1', 5, 2, compensationPlan);

      expect(cartRepository.compensateItemDeleteIfUnchanged).toHaveBeenCalled();
    });

    it('passes customerId through to the gateway', async () => {
      gateway.reserveForCart.mockResolvedValue({ ok: true, mode: 'LEGACY', mirror: { status: 'NOT_ATTEMPTED' } });

      await convergence.convergeReservation('cart-1', 'product-1', 'customer-42', 5, 2, compensationPlan);

      expect(gateway.reserveForCart).toHaveBeenCalledWith('cart-1', 'product-1', 'customer-42', 2);
    });
  });

  describe('releaseForCart result shapes', () => {
    it('LEGACY ok:true resolves the marker', async () => {
      gateway.releaseForCart.mockResolvedValue({ ok: true, mode: 'LEGACY', mirror: { status: 'NOT_ATTEMPTED' } });

      await convergence.convergeReservation('cart-1', 'product-1', 'user-1', 5, null, compensationPlan);

      expect(syncState.resolveIfCurrentGeneration).toHaveBeenCalledWith('cart-1', 'product-1', 5);
    });

    it('DRAINING ok:true (cleanup stays allowed while draining) resolves the marker', async () => {
      gateway.releaseForCart.mockResolvedValue({ ok: true, mode: 'DRAINING', mirror: { status: 'NOT_ATTEMPTED' } });

      await convergence.convergeReservation('cart-1', 'product-1', 'user-1', 5, null, compensationPlan);

      expect(syncState.resolveIfCurrentGeneration).toHaveBeenCalledWith('cart-1', 'product-1', 5);
    });

    it('ok:false triggers compensation, never resolves', async () => {
      gateway.releaseForCart.mockResolvedValue({ ok: false, code: 'INVALID_INPUT', field: 'productId', reason: 'malformed' });

      await convergence.convergeReservation('cart-1', 'product-1', 'user-1', 5, null, compensationPlan);

      expect(cartRepository.compensateItemDeleteIfUnchanged).toHaveBeenCalled();
      expect(syncState.resolveIfCurrentGeneration).not.toHaveBeenCalled();
    });
  });
});
