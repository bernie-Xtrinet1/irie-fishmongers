import { CartReservationCompensation } from '@prisma/client';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { CompensationRepository } from '../repositories/compensation.repository';
import { CompensationReconciliationService } from './compensation-reconciliation.service';

// Phase 16A.0-C4.3. Mocks every dependency - this suite verifies
// attemptRecovery's own claim/desired-state/failure-classification/
// retry/generation-race routing logic. Mode-matrix coverage lives in
// compensation-reconciliation-mode-matrix.service.spec.ts (split to stay
// under the 400-line file cap). Real-Postgres+Redis end-to-end proof
// lives in compensation-reconciliation.redis.integration.spec.ts.

type MockCompensationRepository = jest.Mocked<
  Pick<
    CompensationRepository,
    | 'claimForRecoveryAttempt'
    | 'findById'
    | 'resolveIfGenerationMatches'
    | 'blockIfGenerationMatches'
    | 'requeueAfterAttemptIfGenerationMatches'
    | 'markPermanentFailureIfGenerationMatches'
    | 'releaseStaleClaim'
  >
>;
type MockCartRepository = jest.Mocked<Pick<CartRepository, 'findById' | 'findItemByCartAndProduct'>>;
type MockInventoryReservationsService = jest.Mocked<
  Pick<InventoryReservationsService, 'reserveOrRenew' | 'releaseReservation' | 'reserve' | 'release'>
>;
type MockModeService = jest.Mocked<Pick<ReservationEngineModeService, 'getCurrentMode'>>;

function baseRow(overrides: Partial<CartReservationCompensation> = {}): CartReservationCompensation {
  const now = new Date();
  return {
    id: 'comp-1',
    schemaVersion: 1,
    operation: 'RESERVE_MIRROR',
    status: 'PROCESSING',
    cartId: 'cart-1',
    productId: 'product-1',
    customerId: 'customer-1',
    desiredQuantity: 5,
    reasonCode: 'UNKNOWN_INFRA_FAILURE',
    blockReason: null,
    attemptCount: 1,
    blockedCheckCount: 0,
    nextAttemptAt: now,
    lastAttemptAt: now,
    lastError: null,
    generation: 0,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    permanentFailureAt: null,
    ...overrides,
  };
}

