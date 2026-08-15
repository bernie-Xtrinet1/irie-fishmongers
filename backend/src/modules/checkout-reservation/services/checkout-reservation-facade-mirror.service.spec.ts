import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CompensationService } from '../../mirror-compensation/services/compensation.service';
import { ReservationAvailabilityService } from '../../reservation-engine-mode/services/reservation-availability.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { CheckoutReservationFacade } from './checkout-reservation-facade.service';

// Phase 16A.0-C, Unit C3. MIRROR-specific reserve/release scenarios only -
// non-MIRROR routing, validation, releaseCart, availability delegation, and
// module-boundary coverage live in checkout-reservation-facade.service.spec.ts.
// Split purely to keep both files within the repository's 400-line limit.
// Phase 16A.0-DA, Unit DA.4 divergence-recording scenarios live in the
// sibling checkout-reservation-facade-divergence.service.spec.ts, split for
// the same reason.

type MockModeService = jest.Mocked<Pick<ReservationEngineModeService, 'getCurrentMode'>>;
type MockInventoryReservations = jest.Mocked<
  Pick<InventoryReservationsService, 'reserve' | 'release' | 'reserveOrRenew' | 'releaseReservation'>
>;
type MockAvailability = jest.Mocked<Pick<ReservationAvailabilityService, 'getCartAdmissionAvailability'>>;
type MockCompensation = jest.Mocked<Pick<CompensationService, 'recordMirrorDivergence'>>;

describe('CheckoutReservationFacade (MIRROR mode)', () => {
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
    compensation = { recordMirrorDivergence: jest.fn().mockResolvedValue({ ok: true, outcome: 'CREATED', compensationId: 'comp-1' }) };
    facade = new CheckoutReservationFacade(
      modeService as unknown as ReservationEngineModeService,
      inventoryReservations as unknown as InventoryReservationsService,
      availability as unknown as ReservationAvailabilityService,
      compensation as unknown as CompensationService,
    );
  });

  describe('reserve', () => {
    it('writes legacy first, then attempts the cart-scoped mirror write', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({
        ok: true,
        result: { entry: {} as never, underflow: null },
      });

      await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);

      const legacyOrder = inventoryReservations.reserve.mock.invocationCallOrder[0]!;
      const mirrorOrder = inventoryReservations.reserveOrRenew.mock.invocationCallOrder[0]!;
      expect(legacyOrder).toBeLessThan(mirrorOrder);
    });

    it('never attempts the mirror write when the legacy write throws', async () => {
      inventoryReservations.reserve.mockRejectedValue(new Error('redis down'));

      await expect(facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5)).rejects.toThrow('redis down');

      expect(inventoryReservations.reserveOrRenew).not.toHaveBeenCalled();
    });

    it('PRODUCT_SUSPENDED: customer success + FAILED diagnostic', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });

      const result = await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);

      expect(result).toEqual({
        ok: true,
        mode: 'MIRROR',
        mirror: { status: 'FAILED', operation: 'RESERVE', reasonCode: 'PRODUCT_SUSPENDED' },
      });
    });

    it('CHECKOUT_IN_PROGRESS: customer success + FAILED diagnostic', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({ ok: false, code: 'RESERVATION_CHECKOUT_IN_PROGRESS' });

      const result = await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);

      expect(result).toEqual({
        ok: true,
        mode: 'MIRROR',
        mirror: { status: 'FAILED', operation: 'RESERVE', reasonCode: 'CHECKOUT_IN_PROGRESS' },
      });
    });

    it('underflow: customer success + ACCOUNTING_UNDERFLOW, never SYNCED', async () => {
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

      const result = await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);

      expect(result).toEqual({
        ok: true,
        mode: 'MIRROR',
        mirror: { status: 'FAILED', operation: 'RESERVE', reasonCode: 'ACCOUNTING_UNDERFLOW' },
      });
    });

    it('thrown mirror exception: UNKNOWN_INFRA_FAILURE + customer success, no raw error exposed', async () => {
      inventoryReservations.reserveOrRenew.mockRejectedValue(new Error('sensitive stack trace'));

      const result = await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);

      expect(result).toEqual({
        ok: true,
        mode: 'MIRROR',
        mirror: { status: 'FAILED', operation: 'RESERVE', reasonCode: 'UNKNOWN_INFRA_FAILURE' },
      });
      expect(JSON.stringify(result)).not.toContain('sensitive stack trace');
    });
  });

  describe('release', () => {
    it('SYNCED when both engines succeed with no underflow', async () => {
      inventoryReservations.releaseReservation.mockResolvedValue({ released: true, quantity: 5, underflow: null });

      const result = await facade.releaseForCart('cart-1', 'product-1');

      expect(result).toEqual({ ok: true, mode: 'MIRROR', mirror: { status: 'SYNCED' } });
      expect(inventoryReservations.release).toHaveBeenCalledWith('product-1', 'cart-1');
    });

    it('underflow: ACCOUNTING_UNDERFLOW, customer success', async () => {
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

      const result = await facade.releaseForCart('cart-1', 'product-1');

      expect(result).toEqual({
        ok: true,
        mode: 'MIRROR',
        mirror: { status: 'FAILED', operation: 'RELEASE', reasonCode: 'ACCOUNTING_UNDERFLOW' },
      });
    });

    it('thrown mirror exception: UNKNOWN_INFRA_FAILURE, customer success', async () => {
      inventoryReservations.releaseReservation.mockRejectedValue(new Error('boom'));

      const result = await facade.releaseForCart('cart-1', 'product-1');

      expect(result).toEqual({
        ok: true,
        mode: 'MIRROR',
        mirror: { status: 'FAILED', operation: 'RELEASE', reasonCode: 'UNKNOWN_INFRA_FAILURE' },
      });
    });
  });
});
