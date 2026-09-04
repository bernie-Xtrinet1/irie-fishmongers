import { PaymentReconciliationBatchService } from './payment-reconciliation-batch.service';
import { PaymentReconciliationSchedulerService } from './payment-reconciliation-scheduler.service';

type MockBatchService = jest.Mocked<
  Pick<PaymentReconciliationBatchService, 'runBatch'>
>;

type LoggerMockFn = jest.Mock<void, unknown[]>;
type MockLogger = {
  warn: LoggerMockFn;
  error: LoggerMockFn;
  log: LoggerMockFn;
};

function emptyBatchResult() {
  return {
    ok: true as const,
    result: {
      candidatesFound: 0,
      attempted: 0,
      pending: 0,
      paid: 0,
      failed: 0,
      skipped: 0,
      providerReferenceMismatch: 0,
      staleClaim: 0,
      errors: [],
      durationMs: 0,
    },
  };
}

describe('PaymentReconciliationSchedulerService.runScheduledBatch', () => {
  let batchService: MockBatchService;
  let service: PaymentReconciliationSchedulerService;
  let logger: MockLogger;

  beforeEach(() => {
    batchService = {
      runBatch: jest.fn().mockResolvedValue(emptyBatchResult()),
    };

    service = new PaymentReconciliationSchedulerService(
      batchService as unknown as PaymentReconciliationBatchService,
    );

    logger = (service as unknown as { logger: MockLogger }).logger;
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  });

  it('calls the reconciliation batch exactly once on a normal tick', async () => {
    await service.runScheduledBatch();

    expect(batchService.runBatch).toHaveBeenCalledTimes(1);
  });

  it('passes one valid now value and two five-minute stale cutoffs', async () => {
    await service.runScheduledBatch();

    const [input] = batchService.runBatch.mock.calls[0]!;

    expect(input.now).toBeInstanceOf(Date);
    expect(input.candidateStaleBefore).toBeInstanceOf(Date);
    expect(input.claimStaleBefore).toBeInstanceOf(Date);

    expect(
      input.now.getTime() - input.candidateStaleBefore.getTime(),
    ).toBe(5 * 60 * 1000);

    expect(
      input.now.getTime() - input.claimStaleBefore.getTime(),
    ).toBe(5 * 60 * 1000);
  });

  it('derives both stale cutoffs from the same now value', async () => {
    await service.runScheduledBatch();

    const [input] = batchService.runBatch.mock.calls[0]!;

    expect(input.candidateStaleBefore.getTime()).toBe(
      input.claimStaleBefore.getTime(),
    );
  });

  it('does not supply an explicit batch limit', async () => {
    await service.runScheduledBatch();

    const [input] = batchService.runBatch.mock.calls[0]!;

    expect(input).not.toHaveProperty('limit');
  });

  it('skips an overlapping second local invocation', async () => {
    let releaseFirst: () => void = () => undefined;

    batchService.runBatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(emptyBatchResult());
        }),
    );

    const firstRun = service.runScheduledBatch();
    await service.runScheduledBatch();

    expect(batchService.runBatch).toHaveBeenCalledTimes(1);

    releaseFirst();
    await firstRun;
  });

  it('logs a warning when an overlapping local invocation is skipped', async () => {
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

  it('clears the running guard after a successful run', async () => {
    await service.runScheduledBatch();
    await service.runScheduledBatch();

    expect(batchService.runBatch).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('clears the running guard after a thrown exception', async () => {
    batchService.runBatch
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(emptyBatchResult());

    await service.runScheduledBatch();
    await service.runScheduledBatch();

    expect(batchService.runBatch).toHaveBeenCalledTimes(2);
  });

  it('sanitizes thrown error messages before logging', async () => {
    batchService.runBatch.mockRejectedValue(
      new Error('Bearer abc123 leaked'),
    );

    await service.runScheduledBatch();

    expect(logger.error).toHaveBeenCalledWith(
      'Payment reconciliation batch run threw unexpectedly',
      expect.objectContaining({
        message: 'Bearer [REDACTED] leaked',
      }),
    );
  });

  it('handles non-Error thrown values safely', async () => {
    batchService.runBatch.mockRejectedValue('ECONNRESET');

    await service.runScheduledBatch();

    expect(logger.error).toHaveBeenCalledWith(
      'Payment reconciliation batch run threw unexpectedly',
      expect.objectContaining({
        message: 'ECONNRESET',
      }),
    );
  });

  it('does not expose a raw bearer secret in logger arguments', async () => {
    batchService.runBatch.mockRejectedValue(
      new Error('Bearer abc123 leaked'),
    );

    await service.runScheduledBatch();

    const allCalls = [
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
      ...logger.log.mock.calls,
    ];

    expect(JSON.stringify(allCalls)).not.toContain('abc123');
  });

  it('logs INVALID_INPUT as an internal invariant failure', async () => {
    batchService.runBatch.mockResolvedValue({
      ok: false,
      code: 'INVALID_INPUT',
      field: 'claimStaleBefore',
      reason: 'claimStaleBefore must be earlier than now',
    });

    await service.runScheduledBatch();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('internal invariant failure'),
      expect.objectContaining({
        code: 'INVALID_INPUT',
        field: 'claimStaleBefore',
      }),
    );
  });

  it('does not re-log the successful batch aggregate', async () => {
    await service.runScheduledBatch();

    expect(logger.log).not.toHaveBeenCalled();
  });

  it('depends only on PaymentReconciliationBatchService', () => {
    expect(PaymentReconciliationSchedulerService.length).toBe(1);
  });
});
