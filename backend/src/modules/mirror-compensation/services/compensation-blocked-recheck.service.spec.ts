import { CartReservationCompensation } from '@prisma/client';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { CompensationRepository } from '../repositories/compensation.repository';
import { CompensationBlockedRecheckService } from './compensation-blocked-recheck.service';

// Phase 16A.0-C4.3. Mocks every dependency - verifies recheckBlocked's
// routing logic in isolation. Real-Postgres+Redis end-to-end proof lives
// in compensation-reconciliation.redis.integration.spec.ts.

type MockCompensationRepository = jest.Mocked<
  Pick<
    CompensationRepository,
    'findById' | 'unblockIfGenerationMatches' | 'rescheduleBlockedCheckIfGenerationMatches'
  >
>;
type MockCartRepository = jest.Mocked<Pick<CartRepository, 'findItemByCartAndProduct'>>;
type MockInventoryReservationsService = jest.Mocked<Pick<InventoryReservationsService, 'reconcileProductReservedTotal'>>;
type MockModeService = jest.Mocked<Pick<ReservationEngineModeService, 'getCurrentMode'>>;

function blockedRow(overrides: Partial<CartReservationCompensation> = {}): CartReservationCompensation {
  const now = new Date();
  return {
    id: 'comp-1',
    schemaVersion: 1,
    operation: 'RESERVE_MIRROR',
    status: 'BLOCKED',
    cartId: 'cart-1',
    productId: 'product-1',
    customerId: 'customer-1',
    desiredQuantity: 5,
    reasonCode: 'PRODUCT_SUSPENDED',
    blockReason: 'PRODUCT_SUSPECT',
    attemptCount: 1,
    blockedCheckCount: 0,
    nextAttemptAt: now,
    lastAttemptAt: now,
    lastError: null,
    generation: 3,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    permanentFailureAt: null,
    ...overrides,
  };
}

