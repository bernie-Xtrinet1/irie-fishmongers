import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { REDIS_CLIENT } from '../../../common/redis/redis.constants';

import { OrdinaryRecoveryModule } from '../ordinary-recovery.module';
import {
  OrdinaryRecoveryCoordinatorService,
  CoordinatedRecoveryResult,
} from '../services/ordinary-recovery-coordinator.service';
import { OrdinaryRecoveryTelemetryAdapter } from '../services/ordinary-recovery-telemetry-adapter.service';
import { OrdinaryRecoverySweepWorker } from '../workers/ordinary-recovery-sweep.worker';
import { OrdinaryCommandRecoverySweepWorker } from '../workers/ordinary-command-recovery-sweep.worker';
import { OrdinaryCommandRecoveryService } from '../services/ordinary-command-recovery.service';
import { OrdinaryRecoveryDiagnosticsService } from '../services/ordinary-recovery-diagnostics.service';
import { OrdinaryCommandClosureService } from '../services/ordinary-command-closure.service';
import {
  ORDINARY_RECOVERY_SWEEP_EVENT,
  OrdinaryRecoverySweepEvent,
} from '../events/ordinary-recovery-sweep.event';
import {
  CommandSweepResult,
  SweepResult,
} from '../types/ordinary-invalidation-recovery.types';

