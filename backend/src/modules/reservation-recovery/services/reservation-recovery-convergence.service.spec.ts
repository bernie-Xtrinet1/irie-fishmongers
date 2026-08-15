import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { ReservationEngineModeSnapshot } from '../../reservation-engine-mode/types/reservation-engine-mode.types';
import { ReservationRecoveryConvergenceService } from './reservation-recovery-convergence.service';

// Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen plan). Full mode x
// outcome grid for the recovery-authority write-routing/classification
// service, mocking InventoryReservationsService/ReservationEngineModeService
// entirely - real-Redis proof (including the mode-race scenarios) lives in
// the real Postgres+Redis integration suite.
describe('ReservationRecoveryConvergenceService', () => {
  let modeService: jest.Mocked<Pick<ReservationEngineModeService, 'getCurrentModeSnapshot'>>;
  let inventoryReservations: jest.Mocked<
    Pick<InventoryReservationsService, 'reserve' | 'release' | 'reserveOrRenew' | 'releaseReservation'>
  >;
  let service: ReservationRecoveryConvergenceService;

  function setSnapshot(snapshot: ReservationEngineModeSnapshot): void {
    modeService.getCurrentModeSnapshot.mockResolvedValue(snapshot);
  }

  beforeEach(() => {
    modeService = { getCurrentModeSnapshot: jest.fn() };
    inventoryReservations = {
      reserve: jest.fn(),
      release: jest.fn(),
      reserveOrRenew: jest.fn(),
      releaseReservation: jest.fn(),
    };
    service = new ReservationRecoveryConvergenceService(
      modeService as unknown as ReservationEngineModeService,
      inventoryReservations as unknown as InventoryReservationsService,
    );
  });

  describe('LEGACY', () => {
    const snapshot: ReservationEngineModeSnapshot = { mode: 'LEGACY', revisionId: 'r-1', revision: 1 };
    beforeEach(() => setSnapshot(snapshot));

    it('reserve-shaped converges via legacy reserve()', async () => {
      const result = await service.converge({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: 'customer-1',
        desiredQuantity: 5,
      });

      expect(result).toEqual({ outcome: 'CONVERGED', observedMode: snapshot });
      expect(inventoryReservations.reserve).toHaveBeenCalledWith('product-1', 'cart-1', 5);
      expect(inventoryReservations.reserveOrRenew).not.toHaveBeenCalled();
    });

    it('release-shaped converges via legacy release()', async () => {
      const result = await service.converge({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: null,
        desiredQuantity: null,
      });

      expect(result).toEqual({ outcome: 'CONVERGED', observedMode: snapshot });
      expect(inventoryReservations.release).toHaveBeenCalledWith('product-1', 'cart-1');
    });

    it('a thrown legacy write returns RETRY(UNKNOWN_INFRA_FAILURE)', async () => {
      inventoryReservations.reserve.mockRejectedValue(new Error('redis down'));

      const result = await service.converge({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: 'customer-1',
        desiredQuantity: 5,
      });

      expect(result).toEqual({
        outcome: 'RETRY',
        reasonCode: 'UNKNOWN_INFRA_FAILURE',
        lastError: 'redis down',
        observedMode: snapshot,
      });
    });
  });

  describe('MIRROR (targets legacy only - never the cart-scoped engine)', () => {
    const snapshot: ReservationEngineModeSnapshot = { mode: 'MIRROR', revisionId: 'r-2', revision: 2 };
    beforeEach(() => setSnapshot(snapshot));

    it('reserve-shaped converges via legacy reserve() only', async () => {
      const result = await service.converge({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: 'customer-1',
        desiredQuantity: 5,
      });

      expect(result).toEqual({ outcome: 'CONVERGED', observedMode: snapshot });
      expect(inventoryReservations.reserve).toHaveBeenCalledWith('product-1', 'cart-1', 5);
      expect(inventoryReservations.reserveOrRenew).not.toHaveBeenCalled();
    });

    it('release-shaped converges via legacy release() only', async () => {
      const result = await service.converge({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: null,
        desiredQuantity: null,
      });

      expect(result).toEqual({ outcome: 'CONVERGED', observedMode: snapshot });
      expect(inventoryReservations.release).toHaveBeenCalledWith('product-1', 'cart-1');
      expect(inventoryReservations.releaseReservation).not.toHaveBeenCalled();
    });
  });

  describe('CART_SCOPED', () => {
    const snapshot: ReservationEngineModeSnapshot = { mode: 'CART_SCOPED', revisionId: 'r-3', revision: 3 };
    beforeEach(() => setSnapshot(snapshot));

    it('reserve-shaped converges via reserveOrRenew()', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({
        ok: true,
        result: { entry: {} as never, underflow: null },
      });

      const result = await service.converge({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: 'customer-1',
        desiredQuantity: 5,
      });

      expect(result).toEqual({ outcome: 'CONVERGED', observedMode: snapshot });
      expect(inventoryReservations.reserveOrRenew).toHaveBeenCalledWith('cart-1', 'product-1', 'customer-1', 5);
      expect(inventoryReservations.reserve).not.toHaveBeenCalled();
    });

    it('reserve-shaped RESERVATION_PRODUCT_SUSPENDED returns BLOCKED(PRODUCT_SUSPECT)', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });

      const result = await service.converge({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: 'customer-1',
        desiredQuantity: 5,
      });

      expect(result).toEqual({ outcome: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT', observedMode: snapshot });
    });

    it('reserve-shaped RESERVATION_CHECKOUT_IN_PROGRESS returns RETRY(CHECKOUT_IN_PROGRESS), never BLOCKED', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({ ok: false, code: 'RESERVATION_CHECKOUT_IN_PROGRESS' });

      const result = await service.converge({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: 'customer-1',
        desiredQuantity: 5,
      });

      expect(result).toEqual({
        outcome: 'RETRY',
        reasonCode: 'CHECKOUT_IN_PROGRESS',
        lastError: null,
        observedMode: snapshot,
      });
    });

    it('reserve-shaped underflow returns BLOCKED(PRODUCT_SUSPECT), never CONVERGED', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({
        ok: true,
        result: {
          entry: {} as never,
          underflow: {
            productId: 'product-1',
            cartId: 'cart-1',
            reservationQuantity: 5,
            storedTotal: 2,
            operationName: 'reserveOrRenew',
            timestamp: Date.now(),
          },
        },
      });

      const result = await service.converge({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: 'customer-1',
        desiredQuantity: 5,
      });

      expect(result).toEqual({ outcome: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT', observedMode: snapshot });
    });

    it('a thrown reserve-shaped write returns RETRY(UNKNOWN_INFRA_FAILURE)', async () => {
      inventoryReservations.reserveOrRenew.mockRejectedValue(new Error('lua eval failed'));

      const result = await service.converge({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: 'customer-1',
        desiredQuantity: 5,
      });

      expect(result).toEqual({
        outcome: 'RETRY',
        reasonCode: 'UNKNOWN_INFRA_FAILURE',
        lastError: 'lua eval failed',
        observedMode: snapshot,
      });
    });

    it('a reserve-shaped target with a null customerId throws an invariant violation rather than silently proceeding', async () => {
      await expect(
        service.converge({ cartId: 'cart-1', productId: 'product-1', customerId: null, desiredQuantity: 5 }),
      ).rejects.toThrow('Invariant violation');
      expect(inventoryReservations.reserveOrRenew).not.toHaveBeenCalled();
    });

    it('release-shaped converges via releaseReservation()', async () => {
      inventoryReservations.releaseReservation.mockResolvedValue({ released: true, quantity: 5, underflow: null });

      const result = await service.converge({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: null,
        desiredQuantity: null,
      });

      expect(result).toEqual({ outcome: 'CONVERGED', observedMode: snapshot });
      expect(inventoryReservations.releaseReservation).toHaveBeenCalledWith('cart-1', 'product-1');
      expect(inventoryReservations.release).not.toHaveBeenCalled();
    });

    it('release-shaped underflow returns BLOCKED(PRODUCT_SUSPECT)', async () => {
      inventoryReservations.releaseReservation.mockResolvedValue({
        released: true,
        quantity: 5,
        underflow: {
          productId: 'product-1',
          cartId: 'cart-1',
          reservationQuantity: 5,
          storedTotal: 1,
          operationName: 'releaseReservation',
          timestamp: Date.now(),
        },
      });

      const result = await service.converge({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: null,
        desiredQuantity: null,
      });

      expect(result).toEqual({ outcome: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT', observedMode: snapshot });
    });

    it('a thrown release-shaped write returns RETRY(UNKNOWN_INFRA_FAILURE)', async () => {
      inventoryReservations.releaseReservation.mockRejectedValue(new Error('connection reset'));

      const result = await service.converge({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: null,
        desiredQuantity: null,
      });

      expect(result).toEqual({
        outcome: 'RETRY',
        reasonCode: 'UNKNOWN_INFRA_FAILURE',
        lastError: 'connection reset',
        observedMode: snapshot,
      });
    });
  });

  describe('DRAINING', () => {
    const snapshot: ReservationEngineModeSnapshot = { mode: 'DRAINING', revisionId: 'r-4', revision: 4 };
    beforeEach(() => setSnapshot(snapshot));

    it('release-shaped is always allowed, converging via releaseReservation()', async () => {
      inventoryReservations.releaseReservation.mockResolvedValue({ released: true, quantity: 5, underflow: null });

      const result = await service.converge({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: null,
        desiredQuantity: null,
      });

      expect(result).toEqual({ outcome: 'CONVERGED', observedMode: snapshot });
      expect(inventoryReservations.releaseReservation).toHaveBeenCalledWith('cart-1', 'product-1');
    });

    it('reserve-shaped is BLOCKED(MODE_NOT_ADMITTING), with zero writes attempted', async () => {
      const result = await service.converge({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: 'customer-1',
        desiredQuantity: 5,
      });

      expect(result).toEqual({ outcome: 'BLOCKED', blockReason: 'MODE_NOT_ADMITTING', observedMode: snapshot });
      expect(inventoryReservations.reserveOrRenew).not.toHaveBeenCalled();
      expect(inventoryReservations.reserve).not.toHaveBeenCalled();
    });
  });

  it('calls getCurrentModeSnapshot exactly once per converge() call', async () => {
    setSnapshot({ mode: 'LEGACY', revisionId: null, revision: null });

    await service.converge({ cartId: 'cart-1', productId: 'product-1', customerId: null, desiredQuantity: null });

    expect(modeService.getCurrentModeSnapshot).toHaveBeenCalledTimes(1);
  });
});
