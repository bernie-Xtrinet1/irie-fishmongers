import { CartReservationSyncState, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { ReservationRecoveryConvergenceService } from '../../reservation-recovery/services/reservation-recovery-convergence.service';
import { CartReservationSyncStateRepository } from '../repositories/cart-reservation-sync-state.repository';
import { CartReservationSyncBlockedRecheckService } from './cart-reservation-sync-blocked-recheck.service';
import { CartReservationSyncRecoveryService } from './cart-reservation-sync-recovery.service';

// Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen plan). BLOCKED entry and
// the mode-race fencing (REQUEUED_MODE_CHANGED) - split from
// cart-reservation-sync-recovery.service.spec.ts (DA.1B's own claim-fencing
// coverage) to stay under the 400-line file cap.
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
    generation: 3,
    attemptCount: 0,
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

describe('CartReservationSyncRecoveryService (DA.4B: BLOCKED entry + mode-race fencing)', () => {
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
      releaseClaimIfCurrent: jest.fn(),
      markUnresolved: jest.fn().mockResolvedValue({ count: 1 }),
      findRecoveryCandidateIds: jest.fn(),
      blockIfGenerationMatches: jest.fn(),
    };
    cartRepository = {
      findItemByCartAndProduct: jest.fn(),
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

  describe('BLOCKED entry', () => {
    it('PRODUCT_SUSPECT blocks with a fenced write, consuming zero additional attemptCount', async () => {
      const claimed = buildMarker({ generation: 4, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue({
        id: 'item-1',
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 3,
        mutationVersion: 1,
      } as never);
      recoveryTarget.converge.mockResolvedValue({
        outcome: 'BLOCKED',
        blockReason: 'PRODUCT_SUSPECT',
        observedMode: cartScopedSnapshot,
      });
      syncState.blockIfGenerationMatches.mockResolvedValue({ count: 1 });

      const now = new Date();
      const outcome = await service.reconcileOne('marker-1', now);

      expect(syncState.blockIfGenerationMatches).toHaveBeenCalledWith(
        'marker-1',
        4,
        1,
        'PRODUCT_SUSPECT',
        expect.any(Date),
      );
      expect(outcome).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', markerId: 'marker-1' });
    });

    it('MODE_NOT_ADMITTING (DRAINING + reserve-shaped) blocks the same way', async () => {
      const claimed = buildMarker({ generation: 2, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
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
        observedMode: { mode: 'DRAINING' as const, revisionId: 'rev-2', revision: 4 },
      });
      syncState.blockIfGenerationMatches.mockResolvedValue({ count: 1 });

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(outcome).toEqual({ outcome: 'BLOCKED_MODE_NOT_ADMITTING', markerId: 'marker-1' });
    });

    it('a fenced-out block entry (customer superseded) reports REQUEUED_SUPERSEDED, never a false BLOCKED', async () => {
      const claimed = buildMarker({ generation: 4, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue({
        id: 'item-1',
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 3,
        mutationVersion: 1,
      } as never);
      recoveryTarget.converge.mockResolvedValue({
        outcome: 'BLOCKED',
        blockReason: 'PRODUCT_SUSPECT',
        observedMode: cartScopedSnapshot,
      });
      syncState.blockIfGenerationMatches.mockResolvedValue({ count: 0 });
      syncState.findById.mockResolvedValue(buildMarker({ generation: 5, status: 'PENDING' }));

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(outcome).toEqual({ outcome: 'REQUEUED_SUPERSEDED', markerId: 'marker-1' });
      expect(syncState.markUnresolved).toHaveBeenCalledWith('cart-1', 'product-1');
    });
  });

  describe('mode-race fencing (REQUEUED_MODE_CHANGED)', () => {
    it('a converged write is NOT resolved when the mode identity changed - claim released, next attempt retargets the new authority', async () => {
      const claimed = buildMarker({ generation: 3, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      recoveryTarget.converge.mockResolvedValue({ outcome: 'CONVERGED', observedMode: cartScopedSnapshot });
      modeService.verifyModeRevisionUnchanged.mockResolvedValue(false);
      syncState.releaseClaimIfCurrent.mockResolvedValue({ count: 1 });

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(modeService.verifyModeRevisionUnchanged).toHaveBeenCalledWith(fakeTx, {
        revisionId: 'rev-1',
        revision: 3,
      });
      expect(syncState.resolveClaimIfCurrent).not.toHaveBeenCalled();
      expect(syncState.releaseClaimIfCurrent).toHaveBeenCalledWith(
        'marker-1',
        3,
        1,
        expect.stringContaining('mode'),
        fakeTx,
      );
      expect(outcome).toEqual({ outcome: 'REQUEUED_MODE_CHANGED', markerId: 'marker-1' });
    });

    it('the mode-identity check and the resolve write happen inside the SAME transaction', async () => {
      const claimed = buildMarker({ generation: 3, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      recoveryTarget.converge.mockResolvedValue({ outcome: 'CONVERGED', observedMode: cartScopedSnapshot });
      modeService.verifyModeRevisionUnchanged.mockResolvedValue(true);
      syncState.resolveClaimIfCurrent.mockResolvedValue({ count: 1 });

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(syncState.resolveClaimIfCurrent).toHaveBeenCalledWith('marker-1', 3, 1, expect.any(Date), fakeTx);
      expect(outcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: 'marker-1' });
    });

    it('a fenced-out release (customer superseded while mode also changed) still reports REQUEUED_MODE_CHANGED, not REQUEUED_SUPERSEDED - the mode check runs first', async () => {
      const claimed = buildMarker({ generation: 3, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      recoveryTarget.converge.mockResolvedValue({ outcome: 'CONVERGED', observedMode: cartScopedSnapshot });
      modeService.verifyModeRevisionUnchanged.mockResolvedValue(false);
      syncState.releaseClaimIfCurrent.mockResolvedValue({ count: 1 });

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(outcome).toEqual({ outcome: 'REQUEUED_MODE_CHANGED', markerId: 'marker-1' });
      expect(syncState.markUnresolved).not.toHaveBeenCalled();
    });
  });

  describe('customerId authority', () => {
    it('a reserve-shaped target with no matching Cart throws an invariant violation rather than converging against a guessed owner', async () => {
      const claimed = buildMarker({ generation: 1, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue({
        id: 'item-1',
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 2,
        mutationVersion: 1,
      } as never);
      cartRepository.findById.mockResolvedValue(null);

      await expect(service.reconcileOne('marker-1', new Date())).rejects.toThrow('Invariant violation');
      expect(recoveryTarget.converge).not.toHaveBeenCalled();
    });
  });
});
