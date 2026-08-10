import { CompensationRepository } from '../repositories/compensation.repository';
import { ReconcileOneResult } from '../types/compensation-reconciliation.types';
import { CompensationBatchService, MAX_BATCH_SIZE } from './compensation-batch.service';
import { CompensationBlockedRecheckService } from './compensation-blocked-recheck.service';
import { CompensationReconciliationService } from './compensation-reconciliation.service';

// Phase 16A.0-C4.4. Mocks every dependency - this suite verifies
// runBatch's own validation/dispatch/aggregation/isolation logic. Real-
// Postgres+Redis concurrency proof lives in
// compensation-batch.integration.spec.ts.

type MockRepository = jest.Mocked<Pick<CompensationRepository, 'findBatchCandidateIds'>>;
type MockReconciliation = jest.Mocked<Pick<CompensationReconciliationService, 'attemptRecovery'>>;
type MockBlockedRecheck = jest.Mocked<Pick<CompensationBlockedRecheckService, 'recheckBlocked'>>;

function outcome(o: ReconcileOneResult['outcome'], compensationId = 'comp-1'): ReconcileOneResult {
  if (o === 'RETRY_SCHEDULED') {
    return { outcome: o, compensationId, nextAttemptAt: new Date() };
  }
  return { outcome: o, compensationId };
}

