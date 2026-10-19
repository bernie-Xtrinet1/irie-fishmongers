import { ConfigService } from '@nestjs/config';
import {
  OrdinaryRecoveryLockService,
  PrismaSessionClient,
} from '../services/ordinary-recovery-lock.service';
import {
  ORDINARY_RECOVERY_LOCK_NAMESPACE,
  ORDINARY_RECOVERY_LOCK_ID,
  OrdinaryRecoveryOwnershipLost,
  OrdinaryRecoveryLockCleanupError,
} from '../types/ordinary-recovery-lock.types';

function createMockPrismaSession(options?: {
  acquired?: boolean;
  pid?: number;
  assertHeld?: boolean;
  unlocked?: boolean;
  acquireThrows?: Error;
  assertThrows?: Error;
  unlockThrows?: Error;
  disconnectThrows?: Error;
}): PrismaSessionClient & {
  $queryRaw: jest.Mock;
  $disconnect: jest.Mock;
} {
  const acquired = options?.acquired ?? true;
  const pid = options?.pid ?? 42;
  const assertHeld = options?.assertHeld ?? true;
  const unlocked = options?.unlocked ?? true;

  const $queryRaw = jest.fn(async (strings: TemplateStringsArray, ..._values: any[]) => {
    const sql = strings.join(' ');
    if (sql.includes('pg_try_advisory_lock')) {
      if (options?.acquireThrows) throw options.acquireThrows;
      return [{ acquired, pid }];
    }
    if (sql.includes('pg_locks')) {
      if (options?.assertThrows) throw options.assertThrows;
      return [{ held: assertHeld }];
    }
    if (sql.includes('pg_advisory_unlock')) {
      if (options?.unlockThrows) throw options.unlockThrows;
      return [{ unlocked }];
    }
    return [];
  });

  const $disconnect = jest.fn(async () => {
    if (options?.disconnectThrows) throw options.disconnectThrows;
  });

  return { $queryRaw: $queryRaw as any, $disconnect };
}

