import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ReservationEngineMode } from '@prisma/client';

import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CompensationService } from '../../mirror-compensation/services/compensation.service';
import { ReservationAvailabilityService } from '../../reservation-engine-mode/services/reservation-availability.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { CheckoutReservationModule } from '../checkout-reservation.module';
import { RESERVATION_GATEWAY, ReservationGateway } from '../types/reservation-gateway.types';
import { CheckoutReservationFacade } from './checkout-reservation-facade.service';

// Phase 16A.0-C, Unit C3. Non-MIRROR routing, validation, releaseCart,
// availability delegation, and module-boundary coverage. MIRROR-specific
// scenarios (legacy-first, typed failures, underflow, thrown exceptions,
// DA.4 divergence recording) live in
// checkout-reservation-facade-mirror.service.spec.ts - split purely to
// keep both files within the repository's 400-line file limit.

type MockModeService = jest.Mocked<Pick<ReservationEngineModeService, 'getCurrentMode'>>;
type MockInventoryReservations = jest.Mocked<
  Pick<
    InventoryReservationsService,
    'reserve' | 'release' | 'reserveOrRenew' | 'releaseReservation' | 'getActiveReservation'
  >
>;
type MockAvailability = jest.Mocked<Pick<ReservationAvailabilityService, 'getCartAdmissionAvailability'>>;
type MockCompensation = jest.Mocked<Pick<CompensationService, 'recordMirrorDivergence'>>;

