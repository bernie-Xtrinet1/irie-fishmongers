import { CartReservationCompensation } from '@prisma/client';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { CompensationRepository } from '../repositories/compensation.repository';
import { CompensationReconciliationService } from './compensation-reconciliation.service';

// Phase 16A.0-C4.3. The per-ReservationEngineMode branch matrix, split
// from compensation-reconciliation.service.spec.ts to stay under the
// 400-line file cap.

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

describe('CompensationReconciliationService.attemptRecovery (mode matrix)', () => {
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
      reserveOrRenew: jest
        .fn()
        .mockResolvedValue({ ok: true, result: { entry: {} as never, underflow: null } }),
      releaseReservation: jest.fn().mockResolvedValue({ released: true, quantity: 0, underflow: null }),
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

  it('MIRROR + desired>0 reserves and converges', async () => {
    modeService.getCurrentMode.mockResolvedValue('MIRROR');

    const result = await service.attemptRecovery('comp-1', new Date());

    expect(inventoryReservations.reserveOrRenew).toHaveBeenCalledWith('cart-1', 'product-1', 'customer-1', 5);
    expect(result).toEqual({ outcome: 'RESOLVED_CONVERGED', compensationId: 'comp-1' });
  });

  it('MIRROR + desired=0 releases and converges', async () => {
    modeService.getCurrentMode.mockResolvedValue('MIRROR');
    cartRepository.findItemByCartAndProduct.mockResolvedValue(null);

    const result = await service.attemptRecovery('comp-1', new Date());

    expect(inventoryReservations.releaseReservation).toHaveBeenCalledWith('cart-1', 'product-1');
    expect(result).toEqual({ outcome: 'RESOLVED_CONVERGED', compensationId: 'comp-1' });
  });

  it('CART_SCOPED + desired>0 reserves, converges, and logs an invariant warning', async () => {
    modeService.getCurrentMode.mockResolvedValue('CART_SCOPED');
    const warnSpy = jest.spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn');

    const result = await service.attemptRecovery('comp-1', new Date());

    expect(inventoryReservations.reserveOrRenew).toHaveBeenCalledWith('cart-1', 'product-1', 'customer-1', 5);
    expect(result).toEqual({ outcome: 'RESOLVED_CONVERGED', compensationId: 'comp-1' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CART_SCOPED'),
      expect.objectContaining({ compensationId: 'comp-1' }),
    );
    warnSpy.mockRestore();
  });

  it('DRAINING + desired>0 blocks without ever calling reserveOrRenew', async () => {
    modeService.getCurrentMode.mockResolvedValue('DRAINING');

    const result = await service.attemptRecovery('comp-1', new Date());

    expect(inventoryReservations.reserveOrRenew).not.toHaveBeenCalled();
    expect(repository.blockIfGenerationMatches).toHaveBeenCalledWith(
      'comp-1',
      0,
      expect.objectContaining({ blockReason: 'MODE_NOT_ADMITTING' }),
    );
    expect(result).toEqual({ outcome: 'BLOCKED_MODE_NOT_ADMITTING', compensationId: 'comp-1' });
  });

  it('DRAINING + desired>0 preserves the existing reasonCode (no new diagnostic produced)', async () => {
    modeService.getCurrentMode.mockResolvedValue('DRAINING');

    await service.attemptRecovery('comp-1', new Date());

    const [, , input] = repository.blockIfGenerationMatches.mock.calls[0]!;
    expect(input).not.toHaveProperty('reasonCode');
  });

  it('DRAINING + desired=0 releases and converges', async () => {
    modeService.getCurrentMode.mockResolvedValue('DRAINING');
    cartRepository.findItemByCartAndProduct.mockResolvedValue(null);

    const result = await service.attemptRecovery('comp-1', new Date());

    expect(inventoryReservations.releaseReservation).toHaveBeenCalledWith('cart-1', 'product-1');
    expect(result).toEqual({ outcome: 'RESOLVED_CONVERGED', compensationId: 'comp-1' });
  });

  it('LEGACY + desired>0 releases (never reserves) and reports RESOLVED_NO_LONGER_NEEDED_LEGACY', async () => {
    modeService.getCurrentMode.mockResolvedValue('LEGACY');

    const result = await service.attemptRecovery('comp-1', new Date());

    expect(inventoryReservations.reserveOrRenew).not.toHaveBeenCalled();
    expect(inventoryReservations.releaseReservation).toHaveBeenCalledWith('cart-1', 'product-1');
    expect(result).toEqual({ outcome: 'RESOLVED_NO_LONGER_NEEDED_LEGACY', compensationId: 'comp-1' });
  });

  it('LEGACY + desired=0 also releases and reports RESOLVED_NO_LONGER_NEEDED_LEGACY', async () => {
    modeService.getCurrentMode.mockResolvedValue('LEGACY');
    cartRepository.findItemByCartAndProduct.mockResolvedValue(null);

    const result = await service.attemptRecovery('comp-1', new Date());

    expect(inventoryReservations.releaseReservation).toHaveBeenCalledWith('cart-1', 'product-1');
    expect(result).toEqual({ outcome: 'RESOLVED_NO_LONGER_NEEDED_LEGACY', compensationId: 'comp-1' });
  });

  it('never calls the legacy hash-based reserve/release methods under any mode', async () => {
    for (const mode of ['MIRROR', 'CART_SCOPED', 'DRAINING', 'LEGACY'] as const) {
      modeService.getCurrentMode.mockResolvedValue(mode);
      await service.attemptRecovery('comp-1', new Date());
    }

    expect(inventoryReservations.reserve).not.toHaveBeenCalled();
    expect(inventoryReservations.release).not.toHaveBeenCalled();
  });
});