describe('CompensationReconciliationService.attemptRecovery', () => {
  let repository: MockCompensationRepository;
  let cartRepository: MockCartRepository;
  let inventoryReservations: MockInventoryReservationsService;
  let modeService: MockModeService;
  let service: CompensationReconciliationService;

  beforeEach(() => {
    repository = {
      claimForRecoveryAttempt: jest.fn().mockResolvedValue({ count: 1 }),
      findById: jest.fn().mockResolvedValue(baseRow()),
      resolveIfGenerationMatches: jest.fn().mockResolvedValue({ count: 1 }),
      blockIfGenerationMatches: jest.fn().mockResolvedValue({ count: 1 }),
      requeueAfterAttemptIfGenerationMatches: jest.fn().mockResolvedValue({ count: 1 }),
      markPermanentFailureIfGenerationMatches: jest.fn().mockResolvedValue({ count: 1 }),
      releaseStaleClaim: jest.fn().mockResolvedValue({ count: 1 }),
    };
    cartRepository = {
      findById: jest.fn().mockResolvedValue({ id: 'cart-1', customerId: 'customer-1', currency: null }),
      findItemByCartAndProduct: jest.fn().mockResolvedValue({ quantity: 5 }),
    };
    inventoryReservations = {
      reserveOrRenew: jest.fn(),
      releaseReservation: jest.fn(),
      reserve: jest.fn(),
      release: jest.fn(),
    };
    modeService = { getCurrentMode: jest.fn().mockResolvedValue('MIRROR') };

    service = new CompensationReconciliationService(
      repository as unknown as CompensationRepository,
      cartRepository as unknown as CartRepository,
      inventoryReservations as unknown as InventoryReservationsService,
      modeService as unknown as ReservationEngineModeService,
    );
  });

  describe('claim-path guards', () => {
    it('returns NOT_FOUND when the claim fails and no row exists', async () => {
      repository.claimForRecoveryAttempt.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(null);

      const result = await service.attemptRecovery('comp-1', new Date());

      expect(result).toEqual({ outcome: 'NOT_FOUND', compensationId: 'comp-1' });
    });

    it.each(['RESOLVED', 'PERMANENT_FAILURE'] as const)(
      'returns ALREADY_RESOLVED when the claim fails and the row is %s',
      async (status) => {
        repository.claimForRecoveryAttempt.mockResolvedValue({ count: 0 });
        repository.findById.mockResolvedValue(baseRow({ status }));

        const result = await service.attemptRecovery('comp-1', new Date());

        expect(result).toEqual({ outcome: 'ALREADY_RESOLVED', compensationId: 'comp-1' });
      },
    );

    it.each(['PENDING', 'PROCESSING', 'BLOCKED'] as const)(
      'returns NOT_DUE when the claim fails and the row is %s',
      async (status) => {
        repository.claimForRecoveryAttempt.mockResolvedValue({ count: 0 });
        repository.findById.mockResolvedValue(baseRow({ status }));

        const result = await service.attemptRecovery('comp-1', new Date());

        expect(result).toEqual({ outcome: 'NOT_DUE', compensationId: 'comp-1' });
      },
    );

    it('returns NOT_FOUND (defensive) if the row vanishes between a successful claim and the follow-up read', async () => {
      repository.claimForRecoveryAttempt.mockResolvedValue({ count: 1 });
      repository.findById.mockResolvedValue(null);

      const result = await service.attemptRecovery('comp-1', new Date());

      expect(result).toEqual({ outcome: 'NOT_FOUND', compensationId: 'comp-1' });
    });
  });

  describe('desired-state derivation', () => {
    it('CartItem removed converges via release, not reserve, regardless of the stored operation', async () => {
      repository.findById.mockResolvedValue(baseRow({ operation: 'RESERVE_MIRROR', desiredQuantity: 5 }));
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      inventoryReservations.releaseReservation.mockResolvedValue({ released: true, quantity: 0, underflow: null });

      const result = await service.attemptRecovery('comp-1', new Date());

      expect(inventoryReservations.reserveOrRenew).not.toHaveBeenCalled();
      expect(inventoryReservations.releaseReservation).toHaveBeenCalledWith('cart-1', 'product-1');
      expect(result).toEqual({ outcome: 'RESOLVED_CONVERGED', compensationId: 'comp-1' });
    });

    it('CartItem present converges via reserve at its current quantity, not the stored desiredQuantity', async () => {
      repository.findById.mockResolvedValue(baseRow({ operation: 'RELEASE_MIRROR', desiredQuantity: null }));
      cartRepository.findItemByCartAndProduct.mockResolvedValue({ quantity: 11 } as never);
      inventoryReservations.reserveOrRenew.mockResolvedValue({
        ok: true,
        result: { entry: {} as never, underflow: null },
      });

      await service.attemptRecovery('comp-1', new Date());

      expect(inventoryReservations.releaseReservation).not.toHaveBeenCalled();
      expect(inventoryReservations.reserveOrRenew).toHaveBeenCalledWith('cart-1', 'product-1', 'customer-1', 11);
    });

    it('uses current Cart.customerId, not the row-stored customerId', async () => {
      repository.findById.mockResolvedValue(baseRow({ customerId: 'stale-customer' }));
      cartRepository.findById.mockResolvedValue({ id: 'cart-1', customerId: 'fresh-customer', currency: null } as never);
      cartRepository.findItemByCartAndProduct.mockResolvedValue({ quantity: 5 } as never);
      inventoryReservations.reserveOrRenew.mockResolvedValue({
        ok: true,
        result: { entry: {} as never, underflow: null },
      });

      await service.attemptRecovery('comp-1', new Date());

      expect(inventoryReservations.reserveOrRenew).toHaveBeenCalledWith('cart-1', 'product-1', 'fresh-customer', 5);
    });

    it('throws an invariant-violation error if the cart itself cannot be found', async () => {
      cartRepository.findById.mockResolvedValue(null);

      await expect(service.attemptRecovery('comp-1', new Date())).rejects.toThrow(/Invariant violation/);
    });
  });

  describe('failure classification', () => {
    beforeEach(() => {
      cartRepository.findItemByCartAndProduct.mockResolvedValue({ quantity: 5 } as never);
    });

    it('RESERVATION_PRODUCT_SUSPENDED blocks with blockReason PRODUCT_SUSPECT and reasonCode PRODUCT_SUSPENDED', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });

      const result = await service.attemptRecovery('comp-1', new Date());

      expect(repository.blockIfGenerationMatches).toHaveBeenCalledWith(
        'comp-1',
        0,
        expect.objectContaining({ blockReason: 'PRODUCT_SUSPECT', reasonCode: 'PRODUCT_SUSPENDED' }),
      );
      expect(result).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', compensationId: 'comp-1' });
    });

    it('an underflow on a clean reserve blocks with reasonCode ACCOUNTING_UNDERFLOW', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({
        ok: true,
        result: { entry: {} as never, underflow: { direction: 'UNDERCOUNT' } as never },
      });

      await service.attemptRecovery('comp-1', new Date());

      expect(repository.blockIfGenerationMatches).toHaveBeenCalledWith(
        'comp-1',
        0,
        expect.objectContaining({ blockReason: 'PRODUCT_SUSPECT', reasonCode: 'ACCOUNTING_UNDERFLOW' }),
      );
    });

    it('an underflow on release also blocks with reasonCode ACCOUNTING_UNDERFLOW', async () => {
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      inventoryReservations.releaseReservation.mockResolvedValue({
        released: true,
        quantity: 0,
        underflow: { direction: 'UNDERCOUNT' } as never,
      });

      await service.attemptRecovery('comp-1', new Date());

      expect(repository.blockIfGenerationMatches).toHaveBeenCalledWith(
        'comp-1',
        0,
        expect.objectContaining({ blockReason: 'PRODUCT_SUSPECT', reasonCode: 'ACCOUNTING_UNDERFLOW' }),
      );
    });

    it('RESERVATION_CHECKOUT_IN_PROGRESS schedules a retry and never calls blockIfGenerationMatches', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({ ok: false, code: 'RESERVATION_CHECKOUT_IN_PROGRESS' });

      const result = await service.attemptRecovery('comp-1', new Date());

      expect(repository.blockIfGenerationMatches).not.toHaveBeenCalled();
      expect(repository.requeueAfterAttemptIfGenerationMatches).toHaveBeenCalledWith(
        'comp-1',
        0,
        expect.objectContaining({ reasonCode: 'CHECKOUT_IN_PROGRESS' }),
      );
      expect(result).toMatchObject({ outcome: 'RETRY_SCHEDULED', compensationId: 'comp-1' });
    });

    it('a thrown exception on reserve schedules a retry with a sanitized reasonCode UNKNOWN_INFRA_FAILURE diagnostic', async () => {
      inventoryReservations.reserveOrRenew.mockRejectedValue(new Error('Bearer abc123 leaked'));

      await service.attemptRecovery('comp-1', new Date());

      expect(repository.requeueAfterAttemptIfGenerationMatches).toHaveBeenCalledWith(
        'comp-1',
        0,
        expect.objectContaining({ reasonCode: 'UNKNOWN_INFRA_FAILURE', lastError: 'Bearer [REDACTED] leaked' }),
      );
    });

    it('a thrown exception on release also schedules a retry with a sanitized diagnostic', async () => {
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      inventoryReservations.releaseReservation.mockRejectedValue(new Error('connection reset'));

      await service.attemptRecovery('comp-1', new Date());

      expect(inventoryReservations.reserveOrRenew).not.toHaveBeenCalled();
      expect(repository.requeueAfterAttemptIfGenerationMatches).toHaveBeenCalledWith(
        'comp-1',
        0,
        expect.objectContaining({ reasonCode: 'UNKNOWN_INFRA_FAILURE', lastError: 'connection reset' }),
      );
    });

    it('a non-Error thrown value is still converted to a diagnostic string', async () => {
      inventoryReservations.reserveOrRenew.mockRejectedValue('ECONNRESET');

      await service.attemptRecovery('comp-1', new Date());

      expect(repository.requeueAfterAttemptIfGenerationMatches).toHaveBeenCalledWith(
        'comp-1',
        0,
        expect.objectContaining({ reasonCode: 'UNKNOWN_INFRA_FAILURE', lastError: 'ECONNRESET' }),
      );
    });
  });

  describe('retry backoff and permanent failure', () => {
    beforeEach(() => {
      cartRepository.findItemByCartAndProduct.mockResolvedValue({ quantity: 5 } as never);
      inventoryReservations.reserveOrRenew.mockResolvedValue({ ok: false, code: 'RESERVATION_CHECKOUT_IN_PROGRESS' });
    });

    it.each([
      [1, 30],
      [2, 120],
      [3, 600],
      [4, 1800],
    ])('attemptCount %d schedules the next attempt %d seconds later', async (attemptCount, delaySeconds) => {
      const now = new Date('2026-01-01T00:00:00.000Z');
      repository.findById.mockResolvedValue(baseRow({ attemptCount }));

      const result = await service.attemptRecovery('comp-1', now);

      expect(result).toMatchObject({
        outcome: 'RETRY_SCHEDULED',
        nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000),
      });
    });

    it('attemptCount 5 permanently fails instead of scheduling a 6th attempt', async () => {
      repository.findById.mockResolvedValue(baseRow({ attemptCount: 5 }));

      const result = await service.attemptRecovery('comp-1', new Date());

      expect(repository.requeueAfterAttemptIfGenerationMatches).not.toHaveBeenCalled();
      expect(repository.markPermanentFailureIfGenerationMatches).toHaveBeenCalledWith('comp-1', 0, expect.any(Date));
      expect(result).toEqual({ outcome: 'PERMANENT_FAILURE', compensationId: 'comp-1' });
    });
  });

  describe('generation-race behavior', () => {
    beforeEach(() => {
      cartRepository.findItemByCartAndProduct.mockResolvedValue({ quantity: 5 } as never);
    });

    it('a resolveIfGenerationMatches mismatch releases the claim and reports REQUEUED_NEWER_DIVERGENCE', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({
        ok: true,
        result: { entry: {} as never, underflow: null },
      });
      repository.resolveIfGenerationMatches.mockResolvedValue({ count: 0 });

      const result = await service.attemptRecovery('comp-1', new Date());

      expect(repository.releaseStaleClaim).toHaveBeenCalledWith('comp-1', expect.any(Date));
      expect(result).toEqual({ outcome: 'REQUEUED_NEWER_DIVERGENCE', compensationId: 'comp-1' });
    });

    it('a blockIfGenerationMatches mismatch releases the claim and reports REQUEUED_NEWER_DIVERGENCE', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });
      repository.blockIfGenerationMatches.mockResolvedValue({ count: 0 });

      const result = await service.attemptRecovery('comp-1', new Date());

      expect(repository.releaseStaleClaim).toHaveBeenCalledWith('comp-1', expect.any(Date));
      expect(result).toEqual({ outcome: 'REQUEUED_NEWER_DIVERGENCE', compensationId: 'comp-1' });
    });

    it('a requeueAfterAttemptIfGenerationMatches mismatch releases the claim and reports REQUEUED_NEWER_DIVERGENCE', async () => {
      inventoryReservations.reserveOrRenew.mockResolvedValue({ ok: false, code: 'RESERVATION_CHECKOUT_IN_PROGRESS' });
      repository.requeueAfterAttemptIfGenerationMatches.mockResolvedValue({ count: 0 });

      const result = await service.attemptRecovery('comp-1', new Date());

      expect(repository.releaseStaleClaim).toHaveBeenCalledWith('comp-1', expect.any(Date));
      expect(result).toEqual({ outcome: 'REQUEUED_NEWER_DIVERGENCE', compensationId: 'comp-1' });
    });

    it('a markPermanentFailureIfGenerationMatches mismatch releases the claim and reports REQUEUED_NEWER_DIVERGENCE', async () => {
      repository.findById.mockResolvedValue(baseRow({ attemptCount: 5 }));
      inventoryReservations.reserveOrRenew.mockResolvedValue({ ok: false, code: 'RESERVATION_CHECKOUT_IN_PROGRESS' });
      repository.markPermanentFailureIfGenerationMatches.mockResolvedValue({ count: 0 });

      const result = await service.attemptRecovery('comp-1', new Date());

      expect(repository.releaseStaleClaim).toHaveBeenCalledWith('comp-1', expect.any(Date));
      expect(result).toEqual({ outcome: 'REQUEUED_NEWER_DIVERGENCE', compensationId: 'comp-1' });
    });
  });
});