describe('CheckoutReservationFacade', () => {
  let modeService: MockModeService;
  let inventoryReservations: MockInventoryReservations;
  let availability: MockAvailability;
  let compensation: MockCompensation;
  let facade: CheckoutReservationFacade;

  function setMode(mode: ReservationEngineMode): void {
    modeService.getCurrentMode.mockResolvedValue(mode);
  }

  beforeEach(() => {
    modeService = { getCurrentMode: jest.fn() };
    inventoryReservations = {
      reserve: jest.fn(),
      release: jest.fn(),
      reserveOrRenew: jest.fn(),
      releaseReservation: jest.fn(),
      getActiveReservation: jest.fn(),
    };
    availability = { getCartAdmissionAvailability: jest.fn() };
    compensation = { recordMirrorDivergence: jest.fn() };
    facade = new CheckoutReservationFacade(
      modeService as unknown as ReservationEngineModeService,
      inventoryReservations as unknown as InventoryReservationsService,
      availability as unknown as ReservationAvailabilityService,
      compensation as unknown as CompensationService,
    );
  });

  describe('input validation', () => {
    it('rejects a malformed cartId before reading mode', async () => {
      const result = await facade.reserveForCart('cart id', 'product-1', 'customer-1', 5);

      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'cartId',
        reason: 'cartId cannot contain whitespace',
      });
      expect(modeService.getCurrentMode).not.toHaveBeenCalled();
    });

    it('rejects a malformed productId for reserveForCart', async () => {
      const result = await facade.reserveForCart('cart-1', '', 'customer-1', 5);
      expect(result).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'productId', reason: 'productId cannot be empty' });
    });

    it('rejects a malformed customerId for reserveForCart', async () => {
      const result = await facade.reserveForCart('cart-1', 'product-1', '', 5);
      expect(result).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'customerId', reason: 'customerId cannot be empty' });
    });

    it('rejects a non-positive desiredQuantity', async () => {
      const result = await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 0);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'desiredQuantity',
        reason: 'desiredQuantity must be a positive integer',
      });
    });

    it('rejects a non-integer desiredQuantity', async () => {
      const result = await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 1.5);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'desiredQuantity',
        reason: 'desiredQuantity must be a positive integer',
      });
    });

    it('rejects a malformed cartId/productId for releaseForCart before reading mode', async () => {
      const result = await facade.releaseForCart('cart-1', 'bad{product}');
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'productId',
        reason: "productId cannot contain '{', '}', or ':'",
      });
      expect(modeService.getCurrentMode).not.toHaveBeenCalled();
    });

    it('rejects a malformed cartId for releaseForCart', async () => {
      const result = await facade.releaseForCart('cart id', 'product-1');
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'cartId',
        reason: 'cartId cannot contain whitespace',
      });
    });

    it('rejects a malformed cartId for releaseCart before checking productIds', async () => {
      const result = await facade.releaseCart('cart id', ['product-1']);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'cartId',
        reason: 'cartId cannot contain whitespace',
      });
      expect(modeService.getCurrentMode).not.toHaveBeenCalled();
    });

    it('rejects an empty productIds array for releaseCart', async () => {
      const result = await facade.releaseCart('cart-1', []);
      expect(result).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'productIds', reason: 'productIds cannot be empty' });
      expect(modeService.getCurrentMode).not.toHaveBeenCalled();
    });

    it('rejects a malformed productId inside releaseCart', async () => {
      const result = await facade.releaseCart('cart-1', ['product-1', 'bad id']);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'productIds',
        reason: 'productId cannot contain whitespace',
      });
    });
  });

  describe('argument-order regression', () => {
    it('LEGACY reserve calls InventoryReservationsService.reserve(productId, cartId, quantity)', async () => {
      setMode('LEGACY');
      await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);
      expect(inventoryReservations.reserve).toHaveBeenCalledWith('product-1', 'cart-1', 5);
    });

    it('CART_SCOPED reserve calls reserveOrRenew(cartId, productId, customerId, quantity)', async () => {
      setMode('CART_SCOPED');
      inventoryReservations.reserveOrRenew.mockResolvedValue({
        ok: true,
        result: { entry: {} as never, underflow: null },
      });
      await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);
      expect(inventoryReservations.reserveOrRenew).toHaveBeenCalledWith('cart-1', 'product-1', 'customer-1', 5);
    });
  });

  describe('LEGACY mode', () => {
    beforeEach(() => setMode('LEGACY'));

    it('reserve touches legacy only', async () => {
      const result = await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);
      expect(result).toEqual({ ok: true, mode: 'LEGACY', mirror: { status: 'NOT_ATTEMPTED' } });
      expect(inventoryReservations.reserveOrRenew).not.toHaveBeenCalled();
      expect(compensation.recordMirrorDivergence).not.toHaveBeenCalled();
    });

    it('release touches legacy only', async () => {
      const result = await facade.releaseForCart('cart-1', 'product-1');
      expect(result).toEqual({ ok: true, mode: 'LEGACY', mirror: { status: 'NOT_ATTEMPTED' } });
      expect(inventoryReservations.release).toHaveBeenCalledWith('product-1', 'cart-1');
      expect(inventoryReservations.releaseReservation).not.toHaveBeenCalled();
      expect(compensation.recordMirrorDivergence).not.toHaveBeenCalled();
    });
  });

  describe('CART_SCOPED mode', () => {
    beforeEach(() => setMode('CART_SCOPED'));

    it('reserve touches the new engine only', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({
        ok: true,
        result: { entry: {} as never, underflow: null },
      });

      const result = await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);

      expect(result).toEqual({ ok: true, mode: 'CART_SCOPED', mirror: { status: 'NOT_ATTEMPTED' } });
      expect(inventoryReservations.reserve).not.toHaveBeenCalled();
      expect(compensation.recordMirrorDivergence).not.toHaveBeenCalled();
    });

    it('maps a typed reserve failure directly', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });

      const result = await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);

      expect(result).toEqual({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });
      expect(compensation.recordMirrorDivergence).not.toHaveBeenCalled();
    });

    it('release touches the new engine only', async () => {
      inventoryReservations.releaseReservation.mockResolvedValue({ released: true, quantity: 5, underflow: null });

      const result = await facade.releaseForCart('cart-1', 'product-1');

      expect(result).toEqual({ ok: true, mode: 'CART_SCOPED', mirror: { status: 'NOT_ATTEMPTED' } });
      expect(inventoryReservations.release).not.toHaveBeenCalled();
    });
  });

  describe('DRAINING mode', () => {
    beforeEach(() => setMode('DRAINING'));

    it('reserve is rejected with zero inventory writes', async () => {
      const result = await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 5);

      expect(result).toEqual({ ok: false, mode: 'DRAINING', code: 'MODE_NOT_ADMITTING' });
      expect(inventoryReservations.reserve).not.toHaveBeenCalled();
      expect(inventoryReservations.reserveOrRenew).not.toHaveBeenCalled();
      expect(inventoryReservations.getActiveReservation).not.toHaveBeenCalled();
    });

    it('a desired-quantity decrease is still rejected, never inspecting current quantity', async () => {
      const result = await facade.reserveForCart('cart-1', 'product-1', 'customer-1', 1);

      expect(result).toEqual({ ok: false, mode: 'DRAINING', code: 'MODE_NOT_ADMITTING' });
      expect(inventoryReservations.getActiveReservation).not.toHaveBeenCalled();
    });

    it('release is allowed via the cart-scoped path', async () => {
      inventoryReservations.releaseReservation.mockResolvedValue({ released: true, quantity: 5, underflow: null });

      const result = await facade.releaseForCart('cart-1', 'product-1');

      expect(result).toEqual({ ok: true, mode: 'DRAINING', mirror: { status: 'NOT_ATTEMPTED' } });
      expect(inventoryReservations.releaseReservation).toHaveBeenCalledWith('cart-1', 'product-1');
      expect(inventoryReservations.release).not.toHaveBeenCalled();
    });
  });

  describe('releaseCart', () => {
    it('deduplicates and preserves first-seen order', async () => {
      setMode('LEGACY');
      inventoryReservations.release.mockResolvedValue(undefined);

      const result = await facade.releaseCart('cart-1', ['p2', 'p1', 'p2']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.items.map((item) => item.productId)).toEqual(['p2', 'p1']);
      }
      expect(inventoryReservations.release).toHaveBeenCalledTimes(2);
    });

    it('calls getCurrentMode exactly once regardless of item count', async () => {
      setMode('CART_SCOPED');
      inventoryReservations.releaseReservation.mockResolvedValue({ released: true, quantity: 1, underflow: null });

      await facade.releaseCart('cart-1', ['p1', 'p2', 'p3']);

      expect(modeService.getCurrentMode).toHaveBeenCalledTimes(1);
    });
  });

  describe('availability delegation', () => {
    it('returns the C2 result unchanged', async () => {
      const c2Result = { ok: true, mode: 'CART_SCOPED', source: 'CART_SCOPED', available: 7 } as const;
      availability.getCartAdmissionAvailability.mockResolvedValue(c2Result);

      const result = await facade.getCartAdmissionAvailability('product-1', 10, 'cart-1');

      expect(result).toEqual(c2Result);
      expect(availability.getCartAdmissionAvailability).toHaveBeenCalledWith('product-1', 10, 'cart-1');
    });
  });

  describe('module boundary', () => {
    it('has no dependency beyond the four expected services (constructor arity)', () => {
      expect(CheckoutReservationFacade.length).toBe(4);
    });

    it('CheckoutReservationModule exports exactly RESERVATION_GATEWAY', () => {
      const exportsMetadata = Reflect.getMetadata(MODULE_METADATA.EXPORTS, CheckoutReservationModule) as unknown[];
      expect(exportsMetadata).toEqual([RESERVATION_GATEWAY]);
    });

    it('RESERVATION_GATEWAY (useExisting) resolves to the same instance as the concrete facade', async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          { provide: ReservationEngineModeService, useValue: modeService },
          { provide: InventoryReservationsService, useValue: inventoryReservations },
          { provide: ReservationAvailabilityService, useValue: availability },
          { provide: CompensationService, useValue: compensation },
          CheckoutReservationFacade,
          { provide: RESERVATION_GATEWAY, useExisting: CheckoutReservationFacade },
        ],
      }).compile();

      const concrete = moduleRef.get(CheckoutReservationFacade);
      const viaToken = moduleRef.get<ReservationGateway>(RESERVATION_GATEWAY);

      expect(viaToken).toBe(concrete);
    });
  });
});
