import { CartReservationSyncState, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { ReservationRecoveryConvergenceService } from '../../reservation-recovery/services/reservation-recovery-convergence.service';
import { CartReservationSyncStateRepository } from '../repositories/cart-reservation-sync-state.repository';
import { CartReservationSyncBlockedRecheckService } from './cart-reservation-sync-blocked-recheck.service';
import { CartReservationSyncRecoveryService } from './cart-reservation-sync-recovery.service';

function buildMarker(overrides: Partial<CartReservationSyncState> = {}): CartReservationSyncState {
  return {
    id: 'marker-1',
    cartId: 'cart-1',
    productId: 'product-1',
    expectedMutationVersion: 0,
    expectedQuantity: 5,
    status: 'PENDING',
    blockReason: null,
    nextAttemptAt: null,
    ordinaryProvenanceState: 'HISTORICAL_UNVERIFIED',
    ordinaryEnqueueSequence: 0,
    ordinaryCommandSequence: 0,
    ordinaryAcknowledgedSequence: 0,
    generation: 3,
    attemptCount: 1,
    lastError: null,
    processingStartedAt: null,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const cartScopedSnapshot = { mode: 'CART_SCOPED' as const, revisionId: 'rev-1', revision: 3 };
const fakeTx = { marker: 'tx' } as unknown as Prisma.TransactionClient;

describe('CartReservationSyncRecoveryService Conflict-C late-write & bounded escalation classification', () => {
  let syncState: jest.Mocked<
    Pick<
      CartReservationSyncStateRepository,
      | 'claimForRecovery'
      | 'findById'
      | 'resolveClaimIfCurrent'
      | 'releaseClaimIfCurrent'
      | 'markUnresolved'
      | 'findRecoveryCandidateIds'
      | 'blockIfGenerationMatches'
      | 'escalateBlockedIfCurrent'
    >
  >;
  let cartRepository: jest.Mocked<Pick<CartRepository, 'findItemByCartAndProduct' | 'findById'>>;
  let recoveryTarget: jest.Mocked<Pick<ReservationRecoveryConvergenceService, 'converge'>>;
  let modeService: jest.Mocked<Pick<ReservationEngineModeService, 'verifyModeRevisionUnchanged'>>;
  let prisma: jest.Mocked<Pick<PrismaService, '$transaction'>>;
  let blockedRecheck: jest.Mocked<Pick<CartReservationSyncBlockedRecheckService, 'recheckBlocked'>>;
  let service: CartReservationSyncRecoveryService;

  beforeEach(() => {
    syncState = {
      claimForRecovery: jest.fn(),
      findById: jest.fn(),
      resolveClaimIfCurrent: jest.fn(),
      releaseClaimIfCurrent: jest.fn().mockResolvedValue({ count: 1 }),
      markUnresolved: jest.fn().mockResolvedValue({ count: 1 }),
      findRecoveryCandidateIds: jest.fn(),
      blockIfGenerationMatches: jest.fn().mockResolvedValue({ count: 1 }),
      escalateBlockedIfCurrent: jest.fn().mockResolvedValue({ count: 1 }),
    };
    cartRepository = {
      findItemByCartAndProduct: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockResolvedValue({ id: 'cart-1', customerId: 'customer-1' }),
    };
    recoveryTarget = { converge: jest.fn() };
    modeService = { verifyModeRevisionUnchanged: jest.fn().mockResolvedValue(true) };
    prisma = { $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(fakeTx)) } as never;
    blockedRecheck = { recheckBlocked: jest.fn() };

    service = new CartReservationSyncRecoveryService(
      syncState as unknown as CartReservationSyncStateRepository,
      cartRepository as unknown as CartRepository,
      recoveryTarget as unknown as ReservationRecoveryConvergenceService,
      modeService as unknown as ReservationEngineModeService,
      prisma as unknown as PrismaService,
      blockedRecheck as unknown as CartReservationSyncBlockedRecheckService,
    );
  });

  it('requeues REQUEUED_MODE_CHANGED when RETRY(FENCE_REJECTED) occurs after a verified mode-revision change', async () => {
    syncState.claimForRecovery.mockResolvedValue(buildMarker({ attemptCount: 1 }));
    recoveryTarget.converge.mockResolvedValue({
      outcome: 'RETRY',
      reasonCode: 'FENCE_REJECTED',
      lastError: 'FENCE_REJECTED',
      observedMode: cartScopedSnapshot,
    });
    modeService.verifyModeRevisionUnchanged.mockResolvedValue(false);

    const outcome = await service.reconcileOne('marker-1', new Date());

    expect(outcome).toEqual({ outcome: 'REQUEUED_MODE_CHANGED', markerId: 'marker-1' });
    expect(syncState.releaseClaimIfCurrent).toHaveBeenCalledWith(
      'marker-1',
      3,
      1,
      'reservation-engine mode identity changed during recovery',
      fakeTx,
    );
    expect(syncState.escalateBlockedIfCurrent).not.toHaveBeenCalled();
  });

  it('requeues REQUEUED_MODE_CHANGED when BLOCKED(MODE_NOT_ADMITTING) occurs concurrently with a verified mode change', async () => {
    syncState.claimForRecovery.mockResolvedValue(buildMarker({ attemptCount: 1 }));
    cartRepository.findItemByCartAndProduct.mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'product-1',
      quantity: 2,
      mutationVersion: 1,
    } as never);
    recoveryTarget.converge.mockResolvedValue({
      outcome: 'BLOCKED',
      blockReason: 'MODE_NOT_ADMITTING',
      observedMode: { mode: 'DRAINING', revisionId: 'rev-drain', revision: 4 },
    });
    modeService.verifyModeRevisionUnchanged.mockResolvedValue(false);

    const outcome = await service.reconcileOne('marker-1', new Date());

    expect(outcome).toEqual({ outcome: 'REQUEUED_MODE_CHANGED', markerId: 'marker-1' });
    expect(syncState.blockIfGenerationMatches).not.toHaveBeenCalled();
  });

  it('distinguishes unresolved mode/fence disagreement (mode revision unchanged, FENCE_REJECTED) and escalates at attempt 3', async () => {
    syncState.claimForRecovery.mockResolvedValueOnce(buildMarker({ attemptCount: 1 }));
    recoveryTarget.converge.mockResolvedValue({
      outcome: 'RETRY',
      reasonCode: 'FENCE_REJECTED',
      lastError: 'FENCE_REJECTED',
      observedMode: cartScopedSnapshot,
    });
    modeService.verifyModeRevisionUnchanged.mockResolvedValue(true);

    const first = await service.reconcileOne('marker-1', new Date());
    expect(first).toEqual({ outcome: 'REQUEUED_RETRYABLE_FAILURE', markerId: 'marker-1' });
    expect(syncState.releaseClaimIfCurrent).toHaveBeenCalledWith(
      'marker-1',
      3,
      1,
      'unresolved reservation mode/fence disagreement: FENCE_REJECTED',
    );

    syncState.claimForRecovery.mockResolvedValueOnce(buildMarker({ attemptCount: 3 }));
    const escalated = await service.reconcileOne('marker-1', new Date());
    expect(escalated).toEqual({ outcome: 'BLOCKED_MODE_NOT_ADMITTING', markerId: 'marker-1' });
    expect(syncState.escalateBlockedIfCurrent).toHaveBeenCalledWith(
      'marker-1',
      3,
      3,
      expect.any(Date),
      expect.stringContaining('OPERATOR_ESCALATION: unresolved reservation mode/fence disagreement'),
      undefined,
    );
  });

  it('escalates genuine infrastructure retries once MAX_RECOVERY_RETRY_ATTEMPTS (10) is reached', async () => {
    syncState.claimForRecovery.mockResolvedValue(buildMarker({ attemptCount: 10 }));
    recoveryTarget.converge.mockResolvedValue({
      outcome: 'RETRY',
      reasonCode: 'UNKNOWN_INFRA_FAILURE',
      lastError: 'redis timeout',
      observedMode: cartScopedSnapshot,
    });
    modeService.verifyModeRevisionUnchanged.mockResolvedValue(true);

    const outcome = await service.reconcileOne('marker-1', new Date());

    expect(outcome).toEqual({ outcome: 'BLOCKED_MODE_NOT_ADMITTING', markerId: 'marker-1' });
    expect(syncState.escalateBlockedIfCurrent).toHaveBeenCalledWith(
      'marker-1',
      3,
      10,
      expect.any(Date),
      'OPERATOR_ESCALATION: redis timeout',
      undefined,
    );
  });
});