describe('CompensationBatchService.runBatch', () => {
  let repository: MockRepository;
  let reconciliation: MockReconciliation;
  let blockedRecheck: MockBlockedRecheck;
  let service: CompensationBatchService;

  beforeEach(() => {
    repository = { findBatchCandidateIds: jest.fn().mockResolvedValue([]) };
    reconciliation = { attemptRecovery: jest.fn() };
    blockedRecheck = { recheckBlocked: jest.fn() };
    service = new CompensationBatchService(
      repository as unknown as CompensationRepository,
      reconciliation as unknown as CompensationReconciliationService,
      blockedRecheck as unknown as CompensationBlockedRecheckService,
    );
  });

  describe('input validation', () => {
    it('rejects an invalid now', async () => {
      const result = await service.runBatch({ now: new Date('not-a-date') });

      expect(result).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'now', reason: 'now must be a valid Date' });
      expect(repository.findBatchCandidateIds).not.toHaveBeenCalled();
    });

    it('rejects a non-integer limit', async () => {
      const result = await service.runBatch({ now: new Date(), limit: 1.5 });

      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'limit',
        reason: 'limit must be a positive integer',
      });
    });

    it('rejects limit <= 0', async () => {
      const result = await service.runBatch({ now: new Date(), limit: 0 });

      expect(result).toMatchObject({ ok: false, code: 'INVALID_INPUT', field: 'limit' });
    });

    it('rejects limit > MAX_BATCH_SIZE', async () => {
      const result = await service.runBatch({ now: new Date(), limit: MAX_BATCH_SIZE + 1 });

      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'limit',
        reason: `limit must not exceed ${MAX_BATCH_SIZE}`,
      });
    });

    it('accepts the default limit (50) when omitted', async () => {
      const result = await service.runBatch({ now: new Date() });

      expect(result.ok).toBe(true);
      expect(repository.findBatchCandidateIds).toHaveBeenCalledWith(expect.any(Date), 50);
    });

    it('accepts an explicit valid limit', async () => {
      const result = await service.runBatch({ now: new Date(), limit: 10 });

      expect(result.ok).toBe(true);
      expect(repository.findBatchCandidateIds).toHaveBeenCalledWith(expect.any(Date), 10);
    });

    it('accepts exactly MAX_BATCH_SIZE', async () => {
      const result = await service.runBatch({ now: new Date(), limit: MAX_BATCH_SIZE });
      expect(result.ok).toBe(true);
    });
  });

  it('calls the repository exactly once per run', async () => {
    repository.findBatchCandidateIds.mockResolvedValue([
      { id: 'comp-1', status: 'PENDING' },
      { id: 'comp-2', status: 'BLOCKED' },
    ]);
    reconciliation.attemptRecovery.mockResolvedValue(outcome('RESOLVED_CONVERGED'));
    blockedRecheck.recheckBlocked.mockResolvedValue(outcome('UNBLOCKED_PENDING'));

    await service.runBatch({ now: new Date() });

    expect(repository.findBatchCandidateIds).toHaveBeenCalledTimes(1);
  });

  it('an empty candidate list produces a zero-work result', async () => {
    const result = await service.runBatch({ now: new Date() });

    expect(result).toMatchObject({
      ok: true,
      result: {
        candidatesFound: 0,
        attempted: 0,
        resolved: 0,
        requeued: 0,
        retryScheduled: 0,
        blocked: 0,
        unblocked: 0,
        permanentFailure: 0,
        staleBlockedCheck: 0,
        skipped: 0,
        errors: [],
      },
    });
  });

  describe('dispatch by status', () => {
    it('a PENDING candidate routes to attemptRecovery, never recheckBlocked', async () => {
      repository.findBatchCandidateIds.mockResolvedValue([{ id: 'comp-1', status: 'PENDING' }]);
      reconciliation.attemptRecovery.mockResolvedValue(outcome('RESOLVED_CONVERGED'));

      await service.runBatch({ now: new Date() });

      expect(reconciliation.attemptRecovery).toHaveBeenCalledWith('comp-1', expect.any(Date));
      expect(blockedRecheck.recheckBlocked).not.toHaveBeenCalled();
    });

    it('a stale-PROCESSING-shaped candidate also routes to attemptRecovery, never recheckBlocked', async () => {
      repository.findBatchCandidateIds.mockResolvedValue([{ id: 'comp-1', status: 'PROCESSING' }]);
      reconciliation.attemptRecovery.mockResolvedValue(outcome('RESOLVED_CONVERGED'));

      await service.runBatch({ now: new Date() });

      expect(reconciliation.attemptRecovery).toHaveBeenCalledWith('comp-1', expect.any(Date));
      expect(blockedRecheck.recheckBlocked).not.toHaveBeenCalled();
    });

    it('a BLOCKED candidate routes to recheckBlocked, never attemptRecovery', async () => {
      repository.findBatchCandidateIds.mockResolvedValue([{ id: 'comp-1', status: 'BLOCKED' }]);
      blockedRecheck.recheckBlocked.mockResolvedValue(outcome('UNBLOCKED_PENDING'));

      await service.runBatch({ now: new Date() });

      expect(blockedRecheck.recheckBlocked).toHaveBeenCalledWith('comp-1', expect.any(Date));
      expect(reconciliation.attemptRecovery).not.toHaveBeenCalled();
    });
  });

  describe('outcome-to-counter mapping', () => {
    it.each([
      ['RESOLVED_CONVERGED', 'resolved'],
      ['RESOLVED_NO_LONGER_NEEDED_LEGACY', 'resolved'],
      ['REQUEUED_NEWER_DIVERGENCE', 'requeued'],
      ['RETRY_SCHEDULED', 'retryScheduled'],
      ['BLOCKED_PRODUCT_SUSPECT', 'blocked'],
      ['BLOCKED_MODE_NOT_ADMITTING', 'blocked'],
      ['PERMANENT_FAILURE', 'permanentFailure'],
      ['ALREADY_RESOLVED', 'skipped'],
      ['NOT_DUE', 'skipped'],
      ['NOT_FOUND', 'skipped'],
    ] as const)('%s (via attemptRecovery) increments %s', async (outcomeName, counterKey) => {
      repository.findBatchCandidateIds.mockResolvedValue([{ id: 'comp-1', status: 'PENDING' }]);
      reconciliation.attemptRecovery.mockResolvedValue(outcome(outcomeName));

      const result = await service.runBatch({ now: new Date() });

      expect(result).toMatchObject({ ok: true, result: { [counterKey]: 1 } });
    });

    it.each([
      ['UNBLOCKED_PENDING', 'unblocked'],
      ['STALE_BLOCKED_CHECK', 'staleBlockedCheck'],
      ['ALREADY_RESOLVED', 'skipped'],
      ['NOT_DUE', 'skipped'],
    ] as const)('%s (via recheckBlocked) increments %s', async (outcomeName, counterKey) => {
      repository.findBatchCandidateIds.mockResolvedValue([{ id: 'comp-1', status: 'BLOCKED' }]);
      blockedRecheck.recheckBlocked.mockResolvedValue(outcome(outcomeName));

      const result = await service.runBatch({ now: new Date() });

      expect(result).toMatchObject({ ok: true, result: { [counterKey]: 1 } });
    });

    it('multiple candidates with different outcomes aggregate correctly in one run', async () => {
      repository.findBatchCandidateIds.mockResolvedValue([
        { id: 'comp-1', status: 'PENDING' },
        { id: 'comp-2', status: 'PENDING' },
        { id: 'comp-3', status: 'BLOCKED' },
        { id: 'comp-4', status: 'BLOCKED' },
      ]);
      reconciliation.attemptRecovery
        .mockResolvedValueOnce(outcome('RESOLVED_CONVERGED', 'comp-1'))
        .mockResolvedValueOnce(outcome('RETRY_SCHEDULED', 'comp-2'));
      blockedRecheck.recheckBlocked
        .mockResolvedValueOnce(outcome('UNBLOCKED_PENDING', 'comp-3'))
        .mockResolvedValueOnce(outcome('STALE_BLOCKED_CHECK', 'comp-4'));

      const result = await service.runBatch({ now: new Date() });

      expect(result).toMatchObject({
        ok: true,
        result: {
          candidatesFound: 4,
          attempted: 4,
          resolved: 1,
          retryScheduled: 1,
          unblocked: 1,
          staleBlockedCheck: 1,
        },
      });
    });
  });

  describe('failure isolation', () => {
    it('one candidate throwing does not abort processing of the rest', async () => {
      repository.findBatchCandidateIds.mockResolvedValue([
        { id: 'comp-1', status: 'PENDING' },
        { id: 'comp-2', status: 'PENDING' },
        { id: 'comp-3', status: 'PENDING' },
      ]);
      reconciliation.attemptRecovery
        .mockResolvedValueOnce(outcome('RESOLVED_CONVERGED', 'comp-1'))
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(outcome('RESOLVED_CONVERGED', 'comp-3'));

      const result = await service.runBatch({ now: new Date() });

      expect(result).toMatchObject({
        ok: true,
        result: { candidatesFound: 3, attempted: 3, resolved: 2, errors: [{ compensationId: 'comp-2' }] },
      });
    });

    it('a thrown error message is sanitized before entering errors and the aggregate log, never as a raw Error', async () => {
      repository.findBatchCandidateIds.mockResolvedValue([{ id: 'comp-1', status: 'PENDING' }]);
      reconciliation.attemptRecovery.mockRejectedValue(new Error('Bearer abc123 leaked'));

      const result = await service.runBatch({ now: new Date() });

      expect(result).toMatchObject({
        ok: true,
        result: { errors: [{ compensationId: 'comp-1', message: 'Bearer [REDACTED] leaked' }] },
      });
      if (result.ok) {
        expect(JSON.stringify(result.result)).not.toContain('abc123');
        for (const entry of result.result.errors) {
          expect(typeof entry.message).toBe('string');
        }
      }
    });

    it('a non-Error thrown value is still converted to a sanitized string', async () => {
      repository.findBatchCandidateIds.mockResolvedValue([{ id: 'comp-1', status: 'PENDING' }]);
      reconciliation.attemptRecovery.mockRejectedValue('ECONNRESET');

      const result = await service.runBatch({ now: new Date() });

      expect(result).toMatchObject({
        ok: true,
        result: { errors: [{ compensationId: 'comp-1', message: 'ECONNRESET' }] },
      });
    });

    it('never records more than one error entry per candidate, and errors.length never exceeds candidatesFound', async () => {
      repository.findBatchCandidateIds.mockResolvedValue([
        { id: 'comp-1', status: 'PENDING' },
        { id: 'comp-2', status: 'PENDING' },
      ]);
      reconciliation.attemptRecovery.mockRejectedValue(new Error('always fails'));

      const result = await service.runBatch({ now: new Date() });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.errors).toHaveLength(2);
        expect(result.result.errors.length).toBeLessThanOrEqual(result.result.candidatesFound);
        const ids = result.result.errors.map((e) => e.compensationId);
        expect(new Set(ids).size).toBe(ids.length);
      }
    });

    it('a normal (non-exception) failure outcome never enters errors', async () => {
      repository.findBatchCandidateIds.mockResolvedValue([{ id: 'comp-1', status: 'PENDING' }]);
      reconciliation.attemptRecovery.mockResolvedValue(outcome('PERMANENT_FAILURE'));

      const result = await service.runBatch({ now: new Date() });

      expect(result).toMatchObject({ ok: true, result: { errors: [], permanentFailure: 1 } });
    });
  });

  it('processes candidates in the order the repository returned them', async () => {
    repository.findBatchCandidateIds.mockResolvedValue([
      { id: 'comp-a', status: 'PENDING' },
      { id: 'comp-b', status: 'BLOCKED' },
      { id: 'comp-c', status: 'PENDING' },
    ]);
    const callOrder: string[] = [];
    reconciliation.attemptRecovery.mockImplementation((id) => {
      callOrder.push(id);
      return Promise.resolve(outcome('RESOLVED_CONVERGED'));
    });
    blockedRecheck.recheckBlocked.mockImplementation((id) => {
      callOrder.push(id);
      return Promise.resolve(outcome('UNBLOCKED_PENDING'));
    });

    await service.runBatch({ now: new Date() });

    expect(callOrder).toEqual(['comp-a', 'comp-b', 'comp-c']);
  });

  it('reports a non-negative durationMs', async () => {
    const result = await service.runBatch({ now: new Date() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
