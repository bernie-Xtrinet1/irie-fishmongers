import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OrdinaryRecoverySweepWorker } from '../workers/ordinary-recovery-sweep.worker';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { OrdinaryInvalidationRecoveryService } from '../services/ordinary-invalidation-recovery.service';
import { OrdinaryMarkerBootstrapService } from '../services/ordinary-marker-bootstrap.service';
import { InvalidationRequest } from '../types/ordinary-invalidation.types';
import { BootstrapResult, RecoveryResult } from '../types/ordinary-invalidation-recovery.types';

describe('OrdinaryRecoverySweepWorker Lifecycle and Concurrency', () => {
  let repo: {
    discoverUnreadyEnrolledMarkerHeads: jest.Mock<Promise<{ scope: string; incarnation: string; epoch: number }[]>, [number]>;
    discover: jest.Mock<Promise<{ id: string; request: InvalidationRequest; status: string }[]>, [number]>;
  };
  let recoveryService: {
    recoverIntent: jest.Mock<Promise<RecoveryResult>, [string]>;
  };
  let bootstrapService: {
    bootstrap: jest.Mock<Promise<BootstrapResult>, [string]>;
  };

  const sampleRequest: InvalidationRequest = {
    version: 1,
    intentId: randomUUID(),
    operationId: randomUUID(),
    kind: 'CART',
    incarnation: randomUUID(),
    epoch: 1,
    scopes: [],
  };

  beforeEach(() => {
    repo = {
      discoverUnreadyEnrolledMarkerHeads: jest.fn<Promise<{ scope: string; incarnation: string; epoch: number }[]>, [number]>().mockResolvedValue([]),
      discover: jest.fn<Promise<{ id: string; request: InvalidationRequest; status: string }[]>, [number]>().mockResolvedValue([]),
    };
    recoveryService = {
      recoverIntent: jest.fn<Promise<RecoveryResult>, [string]>().mockResolvedValue({
        intentId: randomUUID(),
        disposition: 'REPLAYED',
      }),
    };
    bootstrapService = {
      bootstrap: jest.fn<Promise<BootstrapResult>, [string]>().mockResolvedValue({
        scope: 'MARKER:test',
        markerId: 'test',
        status: 'READY',
        revision: 1,
      }),
    };
  });

  // 1. With ENABLE_SCHEDULER unset, the worker does not schedule itself.
  it('with ENABLE_SCHEDULER unset, the worker does not schedule itself', () => {
    const orig = process.env.ENABLE_SCHEDULER;
    delete process.env.ENABLE_SCHEDULER;
    try {
      const worker = new OrdinaryRecoverySweepWorker(
        repo as unknown as OrdinaryInvalidationRepository,
        recoveryService as unknown as OrdinaryInvalidationRecoveryService,
        bootstrapService as unknown as OrdinaryMarkerBootstrapService,
      );
      worker.onModuleInit();
      expect(worker.isScheduled).toBe(false);
      worker.onModuleDestroy();
    } finally {
      if (orig !== undefined) process.env.ENABLE_SCHEDULER = orig;
    }
  });

  // 2. With ENABLE_SCHEDULER=false, the worker remains inactive.
  it('with ENABLE_SCHEDULER=false, the worker remains inactive', () => {
    const orig = process.env.ENABLE_SCHEDULER;
    process.env.ENABLE_SCHEDULER = 'false';
    try {
      const worker = new OrdinaryRecoverySweepWorker(
        repo as unknown as OrdinaryInvalidationRepository,
        recoveryService as unknown as OrdinaryInvalidationRecoveryService,
        bootstrapService as unknown as OrdinaryMarkerBootstrapService,
      );
      worker.onModuleInit();
      expect(worker.isScheduled).toBe(false);
      worker.onModuleDestroy();
    } finally {
      if (orig !== undefined) process.env.ENABLE_SCHEDULER = orig;
      else delete process.env.ENABLE_SCHEDULER;
    }
  });

  // 3. With ENABLE_SCHEDULER=true in an isolated NestJS test module, the worker starts its timer.
  it('with ENABLE_SCHEDULER=true in an isolated NestJS test module, the worker starts its timer', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrdinaryRecoverySweepWorker,
        { provide: OrdinaryInvalidationRepository, useValue: repo },
        { provide: OrdinaryInvalidationRecoveryService, useValue: recoveryService },
        { provide: OrdinaryMarkerBootstrapService, useValue: bootstrapService },
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === 'ENABLE_SCHEDULER' ? 'true' : undefined) },
        },
      ],
    }).compile();

    const worker = moduleRef.get(OrdinaryRecoverySweepWorker);
    worker.onModuleInit();
    expect(worker.isScheduled).toBe(true);
    worker.onModuleDestroy();
    await moduleRef.close();
  });

  // 4. A scheduled tick invokes runSweep().
  it('a scheduled tick invokes runSweep()', () => {
    jest.useFakeTimers();
    try {
      const config = { get: (k: string) => (k === 'ENABLE_SCHEDULER' ? 'true' : undefined) } as unknown as ConfigService;
      const worker = new OrdinaryRecoverySweepWorker(
        repo as unknown as OrdinaryInvalidationRepository,
        recoveryService as unknown as OrdinaryInvalidationRecoveryService,
        bootstrapService as unknown as OrdinaryMarkerBootstrapService,
        config,
      );

      const runSweepSpy = jest.spyOn(worker, 'runSweep').mockResolvedValue({
        bootstrappedCount: 0,
        reconciledCount: 0,
        replayedCount: 0,
        readinessCount: 0,
        blockedCount: 0,
        errors: [],
      });

      worker.onModuleInit();
      expect(runSweepSpy).not.toHaveBeenCalled();

      jest.advanceTimersByTime(15000);
      expect(runSweepSpy).toHaveBeenCalledTimes(1);

      worker.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  // 5. Concurrent runSweep() calls do not overlap.
  it('concurrent runSweep() calls do not overlap', async () => {
    let resolveSweep!: (val: { scope: string; incarnation: string; epoch: number }[]) => void;
    const pendingPromise = new Promise<{ scope: string; incarnation: string; epoch: number }[]>((resolve) => {
      resolveSweep = resolve;
    });
    repo.discoverUnreadyEnrolledMarkerHeads.mockReturnValue(pendingPromise);

    const worker = new OrdinaryRecoverySweepWorker(
      repo as unknown as OrdinaryInvalidationRepository,
      recoveryService as unknown as OrdinaryInvalidationRecoveryService,
      bootstrapService as unknown as OrdinaryMarkerBootstrapService,
    );

    const firstSweep = worker.runSweep();
    const secondSweep = await worker.runSweep();

    expect(secondSweep.errors).toContain('SWEEP_ALREADY_IN_PROGRESS');
    expect(secondSweep.bootstrappedCount).toBe(0);

    resolveSweep([]);
    const firstResult = await firstSweep;
    expect(firstResult.errors).not.toContain('SWEEP_ALREADY_IN_PROGRESS');
  });

  // 6. One failing recovery item does not prevent subsequent eligible items from being processed.
  it('one failing recovery item does not prevent subsequent eligible items from being processed', async () => {
    repo.discoverUnreadyEnrolledMarkerHeads.mockResolvedValue([
      { scope: 'MARKER:fail-1', incarnation: 'inc-1', epoch: 1 },
      { scope: 'MARKER:succ-2', incarnation: 'inc-2', epoch: 1 },
    ]);
    bootstrapService.bootstrap.mockImplementation((markerId: string) => {
      if (markerId === 'fail-1') return Promise.reject(new Error('DATABASE_DISK_ERROR'));
      return Promise.resolve({ scope: `MARKER:${markerId}`, markerId, status: 'READY', revision: 1 });
    });

    repo.discover.mockResolvedValue([
      { id: 'intent-fail', request: sampleRequest, status: 'PREPARED' },
      { id: 'intent-succ', request: sampleRequest, status: 'BARRIER_CONFIRMED' },
    ]);
    recoveryService.recoverIntent.mockImplementation((intentId: string) => {
      if (intentId === 'intent-fail') return Promise.reject(new Error('NETWORK_TIMEOUT'));
      return Promise.resolve({ intentId, disposition: 'REPLAYED' });
    });

    const worker = new OrdinaryRecoverySweepWorker(
      repo as unknown as OrdinaryInvalidationRepository,
      recoveryService as unknown as OrdinaryInvalidationRecoveryService,
      bootstrapService as unknown as OrdinaryMarkerBootstrapService,
    );

    const res = await worker.runSweep();
    expect(res.bootstrappedCount).toBe(1);
    expect(res.replayedCount).toBe(1);
    expect(res.errors).toEqual([
      'BOOTSTRAP_EXCEPTION:MARKER:fail-1:Error: DATABASE_DISK_ERROR',
      'RECOVERY_EXCEPTION:intent-fail:Error: NETWORK_TIMEOUT',
    ]);
  });

  // 7. Errors do not leave isRunning permanently true.
  it('errors do not leave isRunning permanently true', async () => {
    repo.discoverUnreadyEnrolledMarkerHeads.mockRejectedValue(new Error('FATAL_POSTGRES_DISCONNECT'));

    const worker = new OrdinaryRecoverySweepWorker(
      repo as unknown as OrdinaryInvalidationRepository,
      recoveryService as unknown as OrdinaryInvalidationRecoveryService,
      bootstrapService as unknown as OrdinaryMarkerBootstrapService,
    );

    await expect(worker.runSweep()).rejects.toThrow('FATAL_POSTGRES_DISCONNECT');
    expect(worker.isBusy).toBe(false);

    // Subsequent call proceeds normally
    repo.discoverUnreadyEnrolledMarkerHeads.mockResolvedValue([]);
    repo.discover.mockResolvedValue([]);
    const result = await worker.runSweep();
    expect(result.errors).toEqual([]);
    expect(worker.isBusy).toBe(false);
  });

  // 8. onModuleDestroy() clears the interval.
  it('onModuleDestroy() clears the interval', () => {
    const config = { get: (k: string) => (k === 'ENABLE_SCHEDULER' ? 'true' : undefined) } as unknown as ConfigService;
    const worker = new OrdinaryRecoverySweepWorker(
      repo as unknown as OrdinaryInvalidationRepository,
      recoveryService as unknown as OrdinaryInvalidationRecoveryService,
      bootstrapService as unknown as OrdinaryMarkerBootstrapService,
      config,
    );

    worker.onModuleInit();
    expect(worker.isScheduled).toBe(true);

    worker.onModuleDestroy();
    expect(worker.isScheduled).toBe(false);
  });

  // 9. No timer or asynchronous sweep continues unsafely after shutdown.
  it('no timer or asynchronous sweep continues unsafely after shutdown', () => {
    jest.useFakeTimers();
    try {
      const config = { get: (k: string) => (k === 'ENABLE_SCHEDULER' ? 'true' : undefined) } as unknown as ConfigService;
      const worker = new OrdinaryRecoverySweepWorker(
        repo as unknown as OrdinaryInvalidationRepository,
        recoveryService as unknown as OrdinaryInvalidationRecoveryService,
        bootstrapService as unknown as OrdinaryMarkerBootstrapService,
        config,
      );

      const runSweepSpy = jest.spyOn(worker, 'runSweep').mockResolvedValue({
        bootstrappedCount: 0,
        reconciledCount: 0,
        replayedCount: 0,
        readinessCount: 0,
        blockedCount: 0,
        errors: [],
      });

      worker.onModuleInit();
      worker.onModuleDestroy();

      jest.advanceTimersByTime(60000);
      expect(runSweepSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  // 10. Multiple worker instances cannot cause duplicate domain publication.
  it('multiple worker instances cannot cause duplicate domain publication', async () => {
    const worker1 = new OrdinaryRecoverySweepWorker(
      repo as unknown as OrdinaryInvalidationRepository,
      recoveryService as unknown as OrdinaryInvalidationRecoveryService,
      bootstrapService as unknown as OrdinaryMarkerBootstrapService,
    );
    const worker2 = new OrdinaryRecoverySweepWorker(
      repo as unknown as OrdinaryInvalidationRepository,
      recoveryService as unknown as OrdinaryInvalidationRecoveryService,
      bootstrapService as unknown as OrdinaryMarkerBootstrapService,
    );

    repo.discoverUnreadyEnrolledMarkerHeads.mockResolvedValue([
      { scope: 'MARKER:m1', incarnation: 'inc-1', epoch: 1 },
    ]);
    repo.discover.mockResolvedValue([]);

    let executionCount = 0;
    bootstrapService.bootstrap.mockImplementation(() => {
      executionCount++;
      if (executionCount > 1) {
        return Promise.resolve({ scope: 'MARKER:m1', markerId: 'm1', status: 'ALREADY_READY', revision: 1 });
      }
      return Promise.resolve({ scope: 'MARKER:m1', markerId: 'm1', status: 'READY', revision: 1 });
    });

    const [res1, res2] = await Promise.all([worker1.runSweep(), worker2.runSweep()]);
    expect(res1.bootstrappedCount + res2.bootstrappedCount).toBe(1);
    expect(bootstrapService.bootstrap).toHaveBeenCalledTimes(2);
  });
});