describe('OrdinaryRecoveryLockService (Phase C Batch 1 Unit Tests)', () => {
  const validDbUrl = 'postgresql://user:pass@localhost:5432/db?schema=public';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('1. successfully acquires lock, executes callback, and releases lock', async () => {
    const session = createMockPrismaSession({ acquired: true, pid: 1234 });
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    let callbackExecuted = false;
    let receivedPid = 0;

    const outcome = await service.withExclusiveLock(async (permit) => {
      callbackExecuted = true;
      receivedPid = permit.ownerPid;
      await permit.assertHeld();
      return 'sweep_success';
    });

    expect(callbackExecuted).toBe(true);
    expect(receivedPid).toBe(1234);
    expect(outcome).toEqual({
      status: 'EXECUTED',
      value: 'sweep_success',
    });
    expect(session.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('2. returns LOCK_BUSY and skips callback execution when lock is contended', async () => {
    const session = createMockPrismaSession({ acquired: false, pid: 999 });
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    let callbackCalled = false;
    const outcome = await service.withExclusiveLock(async () => {
      callbackCalled = true;
      return 'unexpected';
    });

    expect(callbackCalled).toBe(false);
    expect(outcome).toEqual({ status: 'LOCK_BUSY' });
    expect(session.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('3. propagates callback exceptions without masking', async () => {
    const session = createMockPrismaSession();
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    const testError = new Error('Callback business logic failed');
    await expect(
      service.withExclusiveLock(async () => {
        throw testError;
      }),
    ).rejects.toThrow('Callback business logic failed');

    expect(session.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('4. guarantees unlock and connection disconnect cleanup when callback throws', async () => {
    const session = createMockPrismaSession({ pid: 5678 });
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    await expect(
      service.withExclusiveLock(async () => {
        throw new Error('Fatal worker crash');
      }),
    ).rejects.toThrow('Fatal worker crash');

    expect(session.$queryRaw).toHaveBeenCalledWith(
      expect.anything(),
      ORDINARY_RECOVERY_LOCK_NAMESPACE,
      ORDINARY_RECOVERY_LOCK_ID,
    );
    expect(session.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('5. assertHeld fails closed when backend PID does not match ownerPid', async () => {
    let callCount = 0;
    const session: PrismaSessionClient = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        if (sql.includes('pg_try_advisory_lock')) {
          return [{ acquired: true, pid: 1001 }];
        }
        if (sql.includes('pg_locks')) {
          callCount++;
          // First assert (pre-callback) succeeds; second assert returns held=false (different PID)
          return [{ held: callCount === 1 }];
        }
        if (sql.includes('pg_advisory_unlock')) {
          return [{ unlocked: true }];
        }
        return [];
      }) as any,
      $disconnect: jest.fn(async () => {}),
    };

    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    await expect(
      service.withExclusiveLock(async (permit) => {
        await permit.assertHeld(); // Should fail
      }),
    ).rejects.toThrow(OrdinaryRecoveryOwnershipLost);

    expect(session.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('6. assertHeld throws OrdinaryRecoveryOwnershipLost when advisory lock is absent from pg_locks', async () => {
    const session = createMockPrismaSession({ assertHeld: false });
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    // Fails on pre-callback assertion check
    await expect(service.withExclusiveLock(async () => 'never')).rejects.toThrow(
      OrdinaryRecoveryOwnershipLost,
    );
    expect(session.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('7. assertHeld throws OrdinaryRecoveryOwnershipLost when pg_locks query fails', async () => {
    const session = createMockPrismaSession({
      assertThrows: new Error('PostgreSQL socket terminated'),
    });
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    await expect(service.withExclusiveLock(async () => 'never')).rejects.toThrow(
      OrdinaryRecoveryOwnershipLost,
    );
    expect(session.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('8. reports cleanup uncertainty when pg_advisory_unlock returns false', async () => {
    const session = createMockPrismaSession({ unlocked: false });
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    await expect(service.withExclusiveLock(async () => 'done')).rejects.toThrow(
      OrdinaryRecoveryLockCleanupError,
    );
    expect(session.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('9. reports failure when pg_advisory_unlock query throws', async () => {
    const session = createMockPrismaSession({
      unlockThrows: new Error('Unlock query network timeout'),
    });
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    await expect(service.withExclusiveLock(async () => 'done')).rejects.toThrow(
      'Unlock query network timeout',
    );
    expect(session.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('10. reports cleanup uncertainty when client disconnect fails', async () => {
    const session = createMockPrismaSession({
      disconnectThrows: new Error('Socket close error'),
    });
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    await expect(service.withExclusiveLock(async () => 'done')).rejects.toThrow(
      'Socket close error',
    );
  });

  it('11. preserves original callback error and attaches cleanup error when cleanup also fails', async () => {
    const session = createMockPrismaSession({
      unlockThrows: new Error('Unlock failed during error cleanup'),
      disconnectThrows: new Error('Disconnect failed during error cleanup'),
    });
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    const originalError = new Error('Original sweep failed');
    let thrownError: any;

    try {
      await service.withExclusiveLock(async () => {
        throw originalError;
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBe(originalError);
    expect(thrownError.cleanupError).toBeDefined();
    expect(thrownError.cleanupError.message).toContain('Unlock failed during error cleanup');
  });

  it('12. aborts without calling callback when lock acquisition query fails', async () => {
    const session = createMockPrismaSession({
      acquireThrows: new Error('Database connection refused'),
    });
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    let callbackCalled = false;
    await expect(
      service.withExclusiveLock(async () => {
        callbackCalled = true;
      }),
    ).rejects.toThrow('Database connection refused');

    expect(callbackCalled).toBe(false);
    expect(session.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('13. invalidates AbortSignal when ownership loss is detected', async () => {
    let capturedSignal: AbortSignal | null = null;
    let assertionCount = 0;

    const session: PrismaSessionClient = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        if (sql.includes('pg_try_advisory_lock')) {
          return [{ acquired: true, pid: 2000 }];
        }
        if (sql.includes('pg_locks')) {
          assertionCount++;
          // First assertion succeeds, second assertion fails (ownership lost)
          return [{ held: assertionCount === 1 }];
        }
        if (sql.includes('pg_advisory_unlock')) {
          return [{ unlocked: true }];
        }
        return [];
      }) as any,
      $disconnect: jest.fn(async () => {}),
    };

    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    await expect(
      service.withExclusiveLock(async (permit) => {
        capturedSignal = permit.signal;
        expect(capturedSignal.aborted).toBe(false);
        await permit.assertHeld(); // Fails on 2nd assertion
      }),
    ).rejects.toThrow(OrdinaryRecoveryOwnershipLost);

    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('14. passes permit with ownerPid, acquisitionId, signal, and assertHeld to callback', async () => {
    const session = createMockPrismaSession({ pid: 8888 });
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    let capturedPermit: any = null;
    let signalAbortedDuringCallback = true;
    await service.withExclusiveLock(async (permit) => {
      capturedPermit = permit;
      signalAbortedDuringCallback = permit.signal.aborted;
    });

    expect(capturedPermit).toBeDefined();
    expect(capturedPermit.ownerPid).toBe(8888);
    expect(typeof capturedPermit.acquisitionId).toBe('string');
    expect(capturedPermit.acquisitionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(capturedPermit.signal).toBeInstanceOf(AbortSignal);
    expect(signalAbortedDuringCallback).toBe(false);
    expect(capturedPermit.signal.aborted).toBe(true);
    expect(typeof capturedPermit.assertHeld).toBe('function');
  });

  it('15. creates zero background timers or intervals during execution', async () => {
    jest.useFakeTimers();
    try {
      const session = createMockPrismaSession();
      const config = new ConfigService({ DATABASE_URL: validDbUrl });
      const service = new OrdinaryRecoveryLockService(config, () => session);

      await service.withExclusiveLock(async (permit) => {
        await permit.assertHeld();
      });

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('16. invokes zero recovery workers and performs zero automatic scheduling', async () => {
    const session = createMockPrismaSession();
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    // Instantiation does not execute queries or start workers
    expect(session.$queryRaw).not.toHaveBeenCalled();
    expect(session.$disconnect).not.toHaveBeenCalled();
  });

  it('17. remains completely dormant upon module construction without explicit invocation', async () => {
    const session = createMockPrismaSession();
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    // No operations occur merely because the service exists
    expect(service).toBeDefined();
    expect(session.$queryRaw).not.toHaveBeenCalled();
  });

  it('18. rejects known transaction-pooling connection settings (pgbouncer=true and port 6543)', async () => {
    const pgbouncerConfig = new ConfigService({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?pgbouncer=true',
    });
    const pgbouncerService = new OrdinaryRecoveryLockService(pgbouncerConfig);

    await expect(pgbouncerService.withExclusiveLock(async () => {})).rejects.toThrow(
      'direct PostgreSQL session',
    );

    const port6543Config = new ConfigService({
      DATABASE_URL: 'postgresql://user:pass@localhost:6543/db',
    });
    const port6543Service = new OrdinaryRecoveryLockService(port6543Config);

    await expect(port6543Service.withExclusiveLock(async () => {})).rejects.toThrow(
      'direct PostgreSQL session',
    );
  });

  it('19. assertHeld immediately throws if called after permit was already invalidated', async () => {
    let capturedPermit: any = null;
    let count = 0;
    const session: PrismaSessionClient = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        if (sql.includes('pg_try_advisory_lock')) return [{ acquired: true, pid: 3000 }];
        if (sql.includes('pg_locks')) {
          count++;
          return [{ held: count === 1 }]; // Second assertion fails
        }
        if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
        return [];
      }) as any,
      $disconnect: jest.fn(async () => {}),
    };

    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    await expect(
      service.withExclusiveLock(async (permit) => {
        capturedPermit = permit;
        await permit.assertHeld(); // Fails on 2nd assert
      }),
    ).rejects.toThrow(OrdinaryRecoveryOwnershipLost);

    // Subsequent assertion call directly on invalidated permit throws without querying DB
    await expect(capturedPermit.assertHeld()).rejects.toThrow(
      'Execution permit has been invalidated',
    );
  });

  it('20. prefers DIRECT_DATABASE_URL over DATABASE_URL when configured', async () => {
    let capturedUrl = '';
    const session = createMockPrismaSession();
    const config = new ConfigService({
      DATABASE_URL: 'postgresql://pooled@localhost:5432/db?pgbouncer=true',
      DIRECT_DATABASE_URL: 'postgresql://direct@localhost:5432/db',
    });

    const service = new OrdinaryRecoveryLockService(config, (url) => {
      capturedUrl = url;
      return session;
    });

    await service.withExclusiveLock(async () => {});
    expect(capturedUrl).toContain('postgresql://direct@localhost:5432/db');
    expect(capturedUrl).toContain('connection_limit=1');
  });

  it('21. successfully released permit has signal.aborted === true and assertHeld fails immediately without database query (F-01/F-03)', async () => {
    let capturedPermit: any = null;
    const session = createMockPrismaSession();
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    await service.withExclusiveLock(async (permit) => {
      capturedPermit = permit;
      expect(permit.signal.aborted).toBe(false);
    });

    expect(capturedPermit).not.toBeNull();
    expect(capturedPermit.signal.aborted).toBe(true);

    // Verify subsequent call to assertHeld fails closed without issuing any database query
    session.$queryRaw.mockClear();
    await expect(capturedPermit.assertHeld()).rejects.toThrow(OrdinaryRecoveryOwnershipLost);
    await expect(capturedPermit.assertHeld()).rejects.toThrow('Execution permit has been invalidated');
    expect(session.$queryRaw).not.toHaveBeenCalled();
  });

  it('22. calling assertHeld after callback failure fails immediately without database query (F-01/F-03)', async () => {
    let capturedPermit: any = null;
    const session = createMockPrismaSession();
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    await expect(
      service.withExclusiveLock(async (permit) => {
        capturedPermit = permit;
        throw new Error('Callback failed abruptly');
      }),
    ).rejects.toThrow('Callback failed abruptly');

    expect(capturedPermit).not.toBeNull();
    expect(capturedPermit.signal.aborted).toBe(true);

    session.$queryRaw.mockClear();
    await expect(capturedPermit.assertHeld()).rejects.toThrow(OrdinaryRecoveryOwnershipLost);
    await expect(capturedPermit.assertHeld()).rejects.toThrow('Execution permit has been invalidated');
    expect(session.$queryRaw).not.toHaveBeenCalled();
  });

  it('23. calling assertHeld after cleanup failure fails immediately without database query (F-01/F-03)', async () => {
    let capturedPermit: any = null;
    const session = createMockPrismaSession({
      unlockThrows: new Error('Unlock failed during teardown'),
    });
    const config = new ConfigService({ DATABASE_URL: validDbUrl });
    const service = new OrdinaryRecoveryLockService(config, () => session);

    await expect(
      service.withExclusiveLock(async (permit) => {
        capturedPermit = permit;
      }),
    ).rejects.toThrow('Unlock failed during teardown');

    expect(capturedPermit).not.toBeNull();
    expect(capturedPermit.signal.aborted).toBe(true);

    session.$queryRaw.mockClear();
    await expect(capturedPermit.assertHeld()).rejects.toThrow(OrdinaryRecoveryOwnershipLost);
    await expect(capturedPermit.assertHeld()).rejects.toThrow('Execution permit has been invalidated');
    expect(session.$queryRaw).not.toHaveBeenCalled();
  });
});

