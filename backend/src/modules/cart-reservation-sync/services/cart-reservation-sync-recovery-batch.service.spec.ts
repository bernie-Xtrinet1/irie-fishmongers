import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { ReservationRecoveryConvergenceService } from '../../reservation-recovery/services/reservation-recovery-convergence.service';
import { CartReservationSyncStateRepository } from '../repositories/cart-reservation-sync-state.repository';
import { CartReservationSyncBlockedRecheckService } from './cart-reservation-sync-blocked-recheck.service';
import { CartReservationSyncRecoveryService } from './cart-reservation-sync-recovery.service';

// Phase 16A.0-DA, Unit DA.1B (see the DA.1B claim-fencing review), extended
// in Unit DA.4B (see the DA.4B frozen plan). Proves runBatch's own dispatch
// mechanics in isolation from reconcileOne's claim/fencing contract (that
// contract is covered in the sibling cart-reservation-sync-recovery.service.spec.ts,
// which this file was split out of purely to keep both files within the
// repository's 400-line limit): one-shot candidate snapshotting, status-based
// dispatch (PENDING/PROCESSING to reconcileOne, BLOCKED to the sibling
// blocked-recheck service), sequential (never parallel) processing,
// per-candidate error isolation, and outcome-counter tallying.
const fakeTx = { marker: 'tx' } as unknown as Prisma.TransactionClient;

describe('CartReservationSyncRecoveryService.runBatch', () => {
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

  it('snapshots candidates exactly once, dispatches by status, and processes each at most once in the invocation', async () => {
    syncState.findRecoveryCandidateIds.mockResolvedValue([
      { id: 'a', status: 'PENDING' },
      { id: 'b', status: 'PROCESSING' },
      { id: 'c', status: 'PENDING' },
    ]);
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
    expect(blockedRecheck.recheckBlocked).not.toHaveBeenCalled();
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

  it('dispatches a BLOCKED candidate to the sibling blocked-recheck service, never to reconcileOne', async () => {
    syncState.findRecoveryCandidateIds.mockResolvedValue([{ id: 'blocked-1', status: 'BLOCKED' }]);
    const reconcileSpy = jest.spyOn(service, 'reconcileOne');
    blockedRecheck.recheckBlocked.mockResolvedValue({ outcome: 'UNBLOCKED_PENDING', markerId: 'blocked-1' });

    const now = new Date();
    const result = await service.runBatch({ now });

    expect(blockedRecheck.recheckBlocked).toHaveBeenCalledWith('blocked-1', now);
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, result: { counters: { unblocked: 1 } } });
  });

  it('a permanently failing candidate is attempted only once per invocation - no in-run hot loop', async () => {
    syncState.findRecoveryCandidateIds.mockResolvedValue([{ id: 'always-fails', status: 'PENDING' }]);
    const spy = jest
      .spyOn(service, 'reconcileOne')
      .mockResolvedValue({ outcome: 'REQUEUED_RETRYABLE_FAILURE', markerId: 'always-fails' });

    await service.runBatch({ now: new Date() });

    expect(spy).toHaveBeenCalledTimes(1); // never re-invoked within this same run
    spy.mockRestore();
  });

  it('isolates a per-candidate exception and still processes the remaining candidates', async () => {
    syncState.findRecoveryCandidateIds.mockResolvedValue([
      { id: 'throws', status: 'PENDING' },
      { id: 'ok', status: 'PENDING' },
    ]);
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
    syncState.findRecoveryCandidateIds.mockResolvedValue([
      { id: 'first', status: 'PENDING' },
      { id: 'second', status: 'PENDING' },
    ]);
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

  it('tallies REQUEUED_SUPERSEDED and skipped (ALREADY_RESOLVED/ALREADY_CLAIMED/NOT_DUE/NOT_FOUND) outcomes', async () => {
    syncState.findRecoveryCandidateIds.mockResolvedValue([
      { id: 'superseded', status: 'PENDING' },
      { id: 'resolved', status: 'PENDING' },
      { id: 'claimed', status: 'PROCESSING' },
      { id: 'missing', status: 'PENDING' },
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
