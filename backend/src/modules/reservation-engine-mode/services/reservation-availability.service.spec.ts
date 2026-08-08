import { ReservationEngineMode } from '@prisma/client';

import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ReservationEngineModeService } from './reservation-engine-mode.service';
import { ReservationAvailabilityService } from './reservation-availability.service';

// Phase 16A.0-C, Unit C2. Mocks both collaborators - this suite verifies
// ReservationAvailabilityService's own routing/validation logic only. Real
// Redis arithmetic is covered by reservation-availability.redis.integration.spec.ts.

type MockInventoryReservations = jest.Mocked<
  Pick<
    InventoryReservationsService,
    | 'getReservedByOthers'
    | 'getAvailabilityWithSuspectStatus'
    | 'reserveOrRenew'
    | 'releaseReservation'
    | 'reserve'
    | 'release'
  >
>;

function throwingWriteMethod(name: string) {
  return jest.fn().mockRejectedValue(new Error(`${name} must not be called by ReservationAvailabilityService`));
}

describe('ReservationAvailabilityService', () => {
  let modeService: jest.Mocked<Pick<ReservationEngineModeService, 'getCurrentMode'>>;
  let inventoryReservations: MockInventoryReservations;
  let service: ReservationAvailabilityService;

  function setMode(mode: ReservationEngineMode): void {
    modeService.getCurrentMode.mockResolvedValue(mode);
  }

  beforeEach(() => {
    modeService = { getCurrentMode: jest.fn() };
    inventoryReservations = {
      getReservedByOthers: jest.fn(),
      getAvailabilityWithSuspectStatus: jest.fn(),
      reserveOrRenew: throwingWriteMethod('reserveOrRenew'),
      releaseReservation: throwingWriteMethod('releaseReservation'),
      reserve: throwingWriteMethod('reserve'),
      release: throwingWriteMethod('release'),
    };
    service = new ReservationAvailabilityService(
      modeService as unknown as ReservationEngineModeService,
      inventoryReservations as unknown as InventoryReservationsService,
    );
  });

  describe('input validation', () => {
    it('rejects an empty productId with INVALID_INPUT', async () => {
      const result = await service.getGeneralAvailability('', 10);

      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'productId',
        reason: 'productId cannot be empty',
      });
      expect(modeService.getCurrentMode).not.toHaveBeenCalled();
    });

    it('rejects a malformed cartId with INVALID_INPUT', async () => {
      const result = await service.getCartAdmissionAvailability('product-1', 10, 'cart id with spaces');

      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'cartId',
        reason: 'cartId cannot contain whitespace',
      });
    });

    it('rejects a negative quantityAvailable with INVALID_INPUT', async () => {
      const result = await service.getGeneralAvailability('product-1', -1);

      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'quantityAvailable',
        reason: 'quantityAvailable must be a non-negative integer',
      });
    });

    it('rejects a non-integer quantityAvailable with INVALID_INPUT', async () => {
      const result = await service.getGeneralAvailability('product-1', 1.5);

      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'quantityAvailable',
        reason: 'quantityAvailable must be a non-negative integer',
      });
    });
  });

  describe('LEGACY mode', () => {
    beforeEach(() => setMode('LEGACY'));

    it('computes available from legacy reservations only', async () => {
      inventoryReservations.getReservedByOthers.mockResolvedValue(3);

      const result = await service.getGeneralAvailability('product-1', 10);

      expect(result).toEqual({ ok: true, mode: 'LEGACY', source: 'LEGACY', available: 7 });
      expect(inventoryReservations.getAvailabilityWithSuspectStatus).not.toHaveBeenCalled();
    });

    it('floors at zero when oversubscribed', async () => {
      inventoryReservations.getReservedByOthers.mockResolvedValue(20);

      const result = await service.getGeneralAvailability('product-1', 10);

      expect(result).toEqual({ ok: true, mode: 'LEGACY', source: 'LEGACY', available: 0 });
    });

    it('passes the requesting cartId through for own-cart exclusion', async () => {
      inventoryReservations.getReservedByOthers.mockResolvedValue(4);

      await service.getCartAdmissionAvailability('product-1', 10, 'cart-mine');

      expect(inventoryReservations.getReservedByOthers).toHaveBeenCalledWith('product-1', 'cart-mine');
    });

    it('passes an empty string internally for general (no-cart) availability', async () => {
      inventoryReservations.getReservedByOthers.mockResolvedValue(4);

      await service.getGeneralAvailability('product-1', 10);

      expect(inventoryReservations.getReservedByOthers).toHaveBeenCalledWith('product-1', '');
    });
  });

  describe('MIRROR mode', () => {
    beforeEach(() => setMode('MIRROR'));

    it('customer-facing available always comes from legacy, never the new engine', async () => {
      inventoryReservations.getReservedByOthers.mockResolvedValue(3);
      inventoryReservations.getAvailabilityWithSuspectStatus.mockResolvedValue({
        status: 'OK',
        available: 999,
      });

      const result = await service.getGeneralAvailability('product-1', 10);

      expect(result.ok).toBe(true);
      if (result.ok && result.mode === 'MIRROR') {
        expect(result.available).toBe(7);
      }
    });

    it('reports mirrorComparison AVAILABLE when the new engine is OK', async () => {
      inventoryReservations.getReservedByOthers.mockResolvedValue(3);
      inventoryReservations.getAvailabilityWithSuspectStatus.mockResolvedValue({
        status: 'OK',
        available: 5,
      });

      const result = await service.getGeneralAvailability('product-1', 10);

      expect(result.ok).toBe(true);
      if (result.ok && result.mode === 'MIRROR') {
        expect(result.mirrorComparison).toEqual({ status: 'AVAILABLE', available: 5 });
      }
    });

    it('reports mirrorComparison STRUCTURE_DRIFT_CONFIRMED when the suspect flag is set', async () => {
      inventoryReservations.getReservedByOthers.mockResolvedValue(3);
      inventoryReservations.getAvailabilityWithSuspectStatus.mockResolvedValue({ status: 'SUSPECT' });

      const result = await service.getGeneralAvailability('product-1', 10);

      expect(result.ok).toBe(true);
      if (result.ok && result.mode === 'MIRROR') {
        expect(result.mirrorComparison).toEqual({ status: 'STRUCTURE_DRIFT_CONFIRMED' });
      }
    });

    it('reports mirrorComparison COMPARISON_UNAVAILABLE when the comparison read throws, never STRUCTURE_DRIFT_CONFIRMED', async () => {
      inventoryReservations.getReservedByOthers.mockResolvedValue(3);
      inventoryReservations.getAvailabilityWithSuspectStatus.mockRejectedValue(new Error('redis timeout'));

      const result = await service.getGeneralAvailability('product-1', 10);

      expect(result.ok).toBe(true);
      if (result.ok && result.mode === 'MIRROR') {
        expect(result.mirrorComparison).toEqual({ status: 'COMPARISON_UNAVAILABLE' });
      }
    });

    it('produces the same customer-facing available for identical legacy input regardless of mirrorComparison outcome', async () => {
      inventoryReservations.getReservedByOthers.mockResolvedValue(3);

      inventoryReservations.getAvailabilityWithSuspectStatus.mockResolvedValueOnce({
        status: 'OK',
        available: 5,
      });
      const availableResult = await service.getGeneralAvailability('product-1', 10);

      inventoryReservations.getAvailabilityWithSuspectStatus.mockResolvedValueOnce({ status: 'SUSPECT' });
      const suspectResult = await service.getGeneralAvailability('product-1', 10);

      inventoryReservations.getAvailabilityWithSuspectStatus.mockRejectedValueOnce(new Error('boom'));
      const unavailableResult = await service.getGeneralAvailability('product-1', 10);

      const extractAvailable = (result: Awaited<ReturnType<typeof service.getGeneralAvailability>>) =>
        result.ok && result.mode === 'MIRROR' ? result.available : undefined;

      expect(extractAvailable(availableResult)).toBe(7);
      expect(extractAvailable(suspectResult)).toBe(7);
      expect(extractAvailable(unavailableResult)).toBe(7);
    });
  });

  describe('CART_SCOPED mode', () => {
    beforeEach(() => setMode('CART_SCOPED'));

    it('returns new-engine availability and never reads legacy', async () => {
      inventoryReservations.getAvailabilityWithSuspectStatus.mockResolvedValue({
        status: 'OK',
        available: 6,
      });

      const result = await service.getGeneralAvailability('product-1', 10);

      expect(result).toEqual({ ok: true, mode: 'CART_SCOPED', source: 'CART_SCOPED', available: 6 });
      expect(inventoryReservations.getReservedByOthers).not.toHaveBeenCalled();
    });

    it('fails closed with RESERVATION_STRUCTURE_DRIFT when suspect, never a bare available:0', async () => {
      inventoryReservations.getAvailabilityWithSuspectStatus.mockResolvedValue({ status: 'SUSPECT' });

      const result = await service.getGeneralAvailability('product-1', 10);

      expect(result).toEqual({ ok: false, code: 'RESERVATION_STRUCTURE_DRIFT' });
    });

    it('passes the requesting cartId through for own-cart exclusion', async () => {
      inventoryReservations.getAvailabilityWithSuspectStatus.mockResolvedValue({
        status: 'OK',
        available: 6,
      });

      await service.getCartAdmissionAvailability('product-1', 10, 'cart-mine');

      expect(inventoryReservations.getAvailabilityWithSuspectStatus).toHaveBeenCalledWith(
        'product-1',
        10,
        'cart-mine',
      );
    });
  });

  describe('DRAINING mode', () => {
    beforeEach(() => setMode('DRAINING'));

    it('returns MODE_NOT_ADMITTING without ever reading InventoryReservationsService', async () => {
      const result = await service.getGeneralAvailability('product-1', 10);

      expect(result).toEqual({ ok: false, mode: 'DRAINING', code: 'MODE_NOT_ADMITTING' });
      expect(inventoryReservations.getReservedByOthers).not.toHaveBeenCalled();
      expect(inventoryReservations.getAvailabilityWithSuspectStatus).not.toHaveBeenCalled();
    });

    it('short-circuits for cart-admission availability the same way', async () => {
      const result = await service.getCartAdmissionAvailability('product-1', 10, 'cart-mine');

      expect(result).toEqual({ ok: false, mode: 'DRAINING', code: 'MODE_NOT_ADMITTING' });
      expect(inventoryReservations.getReservedByOthers).not.toHaveBeenCalled();
      expect(inventoryReservations.getAvailabilityWithSuspectStatus).not.toHaveBeenCalled();
    });
  });

  describe('read-only guarantee', () => {
    it('never invokes any reservation write method across any mode', async () => {
      inventoryReservations.getReservedByOthers.mockResolvedValue(0);
      inventoryReservations.getAvailabilityWithSuspectStatus.mockResolvedValue({
        status: 'OK',
        available: 0,
      });

      for (const mode of ['LEGACY', 'MIRROR', 'CART_SCOPED', 'DRAINING'] as ReservationEngineMode[]) {
        setMode(mode);
        await service.getGeneralAvailability('product-1', 10);
        await service.getCartAdmissionAvailability('product-1', 10, 'cart-mine');
      }

      expect(inventoryReservations.reserveOrRenew).not.toHaveBeenCalled();
      expect(inventoryReservations.releaseReservation).not.toHaveBeenCalled();
      expect(inventoryReservations.reserve).not.toHaveBeenCalled();
      expect(inventoryReservations.release).not.toHaveBeenCalled();
    });
  });
});
