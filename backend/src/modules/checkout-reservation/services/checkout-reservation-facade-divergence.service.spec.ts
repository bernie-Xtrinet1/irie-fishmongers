import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CompensationService } from '../../mirror-compensation/services/compensation.service';
import { ReservationAvailabilityService } from '../../reservation-engine-mode/services/reservation-availability.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { CheckoutReservationFacade } from './checkout-reservation-facade.service';

// Phase 16A.0-DA, Unit DA.4 (see the DA.4 frozen plan). Proves
// CheckoutReservationFacade's own new responsibility: persisting a FAILED
// MirrorDiagnostic via CompensationService.recordMirrorDivergence.
// MIRROR-mode routing/diagnostic-computation itself is already proven by
// checkout-reservation-facade-mirror.service.spec.ts - this file exists
// purely for the recordMirrorDivergence call contract (inputs, and the
// non-blocking-persistence-failure guarantee), split out to keep every
// file within the repository's 400-line limit.

type MockModeService = jest.Mocked<Pick<ReservationEngineModeService, 'getCurrentMode'>>;
type MockInventoryReservations = jest.Mocked<
  Pick<InventoryReservationsService, 'reserve' | 'release' | 'reserveOrRenew' | 'releaseReservation'>
>;
type MockAvailability = jest.Mocked<Pick<ReservationAvailabilityService, 'getCartAdmissionAvailability'>>;
type MockCompensation = jest.Mocked<Pick<CompensationService, 'recordMirrorDivergence'>>;