describe('OrdinaryRecoveryModule (Phase C.3.5 — Option DI-C Integration)', () => {
  let moduleRef: TestingModule;
  let mockPrisma: {
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
    ordinaryInvalidationIntent: { findUnique: jest.Mock; findFirst: jest.Mock; create: jest.Mock };
    ordinaryInvalidationHead: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock };
    ordinaryInvalidationScope: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; create: jest.Mock };
    cartReservationSyncState: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; update: jest.Mock };
    ordinaryReservationOwner: { findMany: jest.Mock; findUnique: jest.Mock; findUniqueOrThrow: jest.Mock };
    ordinaryReservationCommand: { count: jest.Mock; findUnique: jest.Mock; findUniqueOrThrow: jest.Mock };
    cart: { findUniqueOrThrow: jest.Mock };
    cartItem: { findUnique: jest.Mock };
    reservationFenceTransition: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
    reservationEngineModeConfig: { findFirst: jest.Mock };
  };
  let mockRedis: {
    eval: jest.Mock;
    get: jest.Mock;
    set: jest.Mock;
  };
  let mockEventEmitter: {
    emit: jest.Mock;
    removeAllListeners: jest.Mock;
  };

  const sampleCommandResult: CommandSweepResult = {
    attemptedCount: 3,
    acknowledgedCount: 3,
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

  beforeEach(async () => {
    mockPrisma = {
      $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => unknown) => Promise.resolve(cb(mockPrisma))),
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([]),
      ordinaryInvalidationIntent: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'test-intent' }),
      },
      ordinaryInvalidationHead: {
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          scope: 'GLOBAL',
          publishedRevision: 1,
          allocatedRevision: 1,
          ready: true,
          pendingIntentId: null,
          incarnation: 'inc',
          epoch: 1,
        }),
      },
      ordinaryInvalidationScope: {
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ intentId: 'i1', scope: 's1' }),
        create: jest.fn().mockResolvedValue({}),
      },
      cartReservationSyncState: {
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'marker-1', generation: 1 }),
        update: jest.fn().mockResolvedValue({ ordinaryEnqueueSequence: 1 }),
      },
      ordinaryReservationOwner: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'owner-1', state: 'ACTIVE' }),
      },
      ordinaryReservationCommand: {
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'cmd-1', effect: 'W1' }),
      },
      cart: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'cart-1', customerId: 'cust-1' }),
      },
      cartItem: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      reservationFenceTransition: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'trans-1', revision: 1 }),
        update: jest.fn().mockResolvedValue({ id: 'trans-1' }),
      },
      reservationEngineModeConfig: {
        findFirst: jest.fn().mockResolvedValue({ mode: 'CART_SCOPED', revision: 1 }),
      },
    };

    mockRedis = {
      eval: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };

    mockEventEmitter = {
      emit: jest.fn().mockReturnValue(true),
      removeAllListeners: jest.fn(),
    };

    moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot(), OrdinaryRecoveryModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .overrideProvider(RedisService)
      .useValue(mockRedis)
      .overrideProvider(REDIS_CLIENT)
      .useValue({})
      .overrideProvider(EventEmitter2)
      .useValue(mockEventEmitter)
      .compile();
  });

  afterEach(async () => {
    if (moduleRef) {
      await moduleRef.close();
    }
    jest.restoreAllMocks();
  });

  describe('1. Dependency Injection Resolution & Graph Integrity', () => {
    it('resolves OrdinaryRecoveryTelemetryAdapter cleanly from the module context', () => {
      const adapter = moduleRef.get(OrdinaryRecoveryTelemetryAdapter);
      expect(adapter).toBeDefined();
      expect(adapter.isBusy).toBe(false);
      expect(adapter.isStopped).toBe(false);
    });

    it('resolves OrdinaryRecoveryCoordinatorService cleanly with proper worker wiring', () => {
      const coordinator = moduleRef.get(OrdinaryRecoveryCoordinatorService);
      expect(coordinator).toBeDefined();
      expect(coordinator.isBusy).toBe(false);
      expect(coordinator.isStopped).toBe(false);
      expect(coordinator.defaultCommandLimit).toBe(20);
      expect(coordinator.defaultInvalidationLimit).toBe(20);
    });

    it('resolves all intermediate command and invalidation recovery services', () => {
      const cmdWorker = moduleRef.get(OrdinaryCommandRecoverySweepWorker);
      const invWorker = moduleRef.get(OrdinaryRecoverySweepWorker);
      const cmdRecovery = moduleRef.get(OrdinaryCommandRecoveryService);
      const diagnostics = moduleRef.get(OrdinaryRecoveryDiagnosticsService);
      const closure = moduleRef.get(OrdinaryCommandClosureService);

      expect(cmdWorker).toBeDefined();
      expect(invWorker).toBeDefined();
      expect(cmdRecovery).toBeDefined();
      expect(diagnostics).toBeDefined();
      expect(closure).toBeDefined();
    });

    it('ensures exactly one instance of each worker within the module context', () => {
      const invWorker1 = moduleRef.get(OrdinaryRecoverySweepWorker);
      const invWorker2 = moduleRef.get(OrdinaryRecoverySweepWorker);
      expect(invWorker1).toBe(invWorker2);

      const cmdWorker1 = moduleRef.get(OrdinaryCommandRecoverySweepWorker);
      const cmdWorker2 = moduleRef.get(OrdinaryCommandRecoverySweepWorker);
      expect(cmdWorker1).toBe(cmdWorker2);
    });

    it('ensures OrdinaryCommandClosureService is given observation-only capability', () => {
      const closure = moduleRef.get(OrdinaryCommandClosureService);
      const physical = (closure as unknown as { physical: Record<string, unknown> }).physical;
      // Verify physical closure exposes observe method
      expect(typeof physical.observe).toBe('function');
      // Verify physical dispatch/execution methods are not exposed on physical capability
      expect(physical.execute).toBeUndefined();
      expect(physical.initialize).toBeUndefined();
      expect(physical.executeRelease).toBeUndefined();
    });
  });

  describe('2. Strict Scheduler Suppression & Zero Timers', () => {
    it('creates zero background timers even when ENABLE_SCHEDULER=true in environment', async () => {
      const origEnv = process.env.ENABLE_SCHEDULER;
      process.env.ENABLE_SCHEDULER = 'true';

      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      try {
        const app = moduleRef.createNestApplication();
        await app.init();

        const invWorker = moduleRef.get(OrdinaryRecoverySweepWorker);
        const cmdWorker = moduleRef.get(OrdinaryCommandRecoverySweepWorker);
        const coordinator = moduleRef.get(OrdinaryRecoveryCoordinatorService);

        expect(invWorker.isScheduled).toBe(false);
        expect(cmdWorker.isScheduled).toBe(false);
        expect(coordinator.isBusy).toBe(false);

        // Verify recovery workers created 0 interval timers
        const recoveryTimerCalls = setIntervalSpy.mock.calls.filter(
          call => call[1] === 15000,
        );
        expect(recoveryTimerCalls.length).toBe(0);

        await app.close();
      } finally {
        if (origEnv !== undefined) {
          process.env.ENABLE_SCHEDULER = origEnv;
        } else {
          delete process.env.ENABLE_SCHEDULER;
        }
        setIntervalSpy.mockRestore();
      }
    });

    it('ensures worker lifecycle teardown cleans up cleanly without double destruction', async () => {
      const app = moduleRef.createNestApplication();
      await app.init();

      const coordinator = moduleRef.get(OrdinaryRecoveryCoordinatorService);
      const invWorker = moduleRef.get(OrdinaryRecoverySweepWorker);
      const cmdWorker = moduleRef.get(OrdinaryCommandRecoverySweepWorker);

      expect(coordinator.isStopped).toBe(false);

      await app.close();

      expect(coordinator.isStopped).toBe(true);
      expect(invWorker.isScheduled).toBe(false);
      expect(cmdWorker.isScheduled).toBe(false);
    });
  });

  describe('3. Telemetry Adapter & Event Contract Delivery', () => {
    it('emits OrdinaryRecoverySweepEvent on COMPLETED sweep with accurate child metrics', async () => {
      const adapter = moduleRef.get(OrdinaryRecoveryTelemetryAdapter);
      const coordinator = moduleRef.get(OrdinaryRecoveryCoordinatorService);

      const completedResult: CoordinatedRecoveryResult = {
        status: 'COMPLETED',
        command: {
          status: 'SUCCEEDED',
          result: { status: 'COMPLETED', result: sampleCommandResult },
        },
        invalidation: {
          status: 'SUCCEEDED',
          result: sampleInvalidationResult,
        },
        durationMs: 42,
      };

      jest.spyOn(coordinator, 'runCoordinatedSweep').mockResolvedValue(completedResult);

      const result = await adapter.runCoordinatedSweep();

      expect(result).toBe(completedResult);
      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);

      const calls = mockEventEmitter.emit.mock.calls as unknown[][];
      const firstCall = calls[0];
      if (!firstCall) throw new Error('Expected at least one emit call');
      const eventName = firstCall[0] as string;
      const eventPayload = firstCall[1] as OrdinaryRecoverySweepEvent;
      expect(eventName).toBe(ORDINARY_RECOVERY_SWEEP_EVENT);
      expect(eventPayload).toBeInstanceOf(OrdinaryRecoverySweepEvent);
      expect(eventPayload.status).toBe('COMPLETED');
      expect(eventPayload.durationMs).toBe(42);
      expect(eventPayload.commandStatus).toBe('SUCCEEDED');
      expect(eventPayload.commandWorkerStatus).toBe('COMPLETED');
      expect(eventPayload.commandMetrics).toEqual(sampleCommandResult);
      expect(eventPayload.invalidationStatus).toBe('SUCCEEDED');
      expect(eventPayload.invalidationMetrics).toEqual(sampleInvalidationResult);
    });

    it('emits event on PARTIAL sweep preserving reasons and metrics', async () => {
      const adapter = moduleRef.get(OrdinaryRecoveryTelemetryAdapter);
      const coordinator = moduleRef.get(OrdinaryRecoveryCoordinatorService);

      const partialResult: CoordinatedRecoveryResult = {
        status: 'PARTIAL',
        command: {
          status: 'SUCCEEDED',
          result: { status: 'FAILED', errorCode: 'RECOVERY_SWEEP_FAILED' },
        },
        invalidation: {
          status: 'NOT_ATTEMPTED',
          reason: 'COMMAND_FAILURE_CONTINUATION_DISABLED',
        },
        durationMs: 15,
      };

      jest.spyOn(coordinator, 'runCoordinatedSweep').mockResolvedValue(partialResult);

      const result = await adapter.runCoordinatedSweep();

      expect(result).toBe(partialResult);
      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);

      const calls = mockEventEmitter.emit.mock.calls as unknown[][];
      const firstCall = calls[0];
      if (!firstCall) throw new Error('Expected at least one emit call');
      const eventPayload = firstCall[1] as OrdinaryRecoverySweepEvent;
      expect(eventPayload.status).toBe('PARTIAL');
      expect(eventPayload.commandStatus).toBe('SUCCEEDED');
      expect(eventPayload.commandWorkerStatus).toBe('FAILED');
      expect(eventPayload.invalidationStatus).toBe('NOT_ATTEMPTED');
      expect(eventPayload.invalidationReason).toBe('COMMAND_FAILURE_CONTINUATION_DISABLED');
    });

    it('emits event on FAILED sweep preserving error codes', async () => {
      const adapter = moduleRef.get(OrdinaryRecoveryTelemetryAdapter);
      const coordinator = moduleRef.get(OrdinaryRecoveryCoordinatorService);

      const failedResult: CoordinatedRecoveryResult = {
        status: 'FAILED',
        command: {
          status: 'FAILED',
          errorCode: 'COMMAND_WORKER_THREW',
        },
        invalidation: {
          status: 'FAILED',
          errorCode: 'INVALIDATION_WORKER_THREW',
        },
        durationMs: 8,
      };

      jest.spyOn(coordinator, 'runCoordinatedSweep').mockResolvedValue(failedResult);

      const result = await adapter.runCoordinatedSweep();

      expect(result).toBe(failedResult);
      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);

      const calls = mockEventEmitter.emit.mock.calls as unknown[][];
      const firstCall = calls[0];
      if (!firstCall) throw new Error('Expected at least one emit call');
      const eventPayload = firstCall[1] as OrdinaryRecoverySweepEvent;
      expect(eventPayload.status).toBe('FAILED');
      expect(eventPayload.commandStatus).toBe('FAILED');
      expect(eventPayload.commandErrorCode).toBe('COMMAND_WORKER_THREW');
      expect(eventPayload.invalidationStatus).toBe('FAILED');
      expect(eventPayload.invalidationErrorCode).toBe('INVALIDATION_WORKER_THREW');
    });

    it('emits event on SKIPPED_BUSY representing coordinator busy guard', async () => {
      const adapter = moduleRef.get(OrdinaryRecoveryTelemetryAdapter);
      const coordinator = moduleRef.get(OrdinaryRecoveryCoordinatorService);

      const busyResult: CoordinatedRecoveryResult = {
        status: 'SKIPPED_BUSY',
        command: {
          status: 'NOT_ATTEMPTED',
          reason: 'COORDINATOR_BUSY',
        },
        invalidation: {
          status: 'NOT_ATTEMPTED',
          reason: 'COORDINATOR_BUSY',
        },
        durationMs: 0,
      };

      jest.spyOn(coordinator, 'runCoordinatedSweep').mockResolvedValue(busyResult);

      const result = await adapter.runCoordinatedSweep();

      expect(result).toBe(busyResult);
      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);

      const calls = mockEventEmitter.emit.mock.calls as unknown[][];
      const firstCall = calls[0];
      if (!firstCall) throw new Error('Expected at least one emit call');
      const eventPayload = firstCall[1] as OrdinaryRecoverySweepEvent;
      expect(eventPayload.status).toBe('SKIPPED_BUSY');
      expect(eventPayload.commandReason).toBe('COORDINATOR_BUSY');
      expect(eventPayload.invalidationReason).toBe('COORDINATOR_BUSY');
    });

    it('emits event on STOPPED representing stopped coordinator', async () => {
      const adapter = moduleRef.get(OrdinaryRecoveryTelemetryAdapter);
      const coordinator = moduleRef.get(OrdinaryRecoveryCoordinatorService);

      const stoppedResult: CoordinatedRecoveryResult = {
        status: 'STOPPED',
        command: {
          status: 'NOT_ATTEMPTED',
          reason: 'COORDINATOR_STOPPED',
        },
        invalidation: {
          status: 'NOT_ATTEMPTED',
          reason: 'COORDINATOR_STOPPED',
        },
        durationMs: 0,
      };

      jest.spyOn(coordinator, 'runCoordinatedSweep').mockResolvedValue(stoppedResult);

      const result = await adapter.runCoordinatedSweep();

      expect(result).toBe(stoppedResult);
      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);

      const calls = mockEventEmitter.emit.mock.calls as unknown[][];
      const firstCall = calls[0];
      if (!firstCall) throw new Error('Expected at least one emit call');
      const eventPayload = firstCall[1] as OrdinaryRecoverySweepEvent;
      expect(eventPayload.status).toBe('STOPPED');
      expect(eventPayload.commandReason).toBe('COORDINATOR_STOPPED');
      expect(eventPayload.invalidationReason).toBe('COORDINATOR_STOPPED');
    });
  });

  describe('4. Telemetry Failure Isolation & Robustness', () => {
    it('contains synchronous event emission failure and returns original result', async () => {
      const adapter = moduleRef.get(OrdinaryRecoveryTelemetryAdapter);
      const coordinator = moduleRef.get(OrdinaryRecoveryCoordinatorService);

      const completedResult: CoordinatedRecoveryResult = {
        status: 'COMPLETED',
        command: {
          status: 'SUCCEEDED',
          result: { status: 'COMPLETED', result: sampleCommandResult },
        },
        invalidation: {
          status: 'SUCCEEDED',
          result: sampleInvalidationResult,
        },
        durationMs: 12,
      };

      jest.spyOn(coordinator, 'runCoordinatedSweep').mockResolvedValue(completedResult);
      mockEventEmitter.emit.mockImplementation(() => {
        throw new Error('EVENT_EMISSION_FAILURE');
      });

      const result = await adapter.runCoordinatedSweep();

      expect(result).toBe(completedResult);
    });

    it('returns original result cleanly when EventEmitter2 is not provided', async () => {
      const coordinator = moduleRef.get(OrdinaryRecoveryCoordinatorService);
      const adapterWithoutEmitter = new OrdinaryRecoveryTelemetryAdapter(coordinator, undefined);

      const completedResult: CoordinatedRecoveryResult = {
        status: 'COMPLETED',
        command: {
          status: 'SUCCEEDED',
          result: { status: 'COMPLETED', result: sampleCommandResult },
        },
        invalidation: {
          status: 'SUCCEEDED',
          result: sampleInvalidationResult,
        },
        durationMs: 10,
      };

      jest.spyOn(coordinator, 'runCoordinatedSweep').mockResolvedValue(completedResult);

      const result = await adapterWithoutEmitter.runCoordinatedSweep();

      expect(result).toBe(completedResult);
    });

    it('propagates fatal coordinator exception unmasked without emitting completion event', async () => {
      const adapter = moduleRef.get(OrdinaryRecoveryTelemetryAdapter);
      const coordinator = moduleRef.get(OrdinaryRecoveryCoordinatorService);

      jest.spyOn(coordinator, 'runCoordinatedSweep').mockRejectedValue(
        new Error('UNEXPECTED_COORDINATOR_FATAL_ERROR'),
      );

      await expect(adapter.runCoordinatedSweep()).rejects.toThrow(
        'UNEXPECTED_COORDINATOR_FATAL_ERROR',
      );
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('5. Production Dormancy & Boundary Assertions', () => {
    it('asserts AppModule does NOT import OrdinaryRecoveryModule', () => {
      const appModulePath = resolve(__dirname, '../../../app.module.ts');
      const source = readFileSync(appModulePath, 'utf8');
      expect(source).not.toContain('OrdinaryRecoveryModule');
    });

    it('asserts OrdinaryRecoveryModule does NOT import ReservationFenceModule', () => {
      const modulePath = resolve(__dirname, '../ordinary-recovery.module.ts');
      const source = readFileSync(modulePath, 'utf8');
      expect(source).not.toContain('ReservationFenceModule');
    });

    it('asserts ReservationFenceModule retains 0 C.3 worker/coordinator strings', () => {
      const fenceModulePath = resolve(__dirname, '../reservation-fence.module.ts');
      const source = readFileSync(fenceModulePath, 'utf8');
      expect(source).not.toContain('OrdinaryCommandRecoverySweepWorker');
      expect(source).not.toContain('OrdinaryRecoveryCoordinatorService');
      expect(source).not.toContain('OrdinaryRecoveryTelemetryAdapter');
    });
  });
});
