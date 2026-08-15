import { CartReservationSyncState, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { ReservationRecoveryConvergenceService } from '../../reservation-recovery/services/reservation-recovery-convergence.service';
import { CartReservationSyncStateRepository } from '../repositories/cart-reservation-sync-state.repository';
import { CartReservationSyncBlockedRecheckService } from './cart-reservation-sync-blocked-recheck.service';
import { CartReservationSyncRecoveryService } from './cart-reservation-sync-recovery.service';

// Phase 16A.0-DA, Unit DA.1B (see the DA.1B claim-fencing review), extended
// in Unit DA.4B (see the DA.4B frozen plan). Proves the claim/fencing
// contract at the unit level: every terminal repository call must be
// gated by BOTH claimedGeneration and claimedAttemptCount, a stale
// worker's fenced-out miss must never touch a newer worker's claim, and
// markUnresolved fires only for the generation-superseded case, never the
// pure-reclaim case. BLOCKED entry, REQUEUED_MODE_CHANGED, and
// customerId-derivation coverage live in the sibling
// cart-reservation-sync-recovery-mode-aware.service.spec.ts; runBatch
// dispatch mechanics live in cart-reservation-sync-recovery-batch.service.spec.ts;
// both splits exist purely to keep every file within the repository's
// 400-line limit.
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

const legacySnapshot = { mode: 'LEGACY' as const, revisionId: null, revision: null };
const fakeTx = { marker: 'tx' } as unknown as Prisma.TransactionClient;

describe('CartReservationSyncRecoveryService', () => {
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

  describe('claim miss classification', () => {
    it('classifies NOT_FOUND when no row exists', async () => {
      syncState.claimForRecovery.mockResolvedValue(null);
      syncState.findById.mockResolvedValue(null);

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(outcome).toEqual({ outcome: 'NOT_FOUND', markerId: 'marker-1' });
    });

    it('classifies ALREADY_RESOLVED when the row already has resolvedAt set', async () => {
      syncState.claimForRecovery.mockResolvedValue(null);
      syncState.findById.mockResolvedValue(buildMarker({ resolvedAt: new Date() }));

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(outcome).toEqual({ outcome: 'ALREADY_RESOLVED', markerId: 'marker-1' });
    });

    it('classifies ALREADY_CLAIMED when the row is unresolved but not stale-claimable (re-reads rather than assuming)', async () => {
      syncState.claimForRecovery.mockResolvedValue(null);
      syncState.findById.mockResolvedValue(
        buildMarker({ resolvedAt: null, status: 'PROCESSING', processingStartedAt: new Date() }),
      );

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(outcome).toEqual({ outcome: 'ALREADY_CLAIMED', markerId: 'marker-1' });
      expect(syncState.findById).toHaveBeenCalledWith('marker-1');
    });
  });

  describe('reserve path (CartItem exists)', () => {
    it('uses the CURRENT CartItem quantity, ignores marker.expectedQuantity, derives customerId from the current cart, and resolves on the fenced pair', async () => {
      const claimed = buildMarker({ generation: 7, attemptCount: 2, status: 'PROCESSING', expectedQuantity: 999 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue({
        id: 'item-1',
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 11,
        mutationVersion: 4,
      } as never);
      recoveryTarget.converge.mockResolvedValue({ outcome: 'CONVERGED', observedMode: legacySnapshot });
      syncState.resolveClaimIfCurrent.mockResolvedValue({ count: 1 });

      const now = new Date();
      const outcome = await service.reconcileOne('marker-1', now);

      expect(recoveryTarget.converge).toHaveBeenCalledWith({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: 'customer-1',
        desiredQuantity: 11, // current quantity, not 999
      });
      expect(syncState.resolveClaimIfCurrent).toHaveBeenCalledWith('marker-1', 7, 2, now, fakeTx);
      expect(outcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: 'marker-1' });
    });
  });

  describe('release path (CartItem absent)', () => {
    it('converges with a null customerId/desiredQuantity, never looks up the cart, and resolves on the fenced pair', async () => {
      const claimed = buildMarker({ generation: 5, attemptCount: 1, expectedQuantity: 42 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      recoveryTarget.converge.mockResolvedValue({ outcome: 'CONVERGED', observedMode: legacySnapshot });
      syncState.resolveClaimIfCurrent.mockResolvedValue({ count: 1 });

      const now = new Date();
      const outcome = await service.reconcileOne('marker-1', now);

      expect(recoveryTarget.converge).toHaveBeenCalledWith({
        cartId: 'cart-1',
        productId: 'product-1',
        customerId: null,
        desiredQuantity: null,
      });
      expect(cartRepository.findById).not.toHaveBeenCalled();
      expect(syncState.resolveClaimIfCurrent).toHaveBeenCalledWith('marker-1', 5, 1, now, fakeTx);
      expect(outcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: 'marker-1' });
    });
  });

  describe('RETRY outcomes', () => {
    it('an infra-failure RETRY sanitizes lastError and releases on the exact claimed (generation, attemptCount) pair - fenced hit', async () => {
      const claimed = buildMarker({ generation: 2, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      recoveryTarget.converge.mockResolvedValue({
        outcome: 'RETRY',
        reasonCode: 'UNKNOWN_INFRA_FAILURE',
        lastError: 'redis down: token=secret-abc',
        observedMode: legacySnapshot,
      });
      syncState.releaseClaimIfCurrent.mockResolvedValue({ count: 1 });

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(syncState.releaseClaimIfCurrent).toHaveBeenCalledWith(
        'marker-1',
        2,
        1,
        expect.stringContaining('redis down'),
      );
      const [, , , sanitized] = syncState.releaseClaimIfCurrent.mock.calls[0]!;
      expect(sanitized).not.toContain('secret-abc'); // sanitizeErrorMessage redacted it
      expect(outcome).toEqual({ outcome: 'REQUEUED_RETRYABLE_FAILURE', markerId: 'marker-1' });
    });

    it('a CHECKOUT_IN_PROGRESS RETRY releases with a fixed descriptive message, never a raw error', async () => {
      const claimed = buildMarker({ generation: 2, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      recoveryTarget.converge.mockResolvedValue({
        outcome: 'RETRY',
        reasonCode: 'CHECKOUT_IN_PROGRESS',
        lastError: null,
        observedMode: legacySnapshot,
      });
      syncState.releaseClaimIfCurrent.mockResolvedValue({ count: 1 });

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(syncState.releaseClaimIfCurrent).toHaveBeenCalledWith(
        'marker-1',
        2,
        1,
        expect.stringContaining('checkout in progress'),
      );
      expect(outcome).toEqual({ outcome: 'REQUEUED_RETRYABLE_FAILURE', markerId: 'marker-1' });
    });

    it('classifies STALE_CLAIM when the fenced release misses - never falls back to an ungated release', async () => {
      const claimed = buildMarker({ generation: 2, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      recoveryTarget.converge.mockResolvedValue({
        outcome: 'RETRY',
        reasonCode: 'UNKNOWN_INFRA_FAILURE',
        lastError: 'redis down',
        observedMode: legacySnapshot,
      });
      syncState.releaseClaimIfCurrent.mockResolvedValue({ count: 0 });

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(syncState.releaseClaimIfCurrent).toHaveBeenCalledTimes(1);
      expect(syncState.releaseClaimIfCurrent).toHaveBeenCalledWith('marker-1', 2, 1, expect.any(String));
      expect(outcome).toEqual({ outcome: 'STALE_CLAIM', markerId: 'marker-1' });
    });
  });

  describe('resolve miss after a converged write', () => {
    it('never returns RESOLVED_CONVERGED on a miss, and calls markUnresolved only when generation changed (superseded)', async () => {
      const claimed = buildMarker({ generation: 4, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      recoveryTarget.converge.mockResolvedValue({ outcome: 'CONVERGED', observedMode: legacySnapshot });
      syncState.resolveClaimIfCurrent.mockResolvedValue({ count: 0 });
      // A customer mutation superseded us: generation moved, current row is
      // back at PENDING (upsertDesiredState's own unconditional write).
      syncState.findById.mockResolvedValue(buildMarker({ generation: 5, status: 'PENDING' }));

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(outcome.outcome).not.toBe('RESOLVED_CONVERGED');
      expect(outcome).toEqual({ outcome: 'REQUEUED_SUPERSEDED', markerId: 'marker-1' });
      expect(syncState.markUnresolved).toHaveBeenCalledWith('cart-1', 'product-1');
      expect(syncState.releaseClaimIfCurrent).not.toHaveBeenCalled(); // never an ungated release
    });

    it('does not call markUnresolved and reports STALE_CLAIM when only attemptCount changed (pure reclaim, generation unchanged)', async () => {
      const claimed = buildMarker({ generation: 4, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      recoveryTarget.converge.mockResolvedValue({ outcome: 'CONVERGED', observedMode: legacySnapshot });
      syncState.resolveClaimIfCurrent.mockResolvedValue({ count: 0 });
      // Another worker reclaimed: generation UNCHANGED, only attemptCount/status moved.
      syncState.findById.mockResolvedValue(
        buildMarker({ generation: 4, attemptCount: 2, status: 'PROCESSING' }),
      );

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(outcome).toEqual({ outcome: 'STALE_CLAIM', markerId: 'marker-1' });
      expect(syncState.markUnresolved).not.toHaveBeenCalled(); // must not touch B's legitimate claim
    });
  });

  describe('false-PENDING acceptance (DA.1A Review #2 conservative rule, reused by DA.1B/DA.4B)', () => {
    it('a stale worker whose write lands after a newer generation already resolved conservatively unresolves it - not treated as corruption', async () => {
      // Old stale worker's claim: generation 4, attemptCount 1.
      const claimed = buildMarker({ generation: 4, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      // The write "succeeds" from the stale worker's own point of view.
      recoveryTarget.converge.mockResolvedValue({ outcome: 'CONVERGED', observedMode: legacySnapshot });
      // But the fenced resolve misses - a newer generation (5) already
      // converged and was resolved by DA.1A's own synchronous path.
      syncState.resolveClaimIfCurrent.mockResolvedValue({ count: 0 });
      syncState.findById.mockResolvedValue(buildMarker({ generation: 5, status: 'PENDING', resolvedAt: null }));

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(outcome).toEqual({ outcome: 'REQUEUED_SUPERSEDED', markerId: 'marker-1' });
      expect(syncState.markUnresolved).toHaveBeenCalledWith('cart-1', 'product-1');
      // Accepted: this is a false-PENDING, not corruption - a future
      // reconcileOne call will re-read current CartItem truth and converge
      // generation 5 again.
    });
  });

  describe('attemptCount fencing (core DA.1B invariant)', () => {
    it('a reclaimed worker (A) can neither resolve nor release worker B\'s claim, and no operation modifies B\'s metadata', async () => {
      // Worker A claims first: generation=G(4), attemptCount=1.
      const workerAClaim = buildMarker({ generation: 4, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(workerAClaim);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      recoveryTarget.converge.mockResolvedValue({ outcome: 'CONVERGED', observedMode: legacySnapshot });
      // A's terminal resolve is fenced out - B has since reclaimed
      // (attemptCount now 2, same generation 4 - no CartItem mutation
      // happened, only a stale-PROCESSING reclaim).
      syncState.resolveClaimIfCurrent.mockResolvedValue({ count: 0 });
      syncState.findById.mockResolvedValue(
        buildMarker({ generation: 4, attemptCount: 2, status: 'PROCESSING', processingStartedAt: new Date() }),
      );

      const outcome = await service.reconcileOne('marker-1', new Date());

      // A's resolve attempt used EXACTLY A's own claimed pair - never B's.
      expect(syncState.resolveClaimIfCurrent).toHaveBeenCalledWith('marker-1', 4, 1, expect.any(Date), fakeTx);
      // A never attempts release in the success path at all.
      expect(syncState.releaseClaimIfCurrent).not.toHaveBeenCalled();
      // A must not touch B's claim via markUnresolved either.
      expect(syncState.markUnresolved).not.toHaveBeenCalled();
      expect(outcome).toEqual({ outcome: 'STALE_CLAIM', markerId: 'marker-1' });
    });

    it('a reclaimed worker (A) whose write throws still fences its release attempt to its own stale pair, never B\'s', async () => {
      const workerAClaim = buildMarker({ generation: 6, attemptCount: 3 });
      syncState.claimForRecovery.mockResolvedValue(workerAClaim);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      recoveryTarget.converge.mockResolvedValue({
        outcome: 'RETRY',
        reasonCode: 'UNKNOWN_INFRA_FAILURE',
        lastError: 'redis timeout',
        observedMode: legacySnapshot,
      });
      // B has already reclaimed (attemptCount 4) by the time A's release
      // finally rejects - A's fenced release must miss.
      syncState.releaseClaimIfCurrent.mockResolvedValue({ count: 0 });

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(syncState.releaseClaimIfCurrent).toHaveBeenCalledWith('marker-1', 6, 3, expect.any(String));
      expect(outcome).toEqual({ outcome: 'STALE_CLAIM', markerId: 'marker-1' });
    });
  });

});
