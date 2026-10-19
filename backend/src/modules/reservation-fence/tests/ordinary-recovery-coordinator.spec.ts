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
import {
  IOrdinaryRecoveryLockService,
  OrdinaryRecoveryExecutionPermit,
  OrdinaryRecoveryOwnershipLost,
  OrdinaryRecoveryLockOutcome,
} from '../types/ordinary-recovery-lock.types';

describe('OrdinaryRecoveryCoordinatorService (Phase C.3.4 - Corrected Contract)', () => {
  let mockCommandWorker: {
    runSweep: jest.Mock<Promise<OrdinaryCommandWorkerRunResult>, [CommandSweepOptions?, OrdinaryRecoveryExecutionPermit?]>;
    onModuleDestroy?: jest.Mock<void, []>;
    isBusy?: boolean;
    isScheduled?: boolean;
  };

  let mockInvalidationWorker: {
    runSweep: jest.Mock<Promise<SweepResult>, [number?, OrdinaryRecoveryExecutionPermit?]>;
    onModuleDestroy?: jest.Mock<void, []>;
    isBusy?: boolean;
    isScheduled?: boolean;
  };

  let mockPermit: {
    signal: AbortSignal;
    ownerPid: number;
    acquisitionId: string;
    assertHeld: jest.Mock<Promise<void>, []>;
  };

  let mockLockService: {
    withExclusiveLock: jest.Mock<Promise<OrdinaryRecoveryLockOutcome<any>>, [(permit: OrdinaryRecoveryExecutionPermit) => Promise<any>]>;
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

  function createCoordinator(
    options?: OrdinaryRecoveryCoordinatorOptions,
    customLockService?: IOrdinaryRecoveryLockService,
  ): OrdinaryRecoveryCoordinatorService {
    return new OrdinaryRecoveryCoordinatorService(
      mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
      mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
      customLockService ?? (mockLockService as unknown as IOrdinaryRecoveryLockService),
      options,
    );
  }

  beforeEach(() => {
    mockPermit = {
      signal: new AbortController().signal,
      ownerPid: 9876,
      acquisitionId: 'test-acq-uuid',
      assertHeld: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    };

    mockLockService = {
      withExclusiveLock: jest.fn().mockImplementation(async (cb: (permit: OrdinaryRecoveryExecutionPermit) => Promise<any>) => {
        const value = await cb(mockPermit as unknown as OrdinaryRecoveryExecutionPermit);
        return {
          status: 'EXECUTED',
          value,
        };
      }),
    };

    mockCommandWorker = {
      runSweep: jest.fn<Promise<OrdinaryCommandWorkerRunResult>, [CommandSweepOptions?, OrdinaryRecoveryExecutionPermit?]>().mockResolvedValue({
        status: 'COMPLETED',
        result: sampleCommandResult,
      }),
      onModuleDestroy: jest.fn<void, []>(),
      isBusy: false,
      isScheduled: false,
    };

    mockInvalidationWorker = {
      runSweep: jest.fn<Promise<SweepResult>, [number?, OrdinaryRecoveryExecutionPermit?]>().mockResolvedValue({
        ...sampleInvalidationResult,
      }),
      onModuleDestroy: jest.fn<void, []>(),
      isBusy: false,
      isScheduled: false,
    };
  });

  describe('1. Instantiation and Dependency Validation', () => {
    it('instantiates cleanly with valid worker dependencies and default options', () => {
      const coordinator = createCoordinator();

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

      const coordinator = createCoordinator(options);

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
            mockLockService as unknown as IOrdinaryRecoveryLockService,
          ),
      ).toThrow('INVALID_COORDINATOR_DEPENDENCIES');

      expect(
        () =>
          new OrdinaryRecoveryCoordinatorService(
            {} as unknown as OrdinaryCommandRecoverySweepWorker,
            mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
            mockLockService as unknown as IOrdinaryRecoveryLockService,
          ),
      ).toThrow('INVALID_COORDINATOR_DEPENDENCIES');
    });

    it('rejects missing or non-callable invalidationWorker', () => {
      expect(
        () =>
          new OrdinaryRecoveryCoordinatorService(
            mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
            null as unknown as OrdinaryRecoverySweepWorker,
            mockLockService as unknown as IOrdinaryRecoveryLockService,
          ),
      ).toThrow('INVALID_COORDINATOR_DEPENDENCIES');

      expect(
        () =>
          new OrdinaryRecoveryCoordinatorService(
            mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
            {} as unknown as OrdinaryRecoverySweepWorker,
            mockLockService as unknown as IOrdinaryRecoveryLockService,
          ),
      ).toThrow('INVALID_COORDINATOR_DEPENDENCIES');
    });

    it('rejects missing or non-callable lockService', () => {
      expect(
        () =>
          new OrdinaryRecoveryCoordinatorService(
            mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
            mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
            null as unknown as IOrdinaryRecoveryLockService,
          ),
      ).toThrow('INVALID_COORDINATOR_DEPENDENCIES');

      expect(
        () =>
          new OrdinaryRecoveryCoordinatorService(
            mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
            mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
            {} as unknown as IOrdinaryRecoveryLockService,
          ),
      ).toThrow('INVALID_COORDINATOR_DEPENDENCIES');
    });

    it('rejects non-object constructor options', () => {
      expect(
        () =>
          new OrdinaryRecoveryCoordinatorService(
            mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
            mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
            mockLockService as unknown as IOrdinaryRecoveryLockService,
            'invalid' as unknown as OrdinaryRecoveryCoordinatorOptions,
          ),
      ).toThrow('INVALID_COORDINATOR_OPTIONS');

      expect(
        () =>
          new OrdinaryRecoveryCoordinatorService(
            mockCommandWorker as unknown as OrdinaryCommandRecoverySweepWorker,
            mockInvalidationWorker as unknown as OrdinaryRecoverySweepWorker,
            mockLockService as unknown as IOrdinaryRecoveryLockService,
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
              mockLockService as unknown as IOrdinaryRecoveryLockService,
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

      const coordinator = createCoordinator();

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

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('PARTIAL');
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_WORKER_HAS_MORE',
      });
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
      const coordinator = createCoordinator();

      await coordinator.runCoordinatedSweep();

      expect(mockCommandWorker.runSweep).toHaveBeenCalledWith(
        {
          limit: 20,
          maxPages: 10,
          workerId: 'recovery-coordinator',
        },
        mockPermit,
      );
      expect(mockInvalidationWorker.runSweep).toHaveBeenCalledWith(20, mockPermit);
    });

    it('forwards custom runtime options to child workers', async () => {
      const coordinator = createCoordinator();

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

      expect(mockCommandWorker.runSweep).toHaveBeenCalledWith(
        {
          limit: 5,
          maxPages: 2,
          workerId: 'custom-sweep-id',
        },
        mockPermit,
      );
      expect(mockInvalidationWorker.runSweep).toHaveBeenCalledWith(15, mockPermit);
    });

    it('inherits constructor defaults for omitted sweep options', async () => {
      const coordinator = createCoordinator({
        defaultCommandLimit: 40,
        defaultCommandMaxPages: 8,
        defaultInvalidationLimit: 35,
        defaultWorkerId: 'configured-coord',
      });

      await coordinator.runCoordinatedSweep({});

      expect(mockCommandWorker.runSweep).toHaveBeenCalledWith(
        {
          limit: 40,
          maxPages: 8,
          workerId: 'configured-coord',
        },
        mockPermit,
      );
      expect(mockInvalidationWorker.runSweep).toHaveBeenCalledWith(35, mockPermit);
    });
  });

  describe('4. Invalid Option Handling with NOT_ATTEMPTED Representation', () => {
    it('returns FAILED with explicit NOT_ATTEMPTED child results when options are invalid', async () => {
      const coordinator = createCoordinator();

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

  describe('5. Command Failure Continuation Policy and Safety Barrier', () => {
    it('halts and sets invalidation to NOT_ATTEMPTED on command failure even when continueOnCommandFailure is true', async () => {
      mockCommandWorker.runSweep.mockResolvedValue({
        status: 'FAILED',
        errorCode: 'RECOVERY_SWEEP_FAILED',
      });

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep({
        continueOnCommandFailure: true,
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
        reason: 'COMMAND_WORKER_FAILED',
      });
    });

    it('halts and sets invalidation to NOT_ATTEMPTED on command failure when continueOnCommandFailure is false', async () => {
      mockCommandWorker.runSweep.mockResolvedValue({
        status: 'FAILED',
        errorCode: 'RECOVERY_SWEEP_FAILED',
      });

      const coordinator = createCoordinator();

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
        reason: 'COMMAND_WORKER_FAILED',
      });
    });

    it('halts when command worker throws and continueOnCommandFailure is false', async () => {
      mockCommandWorker.runSweep.mockRejectedValue(new Error('DATABASE_CONNECTION_RESET'));

      const coordinator = createCoordinator();

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
        reason: 'COMMAND_RECOVERY_FAILED',
      });
    });

    it('halts when command worker throws even when continueOnCommandFailure is true', async () => {
      mockCommandWorker.runSweep.mockRejectedValue(new Error('DATABASE_CONNECTION_RESET'));

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep({
        continueOnCommandFailure: true,
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
        reason: 'COMMAND_RECOVERY_FAILED',
      });
    });
  });

  describe('6. Busy and Stopped Child Results', () => {
    it('handles command worker SKIPPED_BUSY and halts invalidation under command-first barrier', async () => {
      mockCommandWorker.runSweep.mockResolvedValue({
        status: 'SKIPPED_BUSY',
      });

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep({ continueOnCommandFailure: true });

      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: { status: 'SKIPPED_BUSY' },
      });
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_WORKER_SKIPPED_BUSY',
      });
    });

    it('halts on command worker SKIPPED_BUSY when continueOnCommandFailure is false', async () => {
      mockCommandWorker.runSweep.mockResolvedValue({
        status: 'SKIPPED_BUSY',
      });

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep({ continueOnCommandFailure: false });

      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: { status: 'SKIPPED_BUSY' },
      });
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_WORKER_SKIPPED_BUSY',
      });
    });

    it('handles command worker STOPPED and halts invalidation under command-first barrier', async () => {
      mockCommandWorker.runSweep.mockResolvedValue({
        status: 'STOPPED',
      });

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep({ continueOnCommandFailure: false });

      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: { status: 'STOPPED' },
      });
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_WORKER_STOPPED',
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

      const coordinator = createCoordinator();

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

      const coordinator = createCoordinator();

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

    it('enforces command-first barrier: does not run invalidation worker when command fails', async () => {
      mockCommandWorker.runSweep.mockResolvedValue({
        status: 'FAILED',
        errorCode: 'COMMAND_SWEEP_FAILED',
      });

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep({ continueOnCommandFailure: true });

      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: { status: 'FAILED', errorCode: 'COMMAND_SWEEP_FAILED' },
      });
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_WORKER_FAILED',
      });
    });

    it('enforces command-first barrier: does not run invalidation worker when command throws', async () => {
      mockCommandWorker.runSweep.mockRejectedValue(new Error('FATAL_COMMAND_CORRUPTION'));

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep({ continueOnCommandFailure: true });

      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'FAILED',
        errorCode: 'COMMAND_WORKER_THREW',
      });
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_RECOVERY_FAILED',
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

      const coordinator = createCoordinator();

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

      const coordinator = createCoordinator();

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
      const coordinator = createCoordinator();

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
      const coordinator = createCoordinator();

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
      const coordinator = createCoordinator();

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
      const coordinator = createCoordinator();

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

  describe('12. Distributed Recovery Lock Integration (Phase C Batch 2)', () => {
    it('acquires lock via lockService.withExclusiveLock and executes sweep', async () => {
      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep();

      expect(mockLockService.withExclusiveLock).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('COMPLETED');
      expect(result.command.status).toBe('SUCCEEDED');
      expect(result.invalidation.status).toBe('SUCCEEDED');
    });

    it('returns SKIPPED_LOCK_BUSY when lock outcome is LOCK_BUSY', async () => {
      mockLockService.withExclusiveLock.mockResolvedValueOnce({
        status: 'LOCK_BUSY',
      });

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('SKIPPED_LOCK_BUSY');
      expect(result.command).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'DISTRIBUTED_LOCK_BUSY',
      });
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'DISTRIBUTED_LOCK_BUSY',
      });
      expect(mockCommandWorker.runSweep).not.toHaveBeenCalled();
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
    });

    it('passes the exact same OrdinaryRecoveryExecutionPermit reference to both workers', async () => {
      const coordinator = createCoordinator();

      await coordinator.runCoordinatedSweep();

      expect(mockCommandWorker.runSweep).toHaveBeenCalledTimes(1);
      expect(mockInvalidationWorker.runSweep).toHaveBeenCalledTimes(1);

      const commandPermit = mockCommandWorker.runSweep.mock.calls[0]![1];
      const invalidationPermit = mockInvalidationWorker.runSweep.mock.calls[0]![1];

      expect(commandPermit).toBeDefined();
      expect(invalidationPermit).toBeDefined();
      expect(commandPermit).toBe(invalidationPermit);
      expect(commandPermit).toBe(mockPermit);
    });

    it('propagates OrdinaryRecoveryOwnershipLost when permit.assertHeld throws before command worker', async () => {
      mockPermit.assertHeld.mockRejectedValueOnce(
        new OrdinaryRecoveryOwnershipLost('LOST_BEFORE_COMMAND'),
      );

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('FAILED');
      expect(result.command).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COORDINATED_SWEEP_FAILED',
      });
      expect(result.invalidation).toEqual({
        status: 'FAILED',
        errorCode: 'OWNERSHIP_LOST',
      });
      expect(mockCommandWorker.runSweep).not.toHaveBeenCalled();
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
    });

    it('propagates OrdinaryRecoveryOwnershipLost from commandWorker.runSweep', async () => {
      mockCommandWorker.runSweep.mockRejectedValueOnce(
        new OrdinaryRecoveryOwnershipLost('LOST_DURING_COMMAND'),
      );

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('FAILED');
      expect(result.invalidation).toEqual({
        status: 'FAILED',
        errorCode: 'OWNERSHIP_LOST',
      });
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
    });

    it('propagates OrdinaryRecoveryOwnershipLost when permit.assertHeld throws between command and invalidation', async () => {
      // 1st assertHeld succeeds (before command)
      // 2nd assertHeld throws (between command and invalidation)
      mockPermit.assertHeld
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new OrdinaryRecoveryOwnershipLost('LOST_BETWEEN_WORKERS'));

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('FAILED');
      expect(result.command.status).toBe('SUCCEEDED');
      expect(result.invalidation).toEqual({
        status: 'FAILED',
        errorCode: 'OWNERSHIP_LOST',
      });
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
    });

    it('propagates OrdinaryRecoveryOwnershipLost from invalidationWorker.runSweep', async () => {
      mockInvalidationWorker.runSweep.mockRejectedValueOnce(
        new OrdinaryRecoveryOwnershipLost('LOST_DURING_INVALIDATION'),
      );

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('FAILED');
      expect(result.command.status).toBe('SUCCEEDED');
      expect(result.invalidation).toEqual({
        status: 'FAILED',
        errorCode: 'OWNERSHIP_LOST',
      });
    });

    it('propagates OrdinaryRecoveryOwnershipLost when permit.assertHeld throws after invalidation recovery', async () => {
      // 1st assertHeld: before command -> ok
      // 2nd assertHeld: after command -> ok
      // 3rd assertHeld: before invalidation -> ok
      // 4th assertHeld: after invalidation -> throws
      mockPermit.assertHeld
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new OrdinaryRecoveryOwnershipLost('LOST_AFTER_INVALIDATION'));

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('FAILED');
      expect(result.command.status).toBe('SUCCEEDED');
      expect(result.invalidation).toEqual({
        status: 'FAILED',
        errorCode: 'OWNERSHIP_LOST',
      });
    });

    it('halts invalidation recovery if command worker reports unresolved items (unresolvedCount > 0)', async () => {
      mockCommandWorker.runSweep.mockResolvedValueOnce({
        status: 'COMPLETED',
        result: {
          ...sampleCommandResult,
          unresolvedCount: 3,
        },
      });

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('PARTIAL');
      expect(result.command.status).toBe('SUCCEEDED');
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_WORKER_UNRESOLVED',
      });
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
    });

    it('halts invalidation recovery if command worker reports error items (errorCount > 0)', async () => {
      mockCommandWorker.runSweep.mockResolvedValueOnce({
        status: 'COMPLETED',
        result: {
          ...sampleCommandResult,
          errorCount: 2,
        },
      });

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('PARTIAL');
      expect(result.command.status).toBe('SUCCEEDED');
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_WORKER_UNRESOLVED',
      });
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
    });

    it('halts invalidation recovery if command worker reports hasMore === true', async () => {
      mockCommandWorker.runSweep.mockResolvedValueOnce({
        status: 'COMPLETED',
        result: {
          ...sampleCommandResult,
          hasMore: true,
        },
      });

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('PARTIAL');
      expect(result.command.status).toBe('SUCCEEDED');
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_WORKER_HAS_MORE',
      });
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
    });

    it('halts invalidation recovery if command worker reports FAILED status', async () => {
      mockCommandWorker.runSweep.mockResolvedValueOnce({
        status: 'FAILED',
        errorCode: 'COMMAND_SWEEP_FAILED',
      });

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: {
          status: 'FAILED',
          errorCode: 'COMMAND_SWEEP_FAILED',
        },
      });
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_WORKER_FAILED',
      });
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
    });

    it('halts invalidation recovery if command worker reports SKIPPED_BUSY status', async () => {
      mockCommandWorker.runSweep.mockResolvedValueOnce({
        status: 'SKIPPED_BUSY',
      });

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: {
          status: 'SKIPPED_BUSY',
        },
      });
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_WORKER_SKIPPED_BUSY',
      });
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
    });

    it('halts invalidation recovery if command worker reports STOPPED status', async () => {
      mockCommandWorker.runSweep.mockResolvedValueOnce({
        status: 'STOPPED',
      });

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('PARTIAL');
      expect(result.command).toEqual({
        status: 'SUCCEEDED',
        result: {
          status: 'STOPPED',
        },
      });
      expect(result.invalidation).toEqual({
        status: 'NOT_ATTEMPTED',
        reason: 'COMMAND_WORKER_STOPPED',
      });
      expect(mockInvalidationWorker.runSweep).not.toHaveBeenCalled();
    });

    it('releases process-local isRunning flag even when lockService throws a fatal error', async () => {
      mockLockService.withExclusiveLock.mockRejectedValueOnce(new Error('FATAL_LOCK_DATABASE_DOWN'));

      const coordinator = createCoordinator();

      const result = await coordinator.runCoordinatedSweep();

      expect(result.status).toBe('FAILED');
      expect(result.invalidation).toEqual({
        status: 'FAILED',
        errorCode: 'COORDINATED_SWEEP_FAILED',
      });
      expect(coordinator.isBusy).toBe(false);
    });
  });
});
