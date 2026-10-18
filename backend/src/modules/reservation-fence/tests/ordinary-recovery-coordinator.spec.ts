import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  OrdinaryRecoveryCoordinatorService,
  CoordinatedRecoveryOptions,
  OrdinaryRecoveryCoordinatorOptions,
} from '../services/ordinary-recovery-coordinator.service';
import {
  OrdinaryCommandRecoverySweepWorker,
  OrdinaryCommandWorkerRunResult,
} from '../workers/ordinary-command-recovery-sweep.worker';
import { OrdinaryRecoverySweepWorker } from '../workers/ordinary-recovery-sweep.worker';
import {
  CommandSweepOptions,
  CommandSweepResult,
  SweepResult,
} from '../types/ordinary-invalidation-recovery.types';

describe('OrdinaryRecoveryCoordinatorService (Phase C.3.4 - Corrected Contract)', () => {
  let mockCommandWorker: {
    runSweep: jest.Mock<Promise<OrdinaryCommandWorkerRunResult>, [CommandSweepOptions?]>;
    onModuleDestroy?: jest.Mock<void, []>;
    isBusy?: boolean;
    isScheduled?: boolean;
  };

  let mockInvalidationWorker: {
    runSweep: jest.Mock<Promise<SweepResult>, [number?]>;
    onModuleDestroy?: jest.Mock<void, []>;
    isBusy?: boolean;
    isScheduled?: boolean;
  };

  const sampleCommandResult: CommandSweepResult = {
    attemptedCount: 2,
    acknowledgedCount: 2,
    unresolvedCount: 0,
    skippedBackoffCount: 1,
    errorCount: 0,
    pagesProcessed: 1,
    hasMore: false,
  };

  const sampleInvalidationResult: SweepResult = {
    bootstrappedCount: 1,
    reconciledCount: 2,
    replayedCount: 1,
    readinessCount: 1,
    blockedCount: 0,
    errors: [],
  };

  beforeEach(() => {
    mockCommandWorker = {
      runSweep: jest.fn<Promise<OrdinaryCommandWorkerRunResult>, [CommandSweepOptions?]>().mockResolvedValue({
        status: 'COMPLETED',
        result: sampleCommandResult,
      }),
      onModuleDestroy: jest.fn<void, []>(),
      isBusy: false,
      isScheduled: false,
    };

    mockInvalidationWorker = {
      runSweep: jest.fn<Promise<SweepResult>, [number?]>().mockResolvedValue({
        ...sampleInvalidationResult,
      }),
      onModuleDestroy: jest.fn<void, []>(),
      isBusy: false,
      isScheduled: false,
    };
  });

  describe('1. Instantiation and Dependency Validation', () => {
    it('instantiates cleanly with valid worker dependencies and default options', () => {
      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      expect(coordinator).toBeDefined();
      expect(coordinator.defaultCommandLimit).toBe(20);
      expect(coordinator.defaultCommandMaxPages).toBe(10);
      expect(coordinator.defaultInvalidationLimit).toBe(20);
      expect(coordinator.defaultWorkerId).toBe('recovery-coordinator');
      expect(coordinator.defaultContinueOnCommandFailure).toBe(true);
      expect(coordinator.isBusy).toBe(false);
      expect(coordinator.isStopped).toBe(false);
    });

    it('instantiates with custom valid options', () => {
      const options: OrdinaryRecoveryCoordinatorOptions = {
        defaultCommandLimit: 50,
        defaultCommandMaxPages: 5,
        defaultInvalidationLimit: 30,
        defaultWorkerId: 'custom-coordinator',
        defaultContinueOnCommandFailure: false,
      };

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
        options,
      );

      expect(coordinator.defaultCommandLimit).toBe(50);
      expect(coordinator.defaultCommandMaxPages).toBe(5);
      expect(coordinator.defaultInvalidationLimit).toBe(30);
      expect(coordinator.defaultWorkerId).toBe('custom-coordinator');
      expect(coordinator.defaultContinueOnCommandFailure).toBe(false);
    });

    it('rejects missing or non-callable commandWorker', () => {
      expect(
        () =>
          new OrdinaryRecoveryCoordinatorService(
            null as unknown as OrdinaryCommandRecoverySweepWorker,
            mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
          ),
      ).toThrow('INVALID_COORDINATOR_DEPENDENCIES');

      expect(
        () =>
          new OrdinaryRecoveryCoordinatorService(
            {} as unknown as OrdinaryCommandRecoverySweepWorker,
            mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
          ),
      ).toThrow('INVALID_COORDINATOR_DEPENDENCIES');
    });

    it('rejects missing or non-callable invalidationWorker', () => {
      expect(
        () =>
          new OrdinaryRecoveryCoordinatorService(
            mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
            null as unknown as OrdinaryRecoverySweepWorker,
          ),
      ).toThrow('INVALID_COORDINATOR_DEPENDENCIES');

      expect(
        () =>
          new OrdinaryRecoveryCoordinatorService(
            mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
            {} as unknown as OrdinaryRecoverySweepWorker,
          ),
      ).toThrow('INVALID_COORDINATOR_DEPENDENCIES');
    });

    it('rejects non-object constructor options', () => {
      expect(
        () =>
          new OrdinaryRecoveryCoordinatorService(
            mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
            mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
            'invalid' as unknown as OrdinaryRecoveryCoordinatorOptions,
          ),
      ).toThrow('INVALID_COORDINATOR_OPTIONS');

      expect(
        () =>
          new OrdinaryRecoveryCoordinatorService(
            mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
            mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
            [] as unknown as OrdinaryRecoveryCoordinatorOptions,
          ),
      ).toThrow('INVALID_COORDINATOR_OPTIONS');
    });

    it('rejects invalid constructor option values', () => {
      const invalidCases: Partial<OrdinaryRecoveryCoordinatorOptions>[] = [
        { defaultCommandLimit: 0 },
        { defaultCommandLimit: 101 },
        { defaultCommandLimit: NaN },
        { defaultCommandLimit: 1.5 },
        { defaultCommandMaxPages: 0 },
        { defaultCommandMaxPages: 1001 },
        { defaultInvalidationLimit: 0 },
        { defaultInvalidationLimit: 101 },
        { defaultWorkerId: '' },
        { defaultWorkerId: 'invalid worker id!' },
        { defaultContinueOnCommandFailure: 'true' as unknown as boolean },
      ];

      for (const invalid of invalidCases) {
        expect(
          () =>
            new OrdinaryRecoveryCoordinatorService(
              mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
              mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
              invalid,
            ),
        ).toThrow('INVALID_COORDINATOR_OPTIONS');
      }
    });
  });

  describe('2. Execution Ordering & Preservation of Child Metrics', () => {
    it('executes command recovery strictly before invalidation recovery and preserves original results', async () => {
      const executionOrder: string[] = [];

      mockCommandWorker.runSweep.mockImplementation(async () => {
        executionOrder.push('COMMAND_START');
        await new Promise(r => setTimeout(r, 10));
        executionOrder.push('COMMAND_END');
        return { status: 'COMPLETED', result: sampleCommandResult };
      });

      mockInvalidationWorker.runSweep.mockImplementation(async () => {
        executionOrder.push('INVALIDATION_START');
        await new Promise(r => setTimeout(r, 5));
        executionOrder.push('INVALIDATION_END');
        return sampleInvalidationResult;
      });

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const result = await coordinator.runCoordinatedSweep();

      expect(executionOrder).toEqual([
        'COMMAND_START',
        'COMMAND_END',
        'INVALIDATION_START',
        'INVALIDATION_END',
      ]);
      expect(result.status).toBe('COMPLETED');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: { status: 'COMPLETED', result: sampleCommandResult },
      });
      expect(result.invalidation).toEqual({
        status: 'SUCCEEDED',
        result: sampleInvalidationResult,
      });
      expect(result.durationMs).toBeGreaterThanOrEqual(10);
    });

    it('preserves unresolved command metrics without alteration or fabrication', async () => {
      const metricsWithUnresolved: CommandSweepResult = {
        attemptedCount: 10,
        acknowledgedCount: 7,
        unresolvedCount: 3,
        skippedBackoffCount: 2,
        errorCount: 1,
        pagesProcessed: 3,
        hasMore: true,
      };

      mockCommandWorker.runSweep.mockResolvedValue({
        status: 'COMPLETED',
        result: metricsWithUnresolved,
      });

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('COMPLETED');
      if (result.command.status === 'SUCCEEDED') {
        expect(result.command.result).toEqual({
          status: 'COMPLETED',
          result: metricsWithUnresolved,
        });
      } else {
        throw new Error('Expected command status to be SUCCEEDED');
      }
    });
  });

  describe('3. Default and Custom Option Forwarding', () => {
    it('forwards default options when none are supplied at runtime', async () => {
      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      await coordinator.runCoordinatedSweep();

      expect(mockCommandWorker.runSweep).toHaveBeenCalledWith({
        limit: 20,
        maxPages: 10,
        workerId: 'recovery-coordinator',
      });
      expect(mockInvalidationWorker.runSweep).toHaveBeenCalledWith(20);
    });

    it('forwards custom runtime options to child workers', async () => {
      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const customOptions: CoordinatedRecoveryOptions = {
        commandSweepOptions: {
          limit: 5,
          maxPages: 2,
          workerId: 'custom-sweep-id',
        },
        invalidationLimit: 15,
        continueOnCommandFailure: true,
      };

      await coordinator.runCoordinatedSweep(customOptions);

      expect(mockCommandWorker.runSweep).toHaveBeenCalledWith({
        limit: 5,
        maxPages: 2,
        workerId: 'custom-sweep-id',
      });
      expect(mockInvalidationWorker.runSweep).toHaveBeenCalledWith(15);
    });

    it('inherits constructor defaults for omitted sweep options', async () => {
      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
        {
          defaultCommandLimit: 40,
          defaultCommandMaxPages: 8,
          defaultInvalidationLimit: 35,
          defaultWorkerId: 'configured-coord',
        },
      );

      await coordinator.runCoordinatedSweep({});

      expect(mockCommandWorker.runSweep).toHaveBeenCalledWith({
        limit: 40,
        maxPages: 8,
        workerId: 'configured-coord',
      });
      expect(mockInvalidationWorker.runSweep).toHaveBeenCalledWith(35);
    });
  });

  describe('4. Invalid Option Handling with NOT_ATTEMPTED Representation', () => {
    it('returns FAILED with explicit NOT_ATTEMPTED child results when options are invalid', async () => {
      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const invalidCases: CoordinatedRecoveryOptions[] = [
        { invalidationLimit: 0 },
        { invalidationLimit: 105 },
        { invalidationLimit: NaN },
        { invalidationLimit: 2.5 },
        { continueOnCommandFailure: 'invalid' as unknown as boolean },
        { commandSweepOptions: { limit: 0 } },
        { commandSweepOptions: { limit: 105 } },
        { commandSweepOptions: { maxPages: 0 } },
        { commandSweepOptions: { maxPages: 1001 } },
        { commandSweepOptions: { workerId: '' } },
        { commandSweepOptions: { workerId: 'has space!' } },
        'invalid' as unknown as CoordinatedRecoveryOptions,
      ];

      for (const invalid of invalidCases) {
        const result = await coordinator.runCoordinatedSweep(invalid);
        expect(result.status).toBe('FAILED');
        expect(result.command).toEqual({
          status: 'NOT_ATTEMPTED',
          reason: 'INVALID_OPTIONS',
        });
        expect(result.invalidation).toEqual({
          status: 'NOT_ATTEMPTED',
          reason: 'INVALID_OPTIONS',
        });
      }

      expect(mockCommandWorker.runSweep).not.toHaveBeenCalled();
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
    });
  });

  describe('5. Command Failure Continuation Policy', () => {
    it('continues to invalidation recovery on command failure when continueOnCommandFailure is true (default)', async () => {
      mockCommandWorker.runSweep.mockResolvedValue({
        status: 'FAILED',
        errorCode: 'RECOVERY_SWEEP_FAILED',
      });

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const result = await coordinator.runCoordinatedSweep();

      expect(mockCommandWorker.runSweep).toHaveBeenCalledTimes(1);
      expect(mockInvalidationWorker.runSweep).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: {
          status: 'FAILED',
          errorCode: 'RECOVERY_SWEEP_FAILED',
        },
      });
      expect(result.invalidation).toEqual({
        status: 'SUCCEEDED',
        result: sampleInvalidationResult,
      });
    });

    it('halts and sets invalidation to NOT_ATTEMPTED on command failure when continueOnCommandFailure is false', async () => {
      mockCommandWorker.runSweep.mockResolvedValue({
        status: 'FAILED',
        errorCode: 'RECOVERY_SWEEP_FAILED',
      });

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const result = await coordinator.runCoordinatedSweep({
        continueOnCommandFailure: false,
      });

      expect(mockCommandWorker.runSweep).toHaveBeenCalledTimes(1);
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: {
          status: 'FAILED',
          errorCode: 'RECOVERY_SWEEP_FAILED',
        },
      });
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_FAILURE_CONTINUATION_DISABLED',
      });
    });

    it('halts when command worker throws and continueOnCommandFailure is false', async () => {
      mockCommandWorker.runSweep.mockRejectedValue(new Error('DATABASE_CONNECTION_RESET'));

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const result = await coordinator.runCoordinatedSweep({
        continueOnCommandFailure: false,
      });

      expect(mockCommandWorker.runSweep).toHaveBeenCalledTimes(1);
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'FAILED',
        errorCode: 'COMMAND_WORKER_THREW',
      });
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_FAILURE_CONTINUATION_DISABLED',
      });
    });

    it('continues when command worker throws and continueOnCommandFailure is true', async () => {
      mockCommandWorker.runSweep.mockRejectedValue(new Error('DATABASE_CONNECTION_RESET'));

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const result = await coordinator.runCoordinatedSweep({
        continueOnCommandFailure: true,
      });

      expect(mockCommandWorker.runSweep).toHaveBeenCalledTimes(1);
      expect(mockInvalidationWorker.runSweep).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'FAILED',
        errorCode: 'COMMAND_WORKER_THREW',
      });
      expect(result.invalidation).toEqual({
        status: 'SUCCEEDED',
        result: sampleInvalidationResult,
      });
    });
  });

  describe('6. Busy and Stopped Child Results', () => {
    it('handles command worker SKIPPED_BUSY with continuation true', async () => {
      mockCommandWorker.runSweep.mockResolvedValue({
        status: 'SKIPPED_BUSY',
      });

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const result = await coordinator.runCoordinatedSweep({ continueOnCommandFailure: true });

      expect(mockInvalidationWorker.runSweep).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: { status: 'SKIPPED_BUSY' },
      });
      expect(result.invalidation).toEqual({
        status: 'SUCCEEDED',
        result: sampleInvalidationResult,
      });
    });

    it('halts on command worker SKIPPED_BUSY when continueOnCommandFailure is false', async () => {
      mockCommandWorker.runSweep.mockResolvedValue({
        status: 'SKIPPED_BUSY',
      });

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const result = await coordinator.runCoordinatedSweep({ continueOnCommandFailure: false });

      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: { status: 'SKIPPED_BUSY' },
      });
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_FAILURE_CONTINUATION_DISABLED',
      });
    });

    it('handles command worker STOPPED when continueOnCommandFailure is false', async () => {
      mockCommandWorker.runSweep.mockResolvedValue({
        status: 'STOPPED',
      });

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const result = await coordinator.runCoordinatedSweep({ continueOnCommandFailure: false });

      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: { status: 'STOPPED' },
      });
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_FAILURE_CONTINUATION_DISABLED',
      });
    });

    it('handles invalidation worker SWEEP_ALREADY_IN_PROGRESS cleanly', async () => {
      const busyInvalidationResult: SweepResult = {
        bootstrappedCount: 0,
        reconciledCount: 0,
        replayedCount: 0,
        readinessCount: 0,
        blockedCount: 0,
        errors: ['SWEEP_ALREADY_IN_PROGRESS'],
      };

      mockInvalidationWorker.runSweep.mockResolvedValue(busyInvalidationResult);

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('COMPLETED');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: { status: 'COMPLETED', result: sampleCommandResult },
      });
      expect(result.invalidation).toEqual({
        status: 'SUCCEEDED',
        result: busyInvalidationResult,
      });
    });
  });

  describe('7. Invalidation Failure and Combined Failure Handling', () => {
    it('contains invalidation worker exception and reports PARTIAL with FAILED invalidation child', async () => {
      mockInvalidationWorker.runSweep.mockRejectedValue(new Error('DATABASE_CONNECTION_LOST'));

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: { status: 'COMPLETED', result: sampleCommandResult },
      });
      expect(result.invalidation).toEqual({
        status: 'FAILED',
        errorCode: 'INVALIDATION_WORKER_THREW',
      });
    });

    it('reports FAILED when both command and invalidation workers fail', async () => {
      mockCommandWorker.runSweep.mockResolvedValue({
        status: 'FAILED',
        errorCode: 'COMMAND_SWEEP_FAILED',
      });
      mockInvalidationWorker.runSweep.mockRejectedValue(new Error('POSTGRES_DISCONNECTED'));

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const result = await coordinator.runCoordinatedSweep({ continueOnCommandFailure: true });

      expect(result.status).toBe('FAILED');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: { status: 'FAILED', errorCode: 'COMMAND_SWEEP_FAILED' },
      });
      expect(result.invalidation).toEqual({
        status: 'FAILED',
        errorCode: 'INVALIDATION_WORKER_THREW',
      });
    });

    it('reports FAILED when command throws and invalidation throws', async () => {
      mockCommandWorker.runSweep.mockRejectedValue(new Error('FATAL_COMMAND_CORRUPTION'));
      mockInvalidationWorker.runSweep.mockRejectedValue(new Error('POSTGRES_DISCONNECTED'));

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const result = await coordinator.runCoordinatedSweep({ continueOnCommandFailure: true });

      expect(result.status).toBe('FAILED');
      expect(result.command).toEqual({
        status: 'FAILED',
        errorCode: 'COMMAND_WORKER_THREW',
      });
      expect(result.invalidation).toEqual({
        status: 'FAILED',
        errorCode: 'INVALIDATION_WORKER_THREW',
      });
    });
  });

  describe('8. Concurrency Lockout (Process-Local Busy Guard)', () => {
    it('rejects concurrent sweeps with SKIPPED_BUSY and NOT_ATTEMPTED child results', async () => {
      let resolveFirst!: () => void;
      const firstRunning = new Promise<void>(r => {
        resolveFirst = r;
      });

      mockCommandWorker.runSweep.mockImplementation(async () => {
        await firstRunning;
        return { status: 'COMPLETED', result: sampleCommandResult };
      });

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const firstPromise = coordinator.runCoordinatedSweep();
      expect(coordinator.isBusy).toBe(true);

      const secondResult = await coordinator.runCoordinatedSweep();
      expect(secondResult).toEqual({
        status: 'SKIPPED_BUSY',
        command: { status: 'NOT_ATTEMPTED', reason: 'COORDINATOR_BUSY' },
        invalidation: { status: 'NOT_ATTEMPTED', reason: 'COORDINATOR_BUSY' },
        durationMs: 0,
      });

      resolveFirst();
      const firstResult = await firstPromise;
      expect(firstResult.status).toBe('COMPLETED');
      expect(coordinator.isBusy).toBe(false);

      // Subsequent call runs normally
      const thirdResult = await coordinator.runCoordinatedSweep();
      expect(thirdResult.status).toBe('COMPLETED');
    });

    it('releases busy guard cleanly even after command failure', async () => {
      mockCommandWorker.runSweep.mockRejectedValueOnce(new Error('TRANSIENT_FAILURE'));

      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      const failedResult = await coordinator.runCoordinatedSweep({
        continueOnCommandFailure: false,
      });
      expect(failedResult.status).toBe('PARTIAL');
      expect(coordinator.isBusy).toBe(false);

      // Subsequent call succeeds
      mockCommandWorker.runSweep.mockResolvedValueOnce({
        status: 'COMPLETED',
        result: sampleCommandResult,
      });
      const successResult = await coordinator.runCoordinatedSweep();
      expect(successResult.status).toBe('COMPLETED');
      expect(coordinator.isBusy).toBe(false);
    });
  });

  describe('9. Shutdown Races and Teardown Lifecycle', () => {
    it('immediately returns STOPPED if coordinator was destroyed before runCoordinatedSweep', async () => {
      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      coordinator.onModuleDestroy();
      expect(coordinator.isStopped).toBe(true);

      const result = await coordinator.runCoordinatedSweep();
      expect(result).toEqual({
        status: 'STOPPED',
        command: { status: 'NOT_ATTEMPTED', reason: 'COORDINATOR_STOPPED' },
        invalidation: { status: 'NOT_ATTEMPTED', reason: 'COORDINATOR_STOPPED' },
        durationMs: 0,
      });

      expect(mockCommandWorker.runSweep).not.toHaveBeenCalled();
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
    });

    it('prevents starting invalidation recovery if shutdown occurs between child invocations', async () => {
      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      mockCommandWorker.runSweep.mockImplementation(() => {
        // Shutdown triggered while command recovery is in-flight
        coordinator.onModuleDestroy();
        return Promise.resolve({ status: 'COMPLETED', result: sampleCommandResult });
      });

      const result = await coordinator.runCoordinatedSweep();

      expect(mockCommandWorker.runSweep).toHaveBeenCalledTimes(1);
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
      expect(result.status).toBe('STOPPED');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: {
          status: 'COMPLETED',
          result: sampleCommandResult,
        },
      });
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COORDINATOR_STOPPED_BEFORE_INVALIDATION',
      });
    });

    it('handles shutdown immediately after invalidation recovery settles', async () => {
      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      mockInvalidationWorker.runSweep.mockImplementation(() => {
        coordinator.onModuleDestroy();
        return Promise.resolve(sampleInvalidationResult);
      });

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('STOPPED');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: { status: 'COMPLETED', result: sampleCommandResult },
      });
      expect(result.invalidation).toEqual({
        status: 'SUCCEEDED',
        result: sampleInvalidationResult,
      });
    });
  });

  describe('10. Borrowed-Worker Lifecycle Independence', () => {
    it('does NOT invoke onModuleDestroy on borrowed workers when coordinator is destroyed', () => {
      const coordinator = new OrdinaryRecoveryCoordinatorService(
        mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
        mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      );

      coordinator.onModuleDestroy();

      expect(coordinator.isStopped).toBe(true);
      expect(mockCommandWorker.onModuleDestroy).not.toHaveBeenCalled();
      expect(mockInvalidationWorker.onModuleDestroy).not.toHaveBeenCalled();
    });
  });

  describe('11. Architectural Isolation & Dormancy Guarantees', () => {
    it('coordinator source does NOT use @Injectable()', () => {
      const filePath = resolve(
        __dirname,
        '../services/ordinary-recovery-coordinator.service.ts',
      );
      const source = readFileSync(filePath, 'utf8');
      expect(source).not.toContain('@Injectable');
    });

    it('coordinator is absent from AppModule', () => {
      const filePath = resolve(__dirname, '../../../app.module.ts');
      const source = readFileSync(filePath, 'utf8');
      expect(source).not.toContain('OrdinaryRecoveryCoordinatorService');
    });

    it('coordinator is absent from ReservationFenceModule', () => {
      const filePath = resolve(__dirname, '../reservation-fence.module.ts');
      const source = readFileSync(filePath, 'utf8');
      expect(source).not.toContain('OrdinaryRecoveryCoordinatorService');
    });

    it('coordinator is absent from InventoryModule', () => {
      const filePath = resolve(__dirname, '../../inventory/inventory.module.ts');
      const source = readFileSync(filePath, 'utf8');
      expect(source).not.toContain('OrdinaryRecoveryCoordinatorService');
    });

    it('coordinator does NOT import or instantiate OrdinaryCommandClosureService', () => {
      const filePath = resolve(
        __dirname,
        '../services/ordinary-recovery-coordinator.service.ts',
      );
      const source = readFileSync(filePath, 'utf8');
      expect(source).not.toContain('OrdinaryCommandClosureService');
    });

    it('coordinator does NOT call physical methods or mutation authority', () => {
      const filePath = resolve(
        __dirname,
        '../services/ordinary-recovery-coordinator.service.ts',
      );
      const source = readFileSync(filePath, 'utf8');
      expect(source).not.toMatch(
        /\.observe\(|\.execute\(|\.claim\(|\.initialize\(|\.recordDispatch\(|\.promote\(|\.issue\(/,
      );
    });

    it('coordinator does NOT import PrismaService or RedisService', () => {
      const filePath = resolve(
        __dirname,
        '../services/ordinary-recovery-coordinator.service.ts',
      );
      const source = readFileSync(filePath, 'utf8');
      expect(source).not.toContain('PrismaService');
      expect(source).not.toContain('RedisService');
    });

    it('coordinator does NOT import @nestjs/schedule or use timers', () => {
      const filePath = resolve(
        __dirname,
        '../services/ordinary-recovery-coordinator.service.ts',
      );
      const source = readFileSync(filePath, 'utf8');
      expect(source).not.toContain('@nestjs/schedule');
      expect(source).not.toContain('@Cron');
      expect(source).not.toContain('setInterval');
      expect(source).not.toContain('setTimeout');
    });

    it('exports CoordinatedChildExecution discriminated union type', () => {
      const filePath = resolve(
        __dirname,
        '../services/ordinary-recovery-coordinator.service.ts',
      );
      const source = readFileSync(filePath, 'utf8');
      expect(source).toContain('export type CoordinatedChildExecution<T>');
      expect(source).toContain("'NOT_ATTEMPTED'");
      expect(source).toContain("'SUCCEEDED'");
      expect(source).toContain("'FAILED'");
    });

    it('CoordinatedRecoveryResult defines command and invalidation properties, not obsolete optional fields', () => {
      const filePath = resolve(
        __dirname,
        '../services/ordinary-recovery-coordinator.service.ts',
      );
      const source = readFileSync(filePath, 'utf8');
      expect(source).toContain('command: CoordinatedChildExecution<OrdinaryCommandWorkerRunResult>;');
      expect(source).toContain('invalidation: CoordinatedChildExecution<SweepResult>;');
      expect(source).not.toContain('commandResult?:');
      expect(source).not.toContain('invalidationResult?:');
      expect(source).not.toMatch(/error\?: string;/);
    });
  });
});