describe('CompensationBlockedRecheckService.recheckBlocked', () => {
  let repository: MockCompensationRepository;
  let cartRepository: MockCartRepository;
  let inventoryReservations: MockInventoryReservationsService;
  let modeService: MockModeService;
  let service: CompensationBlockedRecheckService;

  beforeEach(() => {
    repository = {
      findById: jest.fn().mockResolvedValue(blockedRow()),
      unblockIfGenerationMatches: jest.fn().mockResolvedValue({ count: 1 }),
      rescheduleBlockedCheckIfGenerationMatches: jest.fn().mockResolvedValue({ count: 1 }),
    };
    cartRepository = { findItemByCartAndProduct: jest.fn().mockResolvedValue({ quantity: 5 }) };
    inventoryReservations = {
      reconcileProductReservedTotal: jest.fn().mockResolvedValue({ admissionSuspended: true }),
    };
    modeService = { getCurrentMode: jest.fn().mockResolvedValue('DRAINING') };

    service = new CompensationBlockedRecheckService(
      repository as unknown as CompensationRepository,
      cartRepository as unknown as CartRepository,
      inventoryReservations as unknown as InventoryReservationsService,
      modeService as unknown as ReservationEngineModeService,
    );
  });

  describe('guards', () => {
    it('returns NOT_FOUND when no row exists', async () => {
      repository.findById.mockResolvedValue(null);
      const result = await service.recheckBlocked('comp-1', new Date());
      expect(result).toEqual({ outcome: 'NOT_FOUND', compensationId: 'comp-1' });
    });

    it.each(['RESOLVED', 'PERMANENT_FAILURE'] as const)('returns ALREADY_RESOLVED for a %s row', async (status) => {
      repository.findById.mockResolvedValue(blockedRow({ status }));
      const result = await service.recheckBlocked('comp-1', new Date());
      expect(result).toEqual({ outcome: 'ALREADY_RESOLVED', compensationId: 'comp-1' });
    });

    it.each(['PENDING', 'PROCESSING'] as const)('returns NOT_DUE for a %s row (wrong entry point)', async (status) => {
      repository.findById.mockResolvedValue(blockedRow({ status }));
      const result = await service.recheckBlocked('comp-1', new Date());
      expect(result).toEqual({ outcome: 'NOT_DUE', compensationId: 'comp-1' });
    });

    it('throws an invariant-violation error for a BLOCKED row with a null blockReason', async () => {
      repository.findById.mockResolvedValue(blockedRow({ blockReason: null }));
      await expect(service.recheckBlocked('comp-1', new Date())).rejects.toThrow(/Invariant violation/);
    });
  });

  describe('desired state dropped to zero while blocked', () => {
    it('PRODUCT_SUSPECT unblocks without consulting product accounting', async () => {
      repository.findById.mockResolvedValue(blockedRow({ blockReason: 'PRODUCT_SUSPECT' }));
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);

      const result = await service.recheckBlocked('comp-1', new Date());

      expect(inventoryReservations.reconcileProductReservedTotal).not.toHaveBeenCalled();
      expect(repository.unblockIfGenerationMatches).toHaveBeenCalledWith('comp-1', 3, expect.any(Date));
      expect(result).toEqual({ outcome: 'UNBLOCKED_PENDING', compensationId: 'comp-1' });
    });

    it('MODE_NOT_ADMITTING unblocks without consulting the current mode', async () => {
      repository.findById.mockResolvedValue(blockedRow({ blockReason: 'MODE_NOT_ADMITTING' }));
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);

      const result = await service.recheckBlocked('comp-1', new Date());

      expect(modeService.getCurrentMode).not.toHaveBeenCalled();
      expect(repository.unblockIfGenerationMatches).toHaveBeenCalledWith('comp-1', 3, expect.any(Date));
      expect(result).toEqual({ outcome: 'UNBLOCKED_PENDING', compensationId: 'comp-1' });
    });
  });

  describe('PRODUCT_SUSPECT branch', () => {
    beforeEach(() => {
      repository.findById.mockResolvedValue(blockedRow({ blockReason: 'PRODUCT_SUSPECT' }));
    });

    it('still admissionSuspended reschedules without touching attemptCount', async () => {
      inventoryReservations.reconcileProductReservedTotal.mockResolvedValue({ admissionSuspended: true } as never);

      const result = await service.recheckBlocked('comp-1', new Date());

      expect(repository.rescheduleBlockedCheckIfGenerationMatches).toHaveBeenCalledWith(
        'comp-1',
        3,
        expect.any(Date),
      );
      expect(repository.unblockIfGenerationMatches).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', compensationId: 'comp-1' });
    });

    it('a healthy reconciliation unblocks', async () => {
      inventoryReservations.reconcileProductReservedTotal.mockResolvedValue({ admissionSuspended: false } as never);

      const result = await service.recheckBlocked('comp-1', new Date());

      expect(repository.unblockIfGenerationMatches).toHaveBeenCalledWith('comp-1', 3, expect.any(Date));
      expect(result).toEqual({ outcome: 'UNBLOCKED_PENDING', compensationId: 'comp-1' });
    });
  });

  describe('MODE_NOT_ADMITTING branch', () => {
    beforeEach(() => {
      repository.findById.mockResolvedValue(blockedRow({ blockReason: 'MODE_NOT_ADMITTING' }));
    });

    it('still DRAINING reschedules', async () => {
      modeService.getCurrentMode.mockResolvedValue('DRAINING');

      const result = await service.recheckBlocked('comp-1', new Date());

      expect(repository.rescheduleBlockedCheckIfGenerationMatches).toHaveBeenCalledWith(
        'comp-1',
        3,
        expect.any(Date),
      );
      expect(result).toEqual({ outcome: 'BLOCKED_MODE_NOT_ADMITTING', compensationId: 'comp-1' });
    });

    it('mode moved on unblocks', async () => {
      modeService.getCurrentMode.mockResolvedValue('CART_SCOPED');

      const result = await service.recheckBlocked('comp-1', new Date());

      expect(repository.unblockIfGenerationMatches).toHaveBeenCalledWith('comp-1', 3, expect.any(Date));
      expect(result).toEqual({ outcome: 'UNBLOCKED_PENDING', compensationId: 'comp-1' });
    });
  });

  describe('generation mismatch (stale check)', () => {
    it('a stale unblock reports STALE_BLOCKED_CHECK', async () => {
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      repository.unblockIfGenerationMatches.mockResolvedValue({ count: 0 });

      const result = await service.recheckBlocked('comp-1', new Date());

      expect(result).toEqual({ outcome: 'STALE_BLOCKED_CHECK', compensationId: 'comp-1' });
    });

    it('a stale reschedule reports STALE_BLOCKED_CHECK', async () => {
      inventoryReservations.reconcileProductReservedTotal.mockResolvedValue({ admissionSuspended: true } as never);
      repository.rescheduleBlockedCheckIfGenerationMatches.mockResolvedValue({ count: 0 });

      const result = await service.recheckBlocked('comp-1', new Date());

      expect(result).toEqual({ outcome: 'STALE_BLOCKED_CHECK', compensationId: 'comp-1' });
    });
  });
});
