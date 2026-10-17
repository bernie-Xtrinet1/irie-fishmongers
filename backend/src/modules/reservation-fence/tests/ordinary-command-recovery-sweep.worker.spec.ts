import { readFileSync } from 'fs';
import { resolve } from 'path';
import { OrdinaryCommandRecoveryService } from '../services/ordinary-command-recovery.service';
import {
  OrdinaryCommandRecoverySweepWorker,
  OrdinaryCommandSweepWorkerOptions,
} from '../workers/ordinary-command-recovery-sweep.worker';
import { CommandSweepResult } from '../types/ordinary-invalidation-recovery.types';

describe('OrdinaryCommandRecoverySweepWorker Lifecycle & Concurrency', () => {
  let mockRecoveryService: jest.Mocked<Pick<OrdinaryCommandRecoveryService, 'sweep'>>;

  const dummySweepResult: CommandSweepResult = {
    attemptedCount: 3,
    acknowledgedCount: 2,
    unresolvedCount: 1,
    skippedBackoffCount: 0,
    errorCount: 0,
    pagesProcessed: 1,
    hasMore: false,
  };

  beforeEach(() => {
    mockRecoveryService = {
      sweep: jest.fn().mockResolvedValue(dummySweepResult),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // =========================================================================
  // GROUP 1: CONFIGURATION & VALIDATION
  // =========================================================================
  describe('Group 1: Configuration & Validation', () => {
    it('1. applies default options when no options provided', () => {
      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
      );
      expect(worker.enableScheduling).toBe(false);
      expect(worker.intervalMs).toBe(15_000);
      expect(worker.defaultLimit).toBe(20);
      expect(worker.defaultMaxPages).toBe(10);
      expect(worker.defaultWorkerId).toBe('recovery-worker');
      expect(worker.isScheduled).toBe(false);
      expect(worker.isBusy).toBe(false);
    });

    it('2. applies valid custom options', () => {
      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
        {
          enableScheduling: true,
          intervalMs: 30_000,
          limit: 50,
          maxPages: 5,
          workerId: 'custom-worker-01',
        },
      );
      expect(worker.enableScheduling).toBe(true);
      expect(worker.intervalMs).toBe(30_000);
      expect(worker.defaultLimit).toBe(50);
      expect(worker.defaultMaxPages).toBe(5);
      expect(worker.defaultWorkerId).toBe('custom-worker-01');
    });

    it.each([
      ['negative interval', { intervalMs: -100 }],
      ['zero interval', { intervalMs: 0 }],
      ['interval below 100ms', { intervalMs: 99 }],
      ['interval above 24h', { intervalMs: 86_400_001 }],
      ['fractional interval', { intervalMs: 1500.5 }],
      ['NaN interval', { intervalMs: NaN }],
      ['Infinity interval', { intervalMs: Infinity }],
      ['string interval', { intervalMs: '15000' as unknown as number }],
    ])('3. rejects invalid interval: %s', (_, opts) => {
      expect(
        () =>
          new OrdinaryCommandRecoverySweepWorker(
            mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
            opts as OrdinaryCommandSweepWorkerOptions,
          ),
      ).toThrow('INVALID_WORKER_OPTIONS');
    });

    it.each([
      ['zero limit', { limit: 0 }],
      ['negative limit', { limit: -1 }],
      ['limit above 100', { limit: 101 }],
      ['fractional limit', { limit: 20.5 }],
      ['NaN limit', { limit: NaN }],
      ['Infinity limit', { limit: Infinity }],
    ])('4. rejects invalid limit: %s', (_, opts) => {
      expect(
        () =>
          new OrdinaryCommandRecoverySweepWorker(
            mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
            opts as OrdinaryCommandSweepWorkerOptions,
          ),
      ).toThrow('INVALID_WORKER_OPTIONS');
    });

    it.each([
      ['zero maxPages', { maxPages: 0 }],
      ['negative maxPages', { maxPages: -1 }],
      ['maxPages above 1000', { maxPages: 1001 }],
      ['fractional maxPages', { maxPages: 10.5 }],
      ['NaN maxPages', { maxPages: NaN }],
      ['Infinity maxPages', { maxPages: Infinity }],
    ])('5. rejects invalid maxPages: %s', (_, opts) => {
      expect(
        () =>
          new OrdinaryCommandRecoverySweepWorker(
            mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
            opts as OrdinaryCommandSweepWorkerOptions,
          ),
      ).toThrow('INVALID_WORKER_OPTIONS');
    });

    it.each([
      ['empty workerId', { workerId: '' }],
      ['whitespace workerId', { workerId: '   ' }],
      ['illegal characters workerId', { workerId: 'worker!@#' }],
      ['workerId too long', { workerId: 'a'.repeat(129) }],
    ])('6. rejects invalid workerId: %s', (_, opts) => {
      expect(
        () =>
          new OrdinaryCommandRecoverySweepWorker(
            mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
            opts as OrdinaryCommandSweepWorkerOptions,
          ),
      ).toThrow('INVALID_WORKER_OPTIONS');
    });

    it('7. rejects invalid scheduling flag', () => {
      expect(
        () =>
          new OrdinaryCommandRecoverySweepWorker(
            mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
            { enableScheduling: 'true' as unknown as boolean },
          ),
      ).toThrow('INVALID_WORKER_OPTIONS');
    });

    it('rejects missing or undefined recovery coordinator service', () => {
      expect(
        () =>
          new OrdinaryCommandRecoverySweepWorker(
            undefined as unknown as OrdinaryCommandRecoveryService,
          ),
      ).toThrow('INVALID_WORKER_DEPENDENCIES');
    });
  });

  // =========================================================================
  // GROUP 2: DORMANCY & SCHEDULING
  // =========================================================================
  describe('Group 2: Dormancy & Scheduling', () => {
    it('8. has no active timer by default upon construction', () => {
      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
      );
      expect(worker.isScheduled).toBe(false);
    });

    it('9. does not start a timer on onModuleInit() without explicit enableScheduling=true', () => {
      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
        { enableScheduling: false },
      );
      worker.onModuleInit();
      expect(worker.isScheduled).toBe(false);
      worker.onModuleDestroy();
    });

    it('10. starts exactly one timer on onModuleInit() when enableScheduling=true', () => {
      jest.useFakeTimers();
      try {
        const worker = new OrdinaryCommandRecoverySweepWorker(
          mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
          { enableScheduling: true, intervalMs: 15_000 },
        );
        worker.onModuleInit();
        expect(worker.isScheduled).toBe(true);
        worker.onModuleDestroy();
        expect(worker.isScheduled).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('11. repeated initialization does not create duplicate timers', () => {
      jest.useFakeTimers();
      try {
        const worker = new OrdinaryCommandRecoverySweepWorker(
          mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
          { enableScheduling: true, intervalMs: 15_000 },
        );
        worker.onModuleInit();
        expect(worker.isScheduled).toBe(true);

        // Second onModuleInit call should be an idempotent no-op
        worker.onModuleInit();
        expect(worker.isScheduled).toBe(true);

        const runSweepSpy = jest.spyOn(worker, 'runSweep').mockResolvedValue({
          status: 'COMPLETED',
          result: dummySweepResult,
        });

        jest.advanceTimersByTime(15_000);
        // Should only be called once, proving there is only one timer
        expect(runSweepSpy).toHaveBeenCalledTimes(1);

        worker.onModuleDestroy();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // =========================================================================
  // GROUP 3: EXECUTION & CONCURRENCY
  // =========================================================================
  describe('Group 3: Execution & Concurrency', () => {
    it('12. manual runSweep() invokes the coordinator once with default options', async () => {
      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
      );
      const res = await worker.runSweep();

      expect(res.status).toBe('COMPLETED');
      if (res.status === 'COMPLETED') {
        expect(res.result).toEqual(dummySweepResult);
      }
      expect(mockRecoveryService.sweep).toHaveBeenCalledTimes(1);
      expect(mockRecoveryService.sweep).toHaveBeenCalledWith({
        limit: 20,
        maxPages: 10,
        workerId: 'recovery-worker',
      });
    });

    it('13. valid custom sweep options are forwarded correctly', async () => {
      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
      );
      await worker.runSweep({ limit: 40, maxPages: 2, workerId: 'caller-override' });

      expect(mockRecoveryService.sweep).toHaveBeenCalledWith({
        limit: 40,
        maxPages: 2,
        workerId: 'caller-override',
      });
    });

    it('14. normal coordinator results are returned unchanged', async () => {
      const customResult: CommandSweepResult = {
        attemptedCount: 15,
        acknowledgedCount: 10,
        unresolvedCount: 3,
        skippedBackoffCount: 2,
        errorCount: 0,
        pagesProcessed: 2,
        hasMore: true,
      };
      mockRecoveryService.sweep.mockResolvedValueOnce(customResult);

      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
      );
      const outcome = await worker.runSweep();

      expect(outcome).toEqual({
        status: 'COMPLETED',
        result: customResult,
      });
    });

    it('15. concurrent invocation returns SKIPPED_BUSY', async () => {
      let resolveSweep!: (val: CommandSweepResult) => void;
      const pendingPromise = new Promise<CommandSweepResult>((resolve) => {
        resolveSweep = resolve;
      });
      mockRecoveryService.sweep.mockReturnValueOnce(pendingPromise);

      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
      );

      // Start first sweep (will remain pending)
      const firstCall = worker.runSweep();
      expect(worker.isBusy).toBe(true);

      // Second invocation while first is in-flight
      const secondCall = await worker.runSweep();
      expect(secondCall).toEqual({ status: 'SKIPPED_BUSY' });

      // Complete the first sweep
      resolveSweep(dummySweepResult);
      const firstResult = await firstCall;

      expect(firstResult).toEqual({
        status: 'COMPLETED',
        result: dummySweepResult,
      });
      expect(worker.isBusy).toBe(false);
    });

    it('16. busy execution does not call the coordinator again', async () => {
      let resolveSweep!: (val: CommandSweepResult) => void;
      const pendingPromise = new Promise<CommandSweepResult>((resolve) => {
        resolveSweep = resolve;
      });
      mockRecoveryService.sweep.mockReturnValueOnce(pendingPromise);

      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
      );

      const firstCall = worker.runSweep();
      const secondCall = await worker.runSweep();

      expect(secondCall.status).toBe('SKIPPED_BUSY');
      expect(mockRecoveryService.sweep).toHaveBeenCalledTimes(1);

      resolveSweep(dummySweepResult);
      await firstCall;
    });

    it('17. isBusy resets to false after successful completion', async () => {
      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
      );
      expect(worker.isBusy).toBe(false);

      await worker.runSweep();
      expect(worker.isBusy).toBe(false);
    });

    it('18. isBusy resets to false after coordinator failure', async () => {
      mockRecoveryService.sweep.mockRejectedValueOnce(new Error('DATABASE_CONNECTION_LOST'));

      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
      );

      const outcome = await worker.runSweep();
      expect(outcome.status).toBe('FAILED');
      expect(worker.isBusy).toBe(false);
    });
  });

  // =========================================================================
  // GROUP 4: ERROR CONTAINMENT
  // =========================================================================
  describe('Group 4: Error Containment', () => {
    it('19. coordinator rejection returns FAILED with RECOVERY_SWEEP_FAILED code', async () => {
      mockRecoveryService.sweep.mockRejectedValueOnce(new Error('PG_QUERY_TIMEOUT'));

      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
      );

      const outcome = await worker.runSweep();
      expect(outcome).toEqual({
        status: 'FAILED',
        errorCode: 'RECOVERY_SWEEP_FAILED',
      });
    });

    it('20. no unhandled promise rejection occurs when coordinator rejects', async () => {
      mockRecoveryService.sweep.mockRejectedValueOnce(new Error('FATAL_INFRASTRUCTURE_FAILURE'));

      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
      );

      // runSweep must resolve cleanly without throwing
      await expect(worker.runSweep()).resolves.toEqual({
        status: 'FAILED',
        errorCode: 'RECOVERY_SWEEP_FAILED',
      });
    });

    it('21. sensitive error information is not exposed through public results', async () => {
      mockRecoveryService.sweep.mockRejectedValueOnce(
        new Error('CONFIDENTIAL_AUTH_TOKEN_EXPIRED_key_12345'),
      );

      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
      );

      const outcome = await worker.runSweep();
      expect(outcome).toEqual({
        status: 'FAILED',
        errorCode: 'RECOVERY_SWEEP_FAILED',
      });
      // The return object must not contain the sensitive error text
      expect(JSON.stringify(outcome)).not.toContain('CONFIDENTIAL_AUTH_TOKEN');
    });
  });

  // =========================================================================
  // GROUP 5: SHUTDOWN & IN-FLIGHT SEMANTICS
  // =========================================================================
  describe('Group 5: Shutdown & In-Flight Semantics', () => {
    it('22. timer is cleared during destruction', () => {
      jest.useFakeTimers();
      try {
        const worker = new OrdinaryCommandRecoverySweepWorker(
          mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
          { enableScheduling: true, intervalMs: 15_000 },
        );
        worker.onModuleInit();
        expect(worker.isScheduled).toBe(true);

        worker.onModuleDestroy();
        expect(worker.isScheduled).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('23. repeated destruction is safe and idempotent', () => {
      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
        { enableScheduling: true },
      );
      worker.onModuleInit();
      expect(() => {
        worker.onModuleDestroy();
        worker.onModuleDestroy();
      }).not.toThrow();
      expect(worker.isScheduled).toBe(false);
    });

    it('24. manual execution after shutdown returns STOPPED', async () => {
      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
      );
      worker.onModuleDestroy();

      const outcome = await worker.runSweep();
      expect(outcome).toEqual({ status: 'STOPPED' });
      expect(mockRecoveryService.sweep).not.toHaveBeenCalled();
    });

    it('25. scheduled execution cannot begin after shutdown', () => {
      jest.useFakeTimers();
      try {
        const worker = new OrdinaryCommandRecoverySweepWorker(
          mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
          { enableScheduling: true, intervalMs: 15_000 },
        );
        worker.onModuleDestroy();

        // Calling onModuleInit after shutdown must not start a timer
        worker.onModuleInit();
        expect(worker.isScheduled).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('26. an already running sweep is allowed to finish naturally during shutdown', async () => {
      let resolveSweep!: (val: CommandSweepResult) => void;
      const pendingPromise = new Promise<CommandSweepResult>((resolve) => {
        resolveSweep = resolve;
      });
      mockRecoveryService.sweep.mockReturnValueOnce(pendingPromise);

      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
      );

      // Start sweep
      const sweepPromise = worker.runSweep();
      expect(worker.isBusy).toBe(true);

      // Destroy while sweep is in-flight
      worker.onModuleDestroy();
      expect(worker.isScheduled).toBe(false);

      // Complete in-flight sweep
      resolveSweep(dummySweepResult);
      const outcome = await sweepPromise;

      // The in-flight sweep finishes and delivers its outcome to its caller
      expect(outcome).toEqual({
        status: 'COMPLETED',
        result: dummySweepResult,
      });

      // Subsequent sweep is blocked as STOPPED
      const nextCall = await worker.runSweep();
      expect(nextCall).toEqual({ status: 'STOPPED' });
    });

    it('27. shutdown does not create a second sweep', () => {
      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
      );
      worker.onModuleDestroy();
      expect(mockRecoveryService.sweep).not.toHaveBeenCalled();
    });

    it('28. shutdown does not restart a timer', () => {
      const worker = new OrdinaryCommandRecoverySweepWorker(
        mockRecoveryService as unknown as OrdinaryCommandRecoveryService,
        { enableScheduling: true },
      );
      worker.onModuleDestroy();
      worker.onModuleInit();
      expect(worker.isScheduled).toBe(false);
    });
  });

  // =========================================================================
  // GROUP 6: ARCHITECTURAL BOUNDARIES & ISOLATION
  // =========================================================================
  describe('Group 6: Architectural Boundaries & Isolation', () => {
    it('29. worker class has no @Injectable() decorator in source', () => {
      const workerPath = resolve(
        __dirname,
        '../workers/ordinary-command-recovery-sweep.worker.ts',
      );
      const source = readFileSync(workerPath, 'utf8');
      expect(source).not.toContain('@Injectable');
    });

    it('30. worker is absent from AppModule', () => {
      const appModulePath = resolve(__dirname, '../../../app.module.ts');
      const source = readFileSync(appModulePath, 'utf8');
      expect(source).not.toContain('OrdinaryCommandRecoverySweepWorker');
    });

    it('31. worker is absent from ReservationFenceModule', () => {
      const fenceModulePath = resolve(__dirname, '../reservation-fence.module.ts');
      const source = readFileSync(fenceModulePath, 'utf8');
      expect(source).not.toContain('OrdinaryCommandRecoverySweepWorker');
    });

    it('32. worker does not directly import or instantiate OrdinaryCommandClosureService', () => {
      const workerPath = resolve(
        __dirname,
        '../workers/ordinary-command-recovery-sweep.worker.ts',
      );
      const source = readFileSync(workerPath, 'utf8');
      expect(source).not.toContain('OrdinaryCommandClosureService');
    });

    it('33. worker does not call physical dispatch or execution methods', () => {
      const workerPath = resolve(
        __dirname,
        '../workers/ordinary-command-recovery-sweep.worker.ts',
      );
      const source = readFileSync(workerPath, 'utf8');
      expect(source).not.toMatch(
        /\.claim\(|\.execute\(|\.initialize\(|\.recordDispatch\(|\.promote\(|\.issue\(/,
      );
    });

    it('34. existing closure isolation restrictions remain intact', () => {
      for (const rel of [
        '../reservation-fence.module.ts',
        '../../inventory/inventory.module.ts',
        '../../../app.module.ts',
      ]) {
        const fileContent = readFileSync(resolve(__dirname, rel), 'utf8');
        expect(fileContent).not.toContain('OrdinaryCommandClosureService');
      }
    });
  });
});
