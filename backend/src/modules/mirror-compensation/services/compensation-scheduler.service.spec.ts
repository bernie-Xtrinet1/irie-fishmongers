import { CompensationBatchService } from './compensation-batch.service';
import { CompensationSchedulerService } from './compensation-scheduler.service';
import { RunBatchResult } from '../types/compensation-batch.types';

// Phase 16A.0-C4.5. Mocks CompensationBatchService entirely - this suite
// verifies only the scheduler's own cadence-independent logic (overlap
// guard, error handling, logging). No fake-timer @Cron-firing proof -
// matching ComplianceScoreCronService/SLABreachDetectionService's own
// established convention of invoking the decorated method directly.

type MockBatchService = jest.Mocked<Pick<CompensationBatchService, 'runBatch'>>;
type LoggerMockFn = jest.Mock<void, unknown[]>;
type MockLogger = { warn: LoggerMockFn; error: LoggerMockFn; log: LoggerMockFn };

function emptyBatchResult(): RunBatchResult {
  return {
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
      durationMs: 0,
    },
  };
}

describe('CompensationSchedulerService.runScheduledBatch', () => {
  let batchService: MockBatchService;
  let service: CompensationSchedulerService;
  let logger: MockLogger;

  beforeEach(() => {
    batchService = { runBatch: jest.fn().mockResolvedValue(emptyBatchResult()) };
    service = new CompensationSchedulerService(batchService as unknown as CompensationBatchService);
    logger = (service as unknown as { logger: MockLogger }).logger;
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  });

  it('1. a normal tick calls runBatch exactly once', async () => {
    await service.runScheduledBatch();
    expect(batchService.runBatch).toHaveBeenCalledTimes(1);
  });

  it('2. the runBatch argument contains a valid Date', async () => {
    await service.runScheduledBatch();
    const [input] = batchService.runBatch.mock.calls[0]!;
    expect(input.now).toBeInstanceOf(Date);
    expect(Number.isNaN(input.now.getTime())).toBe(false);
  });

  it('3. no limit property is supplied', async () => {
    await service.runScheduledBatch();
    const [input] = batchService.runBatch.mock.calls[0]!;
    expect(input).not.toHaveProperty('limit');
  });

  it('4. an overlapping second local invocation is skipped', async () => {
    let releaseFirst: () => void = () => undefined;
    batchService.runBatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(emptyBatchResult());
        }),
    );

    const firstRun = service.runScheduledBatch();
    await service.runScheduledBatch(); // overlapping second call

    expect(batchService.runBatch).toHaveBeenCalledTimes(1);

    releaseFirst();
    await firstRun;
  });

  it('5. the overlap skip logs a warning', async () => {
    let releaseFirst: () => void = () => undefined;
    batchService.runBatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(emptyBatchResult());
        }),
    );

    const firstRun = service.runScheduledBatch();
    await service.runScheduledBatch();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('previous local run still executing'),
    );

    releaseFirst();
    await firstRun;
  });

  it('6. the running flag clears after a successful run', async () => {
    await service.runScheduledBatch();
    await service.runScheduledBatch();

    expect(batchService.runBatch).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('7. the running flag clears after a thrown exception', async () => {
    batchService.runBatch.mockRejectedValueOnce(new Error('boom'));

    await service.runScheduledBatch();

    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('8. a later run succeeds after a previous exception', async () => {
    batchService.runBatch.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(emptyBatchResult());

    await service.runScheduledBatch();
    await service.runScheduledBatch();

    expect(batchService.runBatch).toHaveBeenCalledTimes(2);
    // The second call was not skipped as an overlap - proving `running`
    // was reset to false after the first call's exception.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('9. a thrown exception is sanitized before logging', async () => {
    batchService.runBatch.mockRejectedValue(new Error('Bearer abc123 leaked'));

    await service.runScheduledBatch();

    expect(logger.error).toHaveBeenCalledWith(
      'Compensation batch run threw unexpectedly',
      expect.objectContaining({ message: 'Bearer [REDACTED] leaked' }),
    );
  });

  it('9b. a non-Error thrown value is still converted to a sanitized string', async () => {
    batchService.runBatch.mockRejectedValue('ECONNRESET');

    await service.runScheduledBatch();

    expect(logger.error).toHaveBeenCalledWith(
      'Compensation batch run threw unexpectedly',
      expect.objectContaining({ message: 'ECONNRESET' }),
    );
  });

  it('10. no raw secret appears anywhere in the logger call arguments', async () => {
    batchService.runBatch.mockRejectedValue(new Error('Bearer abc123 leaked'));

    await service.runScheduledBatch();

    const allCalls = [...logger.warn.mock.calls, ...logger.error.mock.calls, ...logger.log.mock.calls];
    expect(JSON.stringify(allCalls)).not.toContain('abc123');
  });

  it('11. an INVALID_INPUT batch result logs an internal invariant error', async () => {
    batchService.runBatch.mockResolvedValue({
      ok: false,
      code: 'INVALID_INPUT',
      field: 'now',
      reason: 'now must be a valid Date',
    });

    await service.runScheduledBatch();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('internal invariant failure'),
      expect.objectContaining({ code: 'INVALID_INPUT', field: 'now', reason: 'now must be a valid Date' }),
    );
  });

  it('12. the scheduler never re-logs the batch aggregate itself', async () => {
    await service.runScheduledBatch();

    expect(logger.log).not.toHaveBeenCalled();
  });

  it('13. no mode-service (or any other) dependency exists beyond CompensationBatchService', () => {
    expect(CompensationSchedulerService.length).toBe(1);
  });
});
