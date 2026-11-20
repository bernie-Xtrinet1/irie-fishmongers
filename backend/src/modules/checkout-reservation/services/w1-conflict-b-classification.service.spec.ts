import { CompensationBlockReason, CompensationReasonCode } from '@prisma/client';
import { CheckoutReservationFacade } from './checkout-reservation-facade.service';
import { ReserveOrRenewOutcome } from '../../inventory/services/inventory-reservations.service';
import { CompensationReconciliationService } from '../../mirror-compensation/services/compensation-reconciliation.service';
import { ReservationRecoveryConvergenceService } from '../../reservation-recovery/services/reservation-recovery-convergence.service';

const IDS = {
  cart: '11111111-1111-4111-8111-111111111111',
  product: '22222222-2222-4222-8222-222222222222',
  customer: '33333333-3333-4333-8333-333333333333',
  comp: '44444444-4444-4444-8444-444444444444',
};

describe('Conflict B W1 accounting & integrity error classification (unit)', () => {
  describe('CheckoutReservationFacade classification & passthrough', () => {
    function makeFacade(mode: 'CART_SCOPED' | 'MIRROR') {
      const modeService = { getCurrentMode: jest.fn().mockResolvedValue(mode) };
      const inventoryReservations = {
        reserve: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        reserveOrRenew: jest.fn(),
        releaseReservation: jest.fn(),
      };
      const availability = { reserve: jest.fn(), release: jest.fn() };
      const compensation = { recordMirrorDivergence: jest.fn().mockResolvedValue({ ok: true }) };
      const facade = new CheckoutReservationFacade(
        modeService as never,
        inventoryReservations as never,
        availability as never,
        compensation as never,
      );
      return { facade, inventoryReservations, availability, compensation };
    }

    it('passes all Conflict B ReserveOrRenew failure codes through losslessly in CART_SCOPED', async () => {
      const { facade, inventoryReservations, compensation } = makeFacade('CART_SCOPED');
      const codes: Array<Exclude<ReserveOrRenewOutcome, { ok: true }>['code']> = [
        'RESERVATION_PRODUCT_SUSPENDED',
        'RESERVATION_CHECKOUT_IN_PROGRESS',
        'RESERVATION_ACCOUNTING_UNDERFLOW',
        'RESERVATION_ACCOUNTING_CORRUPTION',
        'RESERVATION_MALFORMED_RESOURCE',
        'RESERVATION_RESOURCE_GENERATION_MISMATCH',
        'FENCE_REJECTED',
        'UNCERTAIN_INFRASTRUCTURE',
      ];
      for (const code of codes) {
        inventoryReservations.reserveOrRenew.mockResolvedValueOnce({ ok: false, code });
        expect(await facade.reserveForCart(IDS.cart, IDS.product, IDS.customer, 2)).toEqual({ ok: false, code });
      }
      expect(compensation.recordMirrorDivergence).not.toHaveBeenCalled();
    });

    it.each<[Exclude<ReserveOrRenewOutcome, { ok: true }>['code'], CompensationReasonCode, string | null]>([
      ['RESERVATION_PRODUCT_SUSPENDED', 'PRODUCT_SUSPENDED', null],
      ['RESERVATION_CHECKOUT_IN_PROGRESS', 'CHECKOUT_IN_PROGRESS', null],
      ['RESERVATION_ACCOUNTING_UNDERFLOW', 'ACCOUNTING_UNDERFLOW', null],
      ['RESERVATION_ACCOUNTING_CORRUPTION', 'ACCOUNTING_UNDERFLOW', 'RESERVATION_ACCOUNTING_CORRUPTION'],
      ['RESERVATION_MALFORMED_RESOURCE', 'ACCOUNTING_UNDERFLOW', 'RESERVATION_MALFORMED_RESOURCE'],
      ['RESERVATION_RESOURCE_GENERATION_MISMATCH', 'UNKNOWN_INFRA_FAILURE', 'RESERVATION_RESOURCE_GENERATION_MISMATCH'],
      ['FENCE_REJECTED', 'UNKNOWN_INFRA_FAILURE', 'FENCE_REJECTED'],
      ['UNCERTAIN_INFRASTRUCTURE', 'UNKNOWN_INFRA_FAILURE', 'UNCERTAIN_INFRASTRUCTURE'],
    ])(
      'maps MIRROR failure %s -> %s (lastError=%s) while keeping legacy primary authoritative',
      async (code, expectedReason, expectedLastError) => {
        const { facade, inventoryReservations, compensation } = makeFacade('MIRROR');
        inventoryReservations.reserveOrRenew.mockResolvedValueOnce({ ok: false, code });

        const result = await facade.reserveForCart(IDS.cart, IDS.product, IDS.customer, 3);
        expect(result).toEqual({
          ok: true,
          mode: 'MIRROR',
          mirror: { status: 'FAILED', operation: 'RESERVE', reasonCode: expectedReason },
        });
        expect(compensation.recordMirrorDivergence).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: 'RESERVE_MIRROR',
            reasonCode: expectedReason,
            lastError: expectedLastError,
          }),
        );
      },
    );
  });

  describe('CompensationReconciliationService classification & retry discipline', () => {
    function makeReconciler(attemptCount = 4) {
      const row = {
        id: IDS.comp,
        cartId: IDS.cart,
        productId: IDS.product,
        customerId: IDS.customer,
        generation: 7,
        attemptCount,
        reasonCode: 'UNKNOWN_INFRA_FAILURE',
        status: 'IN_PROGRESS',
      };
      const repository = {
        claimForRecoveryAttempt: jest.fn().mockResolvedValue({ count: 1 }),
        findById: jest.fn().mockResolvedValue(row),
        blockIfGenerationMatches: jest.fn().mockResolvedValue({ count: 1 }),
        requeueAfterAttemptIfGenerationMatches: jest.fn().mockResolvedValue({ count: 1 }),
        markPermanentFailureIfGenerationMatches: jest.fn().mockResolvedValue({ count: 1 }),
        resolveIfGenerationMatches: jest.fn().mockResolvedValue({ count: 1 }),
        releaseStaleClaim: jest.fn().mockResolvedValue({ count: 1 }),
      };
      const cartRepository = {
        findById: jest.fn().mockResolvedValue({ id: IDS.cart, userId: IDS.customer }),
        findItemByCartAndProduct: jest.fn().mockResolvedValue({ quantity: 2 }),
      };
      const inventoryReservations = {
        reserve: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        reserveOrRenew: jest.fn(),
        releaseReservation: jest.fn(),
      };
      const modeService = { getCurrentMode: jest.fn().mockResolvedValue('MIRROR') };
      const service = new CompensationReconciliationService(
        repository as never,
        cartRepository as never,
        inventoryReservations as never,
        modeService as never,
      );
      return { service, repository, inventoryReservations };
    }

    it.each<[Exclude<ReserveOrRenewOutcome, { ok: true }>['code'], CompensationReasonCode, string | null]>([
      ['RESERVATION_PRODUCT_SUSPENDED', 'PRODUCT_SUSPENDED', null],
      ['RESERVATION_ACCOUNTING_UNDERFLOW', 'ACCOUNTING_UNDERFLOW', null],
      ['RESERVATION_ACCOUNTING_CORRUPTION', 'ACCOUNTING_UNDERFLOW', 'RESERVATION_ACCOUNTING_CORRUPTION'],
      ['RESERVATION_MALFORMED_RESOURCE', 'ACCOUNTING_UNDERFLOW', 'RESERVATION_MALFORMED_RESOURCE'],
    ])(
      'routes %s directly to BLOCKED_PRODUCT_SUSPECT (%s, lastError=%s) even near max attempts',
      async (code, expectedReason, expectedLastError) => {
        const { service, repository, inventoryReservations } = makeReconciler(4);
        inventoryReservations.reserveOrRenew.mockResolvedValueOnce({ ok: false, code });

        const out = await service.attemptRecovery(IDS.comp, new Date('2026-11-17T00:00:00.000Z'));
        expect(out).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', compensationId: IDS.comp });
        expect(repository.blockIfGenerationMatches).toHaveBeenCalledWith(
          IDS.comp,
          7,
          expect.objectContaining({
            blockReason: 'PRODUCT_SUSPECT' satisfies CompensationBlockReason,
            reasonCode: expectedReason,
            lastError: expectedLastError,
          }),
        );
        expect(repository.markPermanentFailureIfGenerationMatches).not.toHaveBeenCalled();
        expect(repository.requeueAfterAttemptIfGenerationMatches).not.toHaveBeenCalled();
      },
    );

    it.each<[Exclude<ReserveOrRenewOutcome, { ok: true }>['code'], CompensationReasonCode, string | null]>([
      ['RESERVATION_CHECKOUT_IN_PROGRESS', 'CHECKOUT_IN_PROGRESS', null],
      ['RESERVATION_RESOURCE_GENERATION_MISMATCH', 'UNKNOWN_INFRA_FAILURE', 'RESERVATION_RESOURCE_GENERATION_MISMATCH'],
      ['FENCE_REJECTED', 'UNKNOWN_INFRA_FAILURE', 'FENCE_REJECTED'],
      ['UNCERTAIN_INFRASTRUCTURE', 'UNKNOWN_INFRA_FAILURE', 'UNCERTAIN_INFRASTRUCTURE'],
    ])(
      'keeps %s retry-bounded (%s -> RETRY_SCHEDULED below cap, PERMANENT_FAILURE at cap)',
      async (code, expectedReason, expectedLastError) => {
        const low = makeReconciler(1);
        low.inventoryReservations.reserveOrRenew.mockResolvedValueOnce({ ok: false, code });
        const retryOut = await low.service.attemptRecovery(IDS.comp, new Date('2026-11-17T00:00:00.000Z'));
        expect(retryOut.outcome).toBe('RETRY_SCHEDULED');
        expect(low.repository.requeueAfterAttemptIfGenerationMatches).toHaveBeenCalledWith(
          IDS.comp,
          7,
          expect.objectContaining({ reasonCode: expectedReason, lastError: expectedLastError }),
        );
        expect(low.repository.blockIfGenerationMatches).not.toHaveBeenCalled();

        const high = makeReconciler(5);
        high.inventoryReservations.reserveOrRenew.mockResolvedValueOnce({ ok: false, code });
        const permOut = await high.service.attemptRecovery(IDS.comp, new Date('2026-11-17T00:00:00.000Z'));
        expect(permOut).toEqual({ outcome: 'PERMANENT_FAILURE', compensationId: IDS.comp });
        expect(high.repository.blockIfGenerationMatches).not.toHaveBeenCalled();
      },
    );
  });

  describe('ReservationRecoveryConvergenceService CART_SCOPED convergence', () => {
    function makeConvergence() {
      const modeService = { getCurrentModeSnapshot: jest.fn().mockResolvedValue({ mode: 'CART_SCOPED', revision: 1 }) };
      const inventoryReservations = {
        reserve: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        reserveOrRenew: jest.fn(),
        releaseReservation: jest.fn(),
      };
      const service = new ReservationRecoveryConvergenceService(modeService as never, inventoryReservations as never);
      return { service, inventoryReservations };
    }

    it('blocks genuine accounting/malformed failures and retries generation mismatch & infra failures', async () => {
      const { service, inventoryReservations } = makeConvergence();
      for (const code of [
        'RESERVATION_PRODUCT_SUSPENDED',
        'RESERVATION_ACCOUNTING_UNDERFLOW',
        'RESERVATION_ACCOUNTING_CORRUPTION',
        'RESERVATION_MALFORMED_RESOURCE',
      ] as const) {
        inventoryReservations.reserveOrRenew.mockResolvedValueOnce({ ok: false, code });
        expect(
          await service.convergeCartScopedDirect({
            cartId: IDS.cart,
            productId: IDS.product,
            customerId: IDS.customer,
            desiredQuantity: 3,
          }),
        ).toEqual({ outcome: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT' });
      }

      for (const code of ['RESERVATION_RESOURCE_GENERATION_MISMATCH', 'FENCE_REJECTED', 'UNCERTAIN_INFRASTRUCTURE'] as const) {
        inventoryReservations.reserveOrRenew.mockResolvedValueOnce({ ok: false, code });
        expect(
          await service.convergeCartScopedDirect({
            cartId: IDS.cart,
            productId: IDS.product,
            customerId: IDS.customer,
            desiredQuantity: 3,
          }),
        ).toEqual({ outcome: 'RETRY', reasonCode: 'UNKNOWN_INFRA_FAILURE', lastError: code });
      }
    });
  });
});
