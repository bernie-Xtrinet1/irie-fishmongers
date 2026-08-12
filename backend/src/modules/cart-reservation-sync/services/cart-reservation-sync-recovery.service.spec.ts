import { CartReservationSyncState } from '@prisma/client';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CartReservationSyncStateRepository } from '../repositories/cart-reservation-sync-state.repository';
import { CartReservationSyncRecoveryService } from './cart-reservation-sync-recovery.service';

// Phase 16A.0-DA, Unit DA.1B (see the DA.1B claim-fencing review). Proves
// the claim/fencing contract at the unit level: every terminal repository
// call must be gated by BOTH claimedGeneration and claimedAttemptCount, a
// stale worker's fenced-out miss must never touch a newer worker's claim,
// and markUnresolved fires only for the generation-superseded case, never
// the pure-reclaim case.
function buildMarker(overrides: Partial<CartReservationSyncState> = {}): CartReservationSyncState {
  return {
    id: 'marker-1',
    cartId: 'cart-1',
    productId: 'product-1',
    expectedMutationVersion: 0,
    expectedQuantity: 5,
    status: 'PENDING',
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
    >
  >;
  let cartRepository: jest.Mocked<Pick<CartRepository, 'findItemByCartAndProduct'>>;
  let inventoryReservations: jest.Mocked<Pick<InventoryReservationsService, 'reserve' | 'release'>>;
  let service: CartReservationSyncRecoveryService;

  beforeEach(() => {
    syncState = {
      claimForRecovery: jest.fn(),
      findById: jest.fn(),
      resolveClaimIfCurrent: jest.fn(),
      releaseClaimIfCurrent: jest.fn(),
      markUnresolved: jest.fn().mockResolvedValue({ count: 1 }),
      findRecoveryCandidateIds: jest.fn(),
    };
    cartRepository = { findItemByCartAndProduct: jest.fn() };
    inventoryReservations = { reserve: jest.fn(), release: jest.fn() };

    service = new CartReservationSyncRecoveryService(
      syncState as unknown as CartReservationSyncStateRepository,
      cartRepository as unknown as CartRepository,
      inventoryReservations as unknown as InventoryReservationsService,
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
    it('uses the CURRENT CartItem quantity, ignores marker.expectedQuantity, never mutates CartItem, and resolves on the fenced pair', async () => {
      const claimed = buildMarker({ generation: 7, attemptCount: 2, status: 'PROCESSING', expectedQuantity: 999 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue({
        id: 'item-1',
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 11,
        mutationVersion: 4,
      } as never);
      syncState.resolveClaimIfCurrent.mockResolvedValue({ count: 1 });

      const now = new Date();
      const outcome = await service.reconcileOne('marker-1', now);

      expect(inventoryReservations.reserve).toHaveBeenCalledWith('product-1', 'cart-1', 11); // current quantity, not 999
      expect(inventoryReservations.release).not.toHaveBeenCalled();
      expect(syncState.resolveClaimIfCurrent).toHaveBeenCalledWith('marker-1', 7, 2, now); // id + claimedGeneration + claimedAttemptCount
      expect(outcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: 'marker-1' });
    });
  });

  describe('release path (CartItem absent)', () => {
    it('calls release, ignores marker.expectedQuantity, and resolves on the fenced pair', async () => {
      const claimed = buildMarker({ generation: 5, attemptCount: 1, expectedQuantity: 42 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      syncState.resolveClaimIfCurrent.mockResolvedValue({ count: 1 });

      const now = new Date();
      const outcome = await service.reconcileOne('marker-1', now);

      expect(inventoryReservations.release).toHaveBeenCalledWith('product-1', 'cart-1');
      expect(inventoryReservations.reserve).not.toHaveBeenCalled();
      expect(syncState.resolveClaimIfCurrent).toHaveBeenCalledWith('marker-1', 5, 1, now);
      expect(outcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: 'marker-1' });
    });
  });

  describe('Redis failure', () => {
    it('sanitizes the error and releases on the exact claimed (generation, attemptCount) pair - fenced hit', async () => {
      const claimed = buildMarker({ generation: 2, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      inventoryReservations.release.mockRejectedValue(new Error('redis down: token=secret-abc'));
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

    it('classifies STALE_CLAIM when the fenced release misses - never falls back to an ungated release', async () => {
      const claimed = buildMarker({ generation: 2, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      inventoryReservations.release.mockRejectedValue(new Error('redis down'));
      syncState.releaseClaimIfCurrent.mockResolvedValue({ count: 0 });

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(syncState.releaseClaimIfCurrent).toHaveBeenCalledTimes(1);
      expect(syncState.releaseClaimIfCurrent).toHaveBeenCalledWith('marker-1', 2, 1, expect.any(String));
      expect(outcome).toEqual({ outcome: 'STALE_CLAIM', markerId: 'marker-1' });
    });
  });

  describe('resolve miss after a successful Redis write', () => {
    it('never returns RESOLVED_CONVERGED on a miss, and calls markUnresolved only when generation changed (superseded)', async () => {
      const claimed = buildMarker({ generation: 4, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
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

  describe('false-PENDING acceptance (DA.1A Review #2 conservative rule, reused by DA.1B)', () => {
    it('a stale worker whose Redis write lands after a newer generation already resolved conservatively unresolves it - not treated as corruption', async () => {
      // Old stale worker's claim: generation 4, attemptCount 1.
      const claimed = buildMarker({ generation: 4, attemptCount: 1 });
      syncState.claimForRecovery.mockResolvedValue(claimed);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      // Redis "succeeds" from the stale worker's own point of view.
      inventoryReservations.release.mockResolvedValue(undefined);
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
      inventoryReservations.release.mockResolvedValue(undefined);
      // A's terminal resolve is fenced out - B has since reclaimed
      // (attemptCount now 2, same generation 4 - no CartItem mutation
      // happened, only a stale-PROCESSING reclaim).
      syncState.resolveClaimIfCurrent.mockResolvedValue({ count: 0 });
      syncState.findById.mockResolvedValue(
        buildMarker({ generation: 4, attemptCount: 2, status: 'PROCESSING', processingStartedAt: new Date() }),
      );

      const outcome = await service.reconcileOne('marker-1', new Date());

      // A's resolve attempt used EXACTLY A's own claimed pair - never B's.
      expect(syncState.resolveClaimIfCurrent).toHaveBeenCalledWith('marker-1', 4, 1, expect.any(Date));
      // A never attempts release in the success path at all.
      expect(syncState.releaseClaimIfCurrent).not.toHaveBeenCalled();
      // A must not touch B's claim via markUnresolved either.
      expect(syncState.markUnresolved).not.toHaveBeenCalled();
      expect(outcome).toEqual({ outcome: 'STALE_CLAIM', markerId: 'marker-1' });
    });

    it('a reclaimed worker (A) whose Redis call throws still fences its release attempt to its own stale pair, never B\'s', async () => {
      const workerAClaim = buildMarker({ generation: 6, attemptCount: 3 });
      syncState.claimForRecovery.mockResolvedValue(workerAClaim);
      cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
      inventoryReservations.release.mockRejectedValue(new Error('redis timeout'));
      // B has already reclaimed (attemptCount 4) by the time A's release
      // finally rejects - A's fenced release must miss.
      syncState.releaseClaimIfCurrent.mockResolvedValue({ count: 0 });

      const outcome = await service.reconcileOne('marker-1', new Date());

      expect(syncState.releaseClaimIfCurrent).toHaveBeenCalledWith('marker-1', 6, 3, expect.any(String));
      expect(outcome).toEqual({ outcome: 'STALE_CLAIM', markerId: 'marker-1' });
    });
  });

  describe('runBatch', () => {
    it('snapshots candidates exactly once and processes each at most once in the invocation', async () => {
      syncState.findRecoveryCandidateIds.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      const spy = jest
        .spyOn(service, 'reconcileOne')
        .mockResolvedValueOnce({ outcome: 'RESOLVED_CONVERGED', markerId: 'a' })
        .mockResolvedValueOnce({ outcome: 'STALE_CLAIM', markerId: 'b' })
        .mockResolvedValueOnce({ outcome: 'REQUEUED_RETRYABLE_FAILURE', markerId: 'c' });

      const now = new Date();
      const result = await service.runBatch({ now });

      expect(syncState.findRecoveryCandidateIds).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(spy).toHaveBeenNthCalledWith(1, 'a', now);
      expect(spy).toHaveBeenNthCalledWith(2, 'b', now);
      expect(spy).toHaveBeenNthCalledWith(3, 'c', now);
      expect(result).toMatchObject({
        ok: true,
        result: {
          candidatesFound: 3,
          attempted: 3,
          counters: { resolvedConverged: 1, staleClaim: 1, requeuedRetryableFailure: 1, requeuedSuperseded: 0, skipped: 0 },
        },
      });
      spy.mockRestore();
    });

    it('a permanently failing candidate is attempted only once per invocation - no in-run hot loop', async () => {
      syncState.findRecoveryCandidateIds.mockResolvedValue([{ id: 'always-fails' }]);
      const spy = jest
        .spyOn(service, 'reconcileOne')
        .mockResolvedValue({ outcome: 'REQUEUED_RETRYABLE_FAILURE', markerId: 'always-fails' });

      await service.runBatch({ now: new Date() });

      expect(spy).toHaveBeenCalledTimes(1); // never re-invoked within this same run
      spy.mockRestore();
    });

    it('isolates a per-candidate exception and still processes the remaining candidates', async () => {
      syncState.findRecoveryCandidateIds.mockResolvedValue([{ id: 'throws' }, { id: 'ok' }]);
      const spy = jest
        .spyOn(service, 'reconcileOne')
        .mockRejectedValueOnce(new Error('unexpected: token=secret-xyz'))
        .mockResolvedValueOnce({ outcome: 'RESOLVED_CONVERGED', markerId: 'ok' });

      const result = await service.runBatch({ now: new Date() });

      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.result.attempted).toBe(2);
        expect(result.result.errors).toHaveLength(1);
        expect(result.result.errors[0]?.markerId).toBe('throws');
        expect(result.result.errors[0]?.message).not.toContain('secret-xyz');
        expect(result.result.counters.resolvedConverged).toBe(1);
      }
      spy.mockRestore();
    });

    it('processes candidates sequentially, not in parallel', async () => {
      syncState.findRecoveryCandidateIds.mockResolvedValue([{ id: 'first' }, { id: 'second' }]);
      const order: string[] = [];
      const spy = jest.spyOn(service, 'reconcileOne').mockImplementation(async (markerId) => {
        order.push(`start:${markerId}`);
        await new Promise((resolve) => setTimeout(resolve, markerId === 'first' ? 30 : 0));
        order.push(`end:${markerId}`);
        return { outcome: 'RESOLVED_CONVERGED', markerId };
      });

      await service.runBatch({ now: new Date() });

      expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
      spy.mockRestore();
    });

    it('rejects invalid input without touching the repository', async () => {
      const result = await service.runBatch({ now: new Date(), limit: 0 });

      expect(result).toMatchObject({ ok: false, code: 'INVALID_INPUT', field: 'limit' });
      expect(syncState.findRecoveryCandidateIds).not.toHaveBeenCalled();
    });

    it('rejects an invalid now', async () => {
      const result = await service.runBatch({ now: new Date('not-a-date') });

      expect(result).toMatchObject({ ok: false, code: 'INVALID_INPUT', field: 'now' });
    });

    it('rejects a limit exceeding MAX_RECOVERY_BATCH_SIZE', async () => {
      const result = await service.runBatch({ now: new Date(), limit: 10_000 });

      expect(result).toMatchObject({ ok: false, code: 'INVALID_INPUT', field: 'limit' });
    });

    it('tallies REQUEUED_SUPERSEDED and skipped (ALREADY_RESOLVED/ALREADY_CLAIMED/NOT_FOUND) outcomes', async () => {
      syncState.findRecoveryCandidateIds.mockResolvedValue([
        { id: 'superseded' },
        { id: 'resolved' },
        { id: 'claimed' },
        { id: 'missing' },
      ]);
      const spy = jest
        .spyOn(service, 'reconcileOne')
        .mockResolvedValueOnce({ outcome: 'REQUEUED_SUPERSEDED', markerId: 'superseded' })
        .mockResolvedValueOnce({ outcome: 'ALREADY_RESOLVED', markerId: 'resolved' })
        .mockResolvedValueOnce({ outcome: 'ALREADY_CLAIMED', markerId: 'claimed' })
        .mockResolvedValueOnce({ outcome: 'NOT_FOUND', markerId: 'missing' });

      const result = await service.runBatch({ now: new Date() });

      expect(result).toMatchObject({
        ok: true,
        result: { counters: { requeuedSuperseded: 1, skipped: 3 } },
      });
      spy.mockRestore();
    });
  });
});