describe('CheckoutReservationFacade (DA.4 mirror-divergence recording)', () => {
  let modeService: MockModeService;
  let inventoryReservations: MockInventoryReservations;
  let compensation: MockCompensation;
  let facade: CheckoutReservationFacade;

  beforeEach(() => {
    modeService = { getCurrentMode: jest.fn().mockResolvedValue('MIRROR') };
    inventoryReservations = {
      reserve: jest.fn(),
      release: jest.fn(),
      reserveOrRenew: jest.fn(),
      releaseReservation: jest.fn(),
    };
    const availability: MockAvailability = { getCartAdmissionAvailability: jest.fn() };
    compensation = {
      recordMirrorDivergence: jest.fn().mockResolvedValue({ ok: true, outcome: 'CREATED', compensationId: 'comp-1' }),
    };
    facade = new CheckoutReservationFacade(
      modeService as unknown as ReservationEngineModeService,
      inventoryReservations as unknown as InventoryReservationsService,
      availability as unknown as ReservationAvailabilityService,
      compensation as unknown as CompensationService,
    );
  });

  describe('reserve', () => {
    it('SYNCED never records a divergence', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({
        ok: true,
        result: { entry: {} as never, underflow: null },
      });

      await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);

      expect(compensation.recordMirrorDivergence).not.toHaveBeenCalled();
    });

    it('PRODUCT_SUSPENDED records RESERVE_MIRROR with the original desiredQuantity and no lastError', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });

      await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);

      expect(compensation.recordMirrorDivergence).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'RESERVE_MIRROR',
          cartId: 'cart-1',
          productId: 'product-1',
          customerId: 'customer-1',
          desiredQuantity: 5,
          reasonCode: 'PRODUCT_SUSPENDED',
          lastError: null,
        }),
      );
    });

    it('CHECKOUT_IN_PROGRESS records the matching reasonCode', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({ ok: false, code: 'RESERVATION_CHECKOUT_IN_PROGRESS' });

      await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);

      expect(compensation.recordMirrorDivergence).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'RESERVE_MIRROR', reasonCode: 'CHECKOUT_IN_PROGRESS' }),
      );
    });

    it('ACCOUNTING_UNDERFLOW records the matching reasonCode', async () => {
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

      await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);

      expect(compensation.recordMirrorDivergence).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'RESERVE_MIRROR', reasonCode: 'ACCOUNTING_UNDERFLOW' }),
      );
    });

    it('a thrown mirror exception records UNKNOWN_INFRA_FAILURE with the real (unsanitized) error message', async () => {
      inventoryReservations.reserveOrRenew.mockRejectedValue(new Error('redis eval failed: ETIMEDOUT'));

      await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);

      expect(compensation.recordMirrorDivergence).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'RESERVE_MIRROR',
          reasonCode: 'UNKNOWN_INFRA_FAILURE',
          lastError: 'redis eval failed: ETIMEDOUT',
        }),
      );
    });

    it('a non-Error thrown value still records a stringified lastError', async () => {
      inventoryReservations.reserveOrRenew.mockRejectedValue('raw string rejection');

      await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);

      expect(compensation.recordMirrorDivergence).toHaveBeenCalledWith(
        expect.objectContaining({ reasonCode: 'UNKNOWN_INFRA_FAILURE', lastError: 'raw string rejection' }),
      );
    });
  });

  describe('release', () => {
    it('SYNCED never records a divergence', async () => {
      inventoryReservations.releaseReservation.mockResolvedValue({ released: true, quantity: 5, underflow: null });

      await facade.releaseForCart('cart-1', 'product-1');

      expect(compensation.recordMirrorDivergence).not.toHaveBeenCalled();
    });

    it('ACCOUNTING_UNDERFLOW records RELEASE_MIRROR with null customerId/desiredQuantity', async () => {
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

      await facade.releaseForCart('cart-1', 'product-1');

      expect(compensation.recordMirrorDivergence).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'RELEASE_MIRROR',
          cartId: 'cart-1',
          productId: 'product-1',
          customerId: null,
          desiredQuantity: null,
          reasonCode: 'ACCOUNTING_UNDERFLOW',
        }),
      );
    });

    it('a thrown mirror exception records UNKNOWN_INFRA_FAILURE with the real error message', async () => {
      inventoryReservations.releaseReservation.mockRejectedValue(new Error('connection reset'));

      await facade.releaseForCart('cart-1', 'product-1');

      expect(compensation.recordMirrorDivergence).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'RELEASE_MIRROR',
          reasonCode: 'UNKNOWN_INFRA_FAILURE',
          lastError: 'connection reset',
        }),
      );
    });
  });

  describe('non-blocking persistence failure', () => {
    it('recordMirrorDivergence throwing still yields a successful customer result, logged at ERROR', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });
      compensation.recordMirrorDivergence.mockRejectedValue(new Error('P2028: transaction timeout'));
      const errorSpy = jest.spyOn(facade['logger'], 'error');

      const result = await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);

      expect(result).toEqual({
        ok: true,
        mode: 'MIRROR',
        mirror: { status: 'FAILED', operation: 'RESERVE', reasonCode: 'PRODUCT_SUSPENDED' },
      });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('repair record lost'),
        expect.objectContaining({ cartId: 'cart-1', productId: 'product-1' }),
      );
    });

    it('recordMirrorDivergence throwing never exposes a raw error to the customer-facing result', async () => {
      inventoryReservations.releaseReservation.mockRejectedValue(new Error('sensitive redis stack trace'));
      compensation.recordMirrorDivergence.mockRejectedValue(new Error('sensitive prisma internal detail'));

      const result = await facade.releaseForCart('cart-1', 'product-1');

      expect(JSON.stringify(result)).not.toContain('sensitive');
    });

    it('recordMirrorDivergence returning ok:false (INVALID_INPUT) still yields a successful customer result, logged at ERROR', async () => {
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
      compensation.recordMirrorDivergence.mockResolvedValue({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'cartId',
        reason: 'unexpected',
      });
      const errorSpy = jest.spyOn(facade['logger'], 'error');

      const result = await facade.releaseForCart('cart-1', 'product-1');

      expect(result).toEqual({
        ok: true,
        mode: 'MIRROR',
        mirror: { status: 'FAILED', operation: 'RELEASE', reasonCode: 'ACCOUNTING_UNDERFLOW' },
      });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('repair record lost'),
        expect.objectContaining({ field: 'cartId', reason: 'unexpected' }),
      );
    });
  });

  describe('non-MIRROR modes never touch CompensationService', () => {
    it('LEGACY', async () => {
      modeService.getCurrentMode.mockResolvedValue('LEGACY');
      await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);
      await facade.releaseForCart('cart-1', 'product-1');
      expect(compensation.recordMirrorDivergence).not.toHaveBeenCalled();
    });

    it('CART_SCOPED', async () => {
      modeService.getCurrentMode.mockResolvedValue('CART_SCOPED');
      inventoryReservations.reserveOrRenew.mockResolvedValue({
        ok: true,
        result: { entry: {} as never, underflow: null },
      });
      inventoryReservations.releaseReservation.mockResolvedValue({ released: true, quantity: 5, underflow: null });
      await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);
      await facade.releaseForCart('cart-1', 'product-1');
      expect(compensation.recordMirrorDivergence).not.toHaveBeenCalled();
    });

    it('DRAINING', async () => {
      modeService.getCurrentMode.mockResolvedValue('DRAINING');
      inventoryReservations.releaseReservation.mockResolvedValue({ released: true, quantity: 5, underflow: null });
      await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);
      await facade.releaseForCart('cart-1', 'product-1');
      expect(compensation.recordMirrorDivergence).not.toHaveBeenCalled();
    });
  });
});
