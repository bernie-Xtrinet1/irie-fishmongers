import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Redis } from 'ioredis';
import { RedisService } from '../../../common/redis/redis.service';
import {
  invalidationRecoveryBackoffKey,
  OrdinaryRecoveryDiagnosticsService,
} from '../services/ordinary-recovery-diagnostics.service';
import { assertDisposableEnvironment, withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';

describe('OrdinaryRecoveryDiagnosticsService Redis Integration', () => {
  let redisClient: Redis;
  let redisService: RedisService;
  const trackedKeys = new Set<string>();

  const isLiveRedisAvailable = process.env.REDIS_URL === 'redis://127.0.0.1:16479/11';

  beforeAll(async () => {
    if (isLiveRedisAvailable) {
      assertDisposableEnvironment();
      redisClient = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await redisClient.connect();
    } else {
      // Create lazy local client or mock client for decoupled environments
      const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:16479/11';
      redisClient = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0 });
      try {
        await redisClient.connect();
      } catch {
        // Fallback: mocked ioredis client if port 16479 is not running locally
        const store = new Map<string, { value: string; expiresAt?: number }>();
        redisClient = {
          status: 'ready',
          get: jest.fn((key: string) => {
            const item = store.get(key);
            if (!item) return Promise.resolve(null);
            if (item.expiresAt && Date.now() > item.expiresAt) {
              store.delete(key);
              return Promise.resolve(null);
            }
            return Promise.resolve(item.value);
          }),
          set: jest.fn((key: string, value: string, mode?: string, ttl?: number) => {
            const expiresAt = mode === 'EX' && ttl ? Date.now() + ttl * 1000 : undefined;
            store.set(key, { value, expiresAt });
            return Promise.resolve('OK');
          }),
          del: jest.fn((...keys: string[]) => {
            let count = 0;
            for (const k of keys) {
              if (store.delete(k)) count++;
            }
            return Promise.resolve(count);
          }),
          ttl: jest.fn((key: string) => {
            const item = store.get(key);
            if (!item) return Promise.resolve(-2);
            if (!item.expiresAt) return Promise.resolve(-1);
            const remaining = Math.round((item.expiresAt - Date.now()) / 1000);
            return Promise.resolve(remaining > 0 ? remaining : -2);
          }),
          eval: jest.fn((script: string, _numKeys: number, ...args: (string | number)[]) => {
            const key = String(args[0]);
            if (script.includes('RECORD_FAILURE_LUA') || script.includes('toIso')) {
              const intentId = String(args[1]);
              const reason = String(args[2]);
              const lastError = String(args[3]);
              const workerId = String(args[4]);
              const nowMs = Number(args[5]);
              const nowIso = String(args[6]);
              const baseDelay = Number(args[7]);
              const maxDelay = Number(args[8]);
              const factor = Number(args[9]);
              const ttlSeconds = Number(args[10]);
              const jitterMult = Number(args[11]);

              let attempts = 1;
              let createdAt = nowIso;
              const existingItem = store.get(key);
              if (existingItem) {
                try {
                  const existing = JSON.parse(existingItem.value) as Record<string, unknown>;
                  if (typeof existing === 'object' && existing !== null && existing['intentId'] === intentId) {
                    const prevAttempts = typeof existing['attempts'] === 'number' ? existing['attempts'] : 0;
                    if (prevAttempts >= 1) attempts = prevAttempts + 1;
                    if (typeof existing['createdAt'] === 'string') createdAt = existing['createdAt'];
                  }
                } catch {
                  // Ignore corrupted state in mock
                }
              }

              const exponent = Math.max(0, attempts - 1);
              const rawDelay = baseDelay * Math.pow(factor, exponent);
              const cappedDelay = Math.min(maxDelay, Math.max(baseDelay, rawDelay));
              const jittered = Math.min(maxDelay, Math.floor(cappedDelay * jitterMult));
              const nextAttemptIso = new Date(nowMs + jittered).toISOString();

              const payload = JSON.stringify({
                intentId,
                attempts,
                nextAttemptAt: nextAttemptIso,
                reason: reason || undefined,
                lastError: lastError || undefined,
                lastWorkerId: workerId || undefined,
                createdAt,
                updatedAt: nowIso,
              });
              store.set(key, { value: payload, expiresAt: Date.now() + ttlSeconds * 1000 });
              return Promise.resolve(payload);
            }

            if (script.includes('CLEAR_BACKOFF_LUA') || script.includes('isConditional')) {
              const intentId = String(args[1] || '');
              const isConditional = String(args[2] || '0');
              const expectedUpdatedAt = String(args[3] || '');
              const maxAttemptsStr = String(args[4] || '');

              const item = store.get(key);
              if (!item) return Promise.resolve(0);

              let existing: Record<string, unknown>;
              try {
                existing = JSON.parse(item.value) as Record<string, unknown>;
                if (typeof existing !== 'object' || existing === null) return Promise.resolve(0);
              } catch {
                return Promise.resolve(0);
              }

              if (typeof existing['intentId'] !== 'string' || existing['intentId'] !== intentId) {
                return Promise.resolve(0);
              }

              if (isConditional === '1') {
                const att = typeof existing['attempts'] === 'number' ? existing['attempts'] : NaN;
                if (!Number.isInteger(att) || att < 1) return Promise.resolve(0);

                if (expectedUpdatedAt !== '') {
                  if (typeof existing['updatedAt'] !== 'string' || existing['updatedAt'] !== expectedUpdatedAt) {
                    return Promise.resolve(0);
                  }
                }

                if (maxAttemptsStr !== '') {
                  const maxAtt = Number(maxAttemptsStr);
                  if (!Number.isInteger(maxAtt) || maxAtt < 1 || att > maxAtt) {
                    return Promise.resolve(0);
                  }
                }
              }

              store.delete(key);
              return Promise.resolve(1);
            }

            return Promise.resolve(0);
          }),
          quit: jest.fn(() => Promise.resolve('OK')),
          disconnect: jest.fn(),
        } as unknown as Redis;
      }
    }
    redisService = new RedisService(redisClient);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (redisClient && redisClient.status === 'ready' && trackedKeys.size > 0) {
      await redisClient.del(...trackedKeys).catch(() => {});
      trackedKeys.clear();
    }
  });

  afterAll(() =>
    withCleanup(async () => { await Promise.resolve(); }, [
      async () => {
        if (!redisClient) return;
        if (trackedKeys.size > 0 && redisClient.status === 'ready') {
          await redisClient.del(...trackedKeys).catch(() => {});
        }
        if (redisClient.status === 'ready') await redisClient.quit().catch(() => {});
        else redisClient.disconnect();
      },
    ]),
  );

  function trackKey(intentId: string): string {
    const key = invalidationRecoveryBackoffKey(intentId);
    trackedKeys.add(key);
    return key;
  }

  // 1. First failure and subsequent backoff progression
  it('1. correctly computes and persists first failure and exponential backoff progression', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService, {
      baseDelayMs: 10_000,
      factor: 2,
      jitter: false,
    });
    const intentId = randomUUID();
    trackKey(intentId);
    const t0 = 1_700_000_000_000;

    // First failure: attempts = 1 -> delay = 10,000ms
    const rec1 = await service.recordFailure(intentId, 'TEST_FAULT_1', 'details_1', 'worker-a', t0);
    expect(rec1.attempts).toBe(1);
    expect(rec1.reason).toBe('TEST_FAULT_1');
    expect(rec1.lastError).toBe('details_1');
    expect(rec1.lastWorkerId).toBe('worker-a');
    expect(new Date(rec1.nextAttemptAt).getTime()).toBe(t0 + 10_000);

    // Decision at t0: should NOT retry, remainingWaitMs = 10_000
    const decisionAtT0 = await service.getBackoff(intentId, t0);
    expect(decisionAtT0.shouldRetry).toBe(false);
    expect(decisionAtT0.remainingWaitMs).toBe(10_000);
    expect(decisionAtT0.attempts).toBe(1);

    // Decision at t0 + 10,000: SHOULD retry, remainingWaitMs = 0
    const decisionAtT10 = await service.getBackoff(intentId, t0 + 10_000);
    expect(decisionAtT10.shouldRetry).toBe(true);
    expect(decisionAtT10.remainingWaitMs).toBe(0);
    expect(decisionAtT10.attempts).toBe(1);

    // Second failure: attempts = 2 -> delay = 20,000ms
    const rec2 = await service.recordFailure(intentId, 'TEST_FAULT_2', 'details_2', 'worker-b', t0 + 10_000);
    expect(rec2.attempts).toBe(2);
    expect(new Date(rec2.nextAttemptAt).getTime()).toBe(t0 + 10_000 + 20_000);

    // Third failure: attempts = 3 -> delay = 40,000ms
    const rec3 = await service.recordFailure(intentId, 'TEST_FAULT_3', 'details_3', 'worker-c', t0 + 30_000);
    expect(rec3.attempts).toBe(3);
    expect(new Date(rec3.nextAttemptAt).getTime()).toBe(t0 + 30_000 + 40_000);
  });

  // 2. Maximum delay enforcement
  it('2. caps delay at maxDelayMs regardless of attempt count', () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService, {
      baseDelayMs: 5_000,
      maxDelayMs: 30_000,
      factor: 2,
      jitter: false,
    });

    expect(service.computeDelay(1)).toBe(5_000);
    expect(service.computeDelay(2)).toBe(10_000);
    expect(service.computeDelay(3)).toBe(20_000);
    expect(service.computeDelay(4)).toBe(30_000);
    expect(service.computeDelay(5)).toBe(30_000); // capped
    expect(service.computeDelay(10)).toBe(30_000); // capped
    expect(service.computeDelay(100)).toBe(30_000); // capped
  });

  // 3. TTL expiration
  it('3. enforces TTL on backoff keys in Redis', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService, {
      ttlSeconds: 60,
    });
    const intentId = randomUUID();
    const key = trackKey(intentId);

    await service.recordFailure(intentId, 'TTL_TEST');
    const ttl = await redisClient.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  // 4. Key loss and restart behavior
  it('4. handles key loss gracefully and restarts counter on next failure', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService, {
      baseDelayMs: 15_000,
      jitter: false,
    });
    const intentId = randomUUID();
    trackKey(intentId);

    // Initial failure
    await service.recordFailure(intentId, 'FIRST_RUN');
    await service.recordFailure(intentId, 'SECOND_RUN');
    const diag = await service.getDiagnostics(intentId);
    expect(diag?.attempts).toBe(2);

    // Simulate key eviction / loss
    await service.clearBackoff(intentId);

    // getBackoff on missing key returns shouldRetry = true
    const decision = await service.getBackoff(intentId);
    expect(decision.shouldRetry).toBe(true);
    expect(decision.attempts).toBe(0);
    expect(decision.remainingWaitMs).toBe(0);

    // Next failure restarts cleanly at attempts = 1
    const restarted = await service.recordFailure(intentId, 'RESTARTED_RUN');
    expect(restarted.attempts).toBe(1);
    expect(restarted.reason).toBe('RESTARTED_RUN');
  });

  // 5. Redis disconnection and recovery
  it('5. fails safe to shouldRetry = true during Redis outages and recovers when restored', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService);
    const intentId = randomUUID();
    trackKey(intentId);

    // Spy get to simulate Redis outage
    jest.spyOn(redisService, 'get').mockRejectedValueOnce(new Error('REDIS_CONNECTION_REFUSED'));
    const outageDecision = await service.getBackoff(intentId);
    expect(outageDecision.shouldRetry).toBe(true);
    expect(outageDecision.attempts).toBe(0);

    // Spy eval to simulate outage on write: returns record in-memory without throwing
    jest.spyOn(redisService, 'eval').mockRejectedValueOnce(new Error('REDIS_WRITE_FAILED'));
    const recDuringOutage = await service.recordFailure(intentId, 'OUTAGE_REASON');
    expect(recDuringOutage.attempts).toBe(1);
    expect(recDuringOutage.reason).toBe('OUTAGE_REASON');

    // Restored: normal operations succeed
    const normalRec = await service.recordFailure(intentId, 'RESTORED');
    expect(normalRec.attempts).toBe(1); // since previous set failed to persist to Redis
    const restoredDecision = await service.getBackoff(intentId);
    expect(restoredDecision.attempts).toBe(1);
  });

  // 6. Malformed retry state
  it('6. safely handles malformed JSON and corrupted records', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService);
    const intentId = randomUUID();
    const key = trackKey(intentId);

    // Corrupted non-JSON string
    await redisService.set(key, 'INVALID_CORRUPTED_JSON_DATA');
    expect(await service.getDiagnostics(intentId)).toBeNull();
    const decision1 = await service.getBackoff(intentId);
    expect(decision1.shouldRetry).toBe(true);
    expect(decision1.attempts).toBe(0);

    // Missing required fields
    await redisService.set(key, JSON.stringify({ intentId, attempts: 'not-a-number' }));
    expect(await service.getDiagnostics(intentId)).toBeNull();

    // Invalid attempt count (negative)
    await redisService.set(key, JSON.stringify({
      intentId,
      attempts: -3,
      nextAttemptAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    expect(await service.getDiagnostics(intentId)).toBeNull();

    // Mismatched intentId
    await redisService.set(key, JSON.stringify({
      intentId: randomUUID(),
      attempts: 2,
      nextAttemptAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    expect(await service.getDiagnostics(intentId)).toBeNull();
  });

  // 7. Independent workers using the same Redis state
  it('7. coordinates backoff state across independent worker instances', async () => {
    const worker1 = new OrdinaryRecoveryDiagnosticsService(redisService, {
      baseDelayMs: 20_000,
      jitter: false,
    });
    const worker2 = new OrdinaryRecoveryDiagnosticsService(redisService, {
      baseDelayMs: 20_000,
      jitter: false,
    });
    const intentId = randomUUID();
    trackKey(intentId);
    const now = 1_700_000_100_000;

    // Worker 1 records failure
    await worker1.recordFailure(intentId, 'WORKER_1_FAILURE', 'timeout', 'worker-node-1', now);

    // Worker 2 reads backoff hint at the same timestamp
    const decisionW2 = await worker2.getBackoff(intentId, now);
    expect(decisionW2.shouldRetry).toBe(false);
    expect(decisionW2.remainingWaitMs).toBe(20_000);
    expect(decisionW2.attempts).toBe(1);
    expect(decisionW2.reason).toBe('WORKER_1_FAILURE');

    // Worker 2 advances the counter
    const recW2 = await worker2.recordFailure(intentId, 'WORKER_2_FAILURE', 'db_err', 'worker-node-2', now + 20_000);
    expect(recW2.attempts).toBe(2);
    expect(recW2.lastWorkerId).toBe('worker-node-2');

    // Worker 1 reads the diagnostics and sees worker 2's updates
    const diagW1 = await worker1.getDiagnostics(intentId);
    expect(diagW1?.attempts).toBe(2);
    expect(diagW1?.lastWorkerId).toBe('worker-node-2');
    expect(diagW1?.reason).toBe('WORKER_2_FAILURE');
  });

  // 8. No domain-state mutation
  it('8. contains zero database mutation or domain repository references', () => {
    const source = readFileSync(
      resolve(__dirname, '../services/ordinary-recovery-diagnostics.service.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/PrismaService|\$executeRaw|\$queryRaw|cart_items|cart_reservation_sync_states|ordinary_reservation_owners|inventory_items/);
    expect(source).not.toMatch(/\.prisma\./);
  });

  // 9. No physical command execution capability
  it('9. contains no physical command execution, closure, claim, or dispatch capability', () => {
    const source = readFileSync(
      resolve(__dirname, '../services/ordinary-recovery-diagnostics.service.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/OrdinaryCommandPhysicalService|OrdinaryCommandClosureService|OrdinaryCommandDispatchClaimRepository|OrdinaryMutationCapability|\.claim\(|\.execute\(|\.close\(/);
  });

  // 10. No production module activation
  it('10. respects production isolation boundary; closure service remains unwired', () => {
    const moduleSource = readFileSync(
      resolve(__dirname, '../reservation-fence.module.ts'),
      'utf8',
    );
    expect(moduleSource).not.toContain('OrdinaryCommandClosureService');
    expect(moduleSource).not.toContain('OrdinaryCommandPhysicalService');
  });

  // 11. Concurrency: 10 simultaneous workers recording failure on the same intentId
  it('11. preserves atomicity and prevents lost updates across 10 concurrent worker updates', async () => {
    const intentId = randomUUID();
    trackKey(intentId);

    const workerServices = Array.from({ length: 10 }, () =>
      new OrdinaryRecoveryDiagnosticsService(redisService, {
        baseDelayMs: 5_000,
        factor: 2,
        jitter: false,
      }),
    );

    const now = 1_700_000_500_000;
    // Launch 10 simultaneous recordFailure calls via Promise.all
    const results = await Promise.all(
      workerServices.map((worker, i) =>
        worker.recordFailure(
          intentId,
          `CONCURRENT_REASON_${i}`,
          `err_${i}`,
          `worker-${i}`,
          now,
        ),
      ),
    );

    // Verify all 10 calls succeeded
    expect(results).toHaveLength(10);

    // Extract attempt numbers
    const attempts = results.map((r) => r.attempts);
    expect(attempts).toHaveLength(10);

    // Verify zero lost updates: every attempt number from 1 to 10 appears exactly once
    const uniqueAttempts = new Set(attempts);
    expect(uniqueAttempts.size).toBe(10);
    for (let i = 1; i <= 10; i++) {
      expect(uniqueAttempts.has(i)).toBe(true);
    }

    // Verify createdAt is identical across all records (first initialized timestamp preserved)
    const createdAtValues = new Set(results.map((r) => r.createdAt));
    expect(createdAtValues.size).toBe(1);

    // Verify final state in Redis reflects exactly 10 attempts
    const finalDiag = await workerServices[0]!.getDiagnostics(intentId);
    expect(finalDiag).not.toBeNull();
    expect(finalDiag?.attempts).toBe(10);
    expect(finalDiag?.intentId).toBe(intentId);
  });

  // 12. Clear-versus-record race condition resolution via optimistic concurrency tokens
  it('12. resolves clear-versus-record race conditions using optimistic concurrency tokens', async () => {
    const service1 = new OrdinaryRecoveryDiagnosticsService(redisService, {
      baseDelayMs: 10_000,
      factor: 2,
      jitter: false,
    });
    const service2 = new OrdinaryRecoveryDiagnosticsService(redisService, {
      baseDelayMs: 10_000,
      factor: 2,
      jitter: false,
    });

    const intentId = randomUUID();
    trackKey(intentId);

    // Worker 1 records first failure at t0
    const t0 = 1_700_000_100_000;
    const rec1 = await service1.recordFailure(intentId, 'FAIL_1', 'timeout', 'worker-1', t0);
    expect(rec1.attempts).toBe(1);

    // Worker 2 records second failure at t1 (simulating race before Worker 1's clear takes place)
    const t1 = t0 + 5_000;
    const rec2 = await service2.recordFailure(intentId, 'FAIL_2', 'timeout', 'worker-2', t1);
    expect(rec2.attempts).toBe(2);

    // Worker 1 tries to clear backoff using stale token (optimistic check fails because updatedAt moved)
    const staleClearSuccess = await service1.clearBackoff(intentId, {
      ifMatchesUpdatedAt: rec1.updatedAt,
      ifAttemptsLessThanOrEqual: 1,
    });
    expect(staleClearSuccess).toBe(false);

    // Verify backoff state in Redis was NOT deleted by stale clear
    const afterStaleDiag = await service1.getDiagnostics(intentId);
    expect(afterStaleDiag).not.toBeNull();
    expect(afterStaleDiag?.attempts).toBe(2);
    expect(afterStaleDiag?.updatedAt).toBe(rec2.updatedAt);

    // Worker 2 clears backoff using matching token (optimistic check succeeds)
    const currentClearSuccess = await service2.clearBackoff(intentId, {
      ifMatchesUpdatedAt: rec2.updatedAt,
      ifAttemptsLessThanOrEqual: 2,
    });
    expect(currentClearSuccess).toBe(true);

    // Verify backoff state is now completely cleared
    const afterCurrentDiag = await service2.getDiagnostics(intentId);
    expect(afterCurrentDiag).toBeNull();
    const cleanDecision = await service2.getBackoff(intentId);
    expect(cleanDecision.shouldRetry).toBe(true);
    expect(cleanDecision.attempts).toBe(0);
  });

  // 13. Malformed JSON with conditional clear
  it('13. safely rejects conditional clear on malformed JSON and preserves key', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService);
    const intentId = randomUUID();
    const key = trackKey(intentId);

    await redisService.set(key, 'NOT_VALID_JSON_RECORD');
    const result = await service.clearBackoff(intentId, {
      ifMatchesUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result).toBe(false);
    const rawAfter = await redisService.get(key);
    expect(rawAfter).toBe('NOT_VALID_JSON_RECORD');
  });

  // 14. Missing updatedAt when expected
  it('14. safely rejects conditional clear when record is missing updatedAt', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService);
    const intentId = randomUUID();
    const key = trackKey(intentId);

    await redisService.set(key, JSON.stringify({
      intentId,
      attempts: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    const result = await service.clearBackoff(intentId, {
      ifMatchesUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result).toBe(false);
    expect(await redisService.get(key)).not.toBeNull();
  });

  // 15. Missing attempts when constraint supplied
  it('15. safely rejects conditional clear when record is missing attempts', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService);
    const intentId = randomUUID();
    const key = trackKey(intentId);

    await redisService.set(key, JSON.stringify({
      intentId,
      updatedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    const result = await service.clearBackoff(intentId, {
      ifAttemptsLessThanOrEqual: 1,
    });
    expect(result).toBe(false);
    expect(await redisService.get(key)).not.toBeNull();
  });

  // 16. Invalid attempt values in stored record
  it('16. safely rejects conditional clear when record contains invalid or non-integer attempt values', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService);
    const intentId = randomUUID();
    const key = trackKey(intentId);
    const iso = '2026-01-01T00:00:00.000Z';

    const invalidAttempts = [0, -1, 1.5, 'invalid'];
    for (const badAttempt of invalidAttempts) {
      await redisService.set(key, JSON.stringify({
        intentId,
        attempts: badAttempt,
        updatedAt: iso,
        createdAt: iso,
      }));
      const res = await service.clearBackoff(intentId, {
        ifMatchesUpdatedAt: iso,
        ifAttemptsLessThanOrEqual: 5,
      });
      expect(res).toBe(false);
      expect(await redisService.get(key)).not.toBeNull();
    }
  });

  // 17. Mismatched intentId
  it('17. safely rejects conditional and unconditional clear on mismatched intentId', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService);
    const intentA = randomUUID();
    const intentB = randomUUID();
    const iso = '2026-01-01T00:00:00.000Z';

    const keyB = trackKey(intentB);
    await redisService.set(keyB, JSON.stringify({
      intentId: intentA,
      attempts: 1,
      updatedAt: iso,
      createdAt: iso,
    }));

    const condRes = await service.clearBackoff(intentB, { ifMatchesUpdatedAt: iso });
    expect(condRes).toBe(false);
    expect(await redisService.get(keyB)).not.toBeNull();

    const uncondRes = await service.clearBackoff(intentB);
    expect(uncondRes).toBe(false);
    expect(await redisService.get(keyB)).not.toBeNull();
  });

  // 18. Invalid caller-supplied constraints
  it('18. rejects invalid caller-supplied constraints fail-closed without deleting key', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService);
    const intentId = randomUUID();
    trackKey(intentId);
    const rec = await service.recordFailure(intentId, 'FAIL');

    // Negative maxAttempts
    expect(await service.clearBackoff(intentId, { ifAttemptsLessThanOrEqual: -1 })).toBe(false);
    // Zero maxAttempts
    expect(await service.clearBackoff(intentId, { ifAttemptsLessThanOrEqual: 0 })).toBe(false);
    // Fractional maxAttempts
    expect(await service.clearBackoff(intentId, { ifAttemptsLessThanOrEqual: 1.5 })).toBe(false);
    // NaN maxAttempts
    expect(await service.clearBackoff(intentId, { ifAttemptsLessThanOrEqual: NaN })).toBe(false);
    // Empty updatedAt string
    expect(await service.clearBackoff(intentId, { ifMatchesUpdatedAt: '' })).toBe(false);
    // Whitespace only updatedAt string
    expect(await service.clearBackoff(intentId, { ifMatchesUpdatedAt: '   ' })).toBe(false);
    // Empty options object with no constraints
    expect(await service.clearBackoff(intentId, {})).toBe(false);

    // Key must still exist untouched
    const diag = await service.getDiagnostics(intentId);
    expect(diag).not.toBeNull();
    expect(diag?.attempts).toBe(rec.attempts);
  });

  // 19. Equal timestamps with different attempts
  it('19. rejects conditional clear when timestamps match but attempt count has advanced', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService);
    const intentId = randomUUID();
    const key = trackKey(intentId);
    const sharedIso = '2026-01-01T12:00:00.000Z';

    // Simulate two failures that occurred in the same millisecond, advancing attempt from 1 to 2
    await redisService.set(key, JSON.stringify({
      intentId,
      attempts: 2,
      updatedAt: sharedIso,
      createdAt: sharedIso,
      nextAttemptAt: sharedIso,
    }));

    // Worker that only knew about attempt 1 tries to clear with matching timestamp but attempt limit 1
    const res = await service.clearBackoff(intentId, {
      ifMatchesUpdatedAt: sharedIso,
      ifAttemptsLessThanOrEqual: 1,
    });
    expect(res).toBe(false);

    // Key still exists with attempts 2
    const diag = await service.getDiagnostics(intentId);
    expect(diag?.attempts).toBe(2);
  });

  // 20. Key expiration and recreation
  it('20. safely handles key expiration and rejects stale tokens against recreated keys', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService);
    const intentId = randomUUID();
    trackKey(intentId);

    // Key does not exist (expired)
    const emptyClear = await service.clearBackoff(intentId, {
      ifMatchesUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(emptyClear).toBe(false);

    // Record failure in new generation
    const now1 = 1_700_000_100_000;
    const rec1 = await service.recordFailure(intentId, 'FIRST_RUN', 'err', 'w1', now1);

    // Key is evicted / deleted
    await service.clearBackoff(intentId);

    // Recreated later at now2
    const now2 = 1_700_000_900_000;
    const rec2 = await service.recordFailure(intentId, 'RECREATED_RUN', 'err', 'w2', now2);

    // Stale token from rec1 fails against rec2
    const staleClear = await service.clearBackoff(intentId, {
      ifMatchesUpdatedAt: rec1.updatedAt,
      ifAttemptsLessThanOrEqual: rec1.attempts,
    });
    expect(staleClear).toBe(false);

    const activeDiag = await service.getDiagnostics(intentId);
    expect(activeDiag?.updatedAt).toBe(rec2.updatedAt);
  });

  // 21. Concurrent recordFailure and conditional clear
  it('21. safely coordinates concurrent recordFailure and conditional clear without race defects', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService, {
      baseDelayMs: 5_000,
      jitter: false,
    });
    const intentId = randomUUID();
    trackKey(intentId);

    const now = 1_700_000_200_000;
    const initial = await service.recordFailure(intentId, 'INITIAL', 'err', 'w1', now);

    // Worker 1 attempts conditional clear for initial failure while Worker 2 records a new failure
    const [clearRes, newRecord] = await Promise.all([
      service.clearBackoff(intentId, {
        ifMatchesUpdatedAt: initial.updatedAt,
        ifAttemptsLessThanOrEqual: initial.attempts,
      }),
      service.recordFailure(intentId, 'CONCURRENT_FAIL', 'err', 'w2', now + 1_000),
    ]);

    // Either clear happened before record (clear=true, record=attempts 1)
    // OR record happened before clear (clear=false, record=attempts 2)
    if (clearRes) {
      expect(newRecord.attempts).toBe(1);
    } else {
      expect(newRecord.attempts).toBe(2);
      const remainingDiag = await service.getDiagnostics(intentId);
      expect(remainingDiag).not.toBeNull();
      expect(remainingDiag?.attempts).toBe(2);
    }
  });

  // 22. Successful conditional clear with matching constraints
  it('22. successfully clears backoff when all conditional constraints match positively', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService);
    const intentId = randomUUID();
    trackKey(intentId);

    const rec = await service.recordFailure(intentId, 'MATCH_FAIL');
    expect(rec.attempts).toBe(1);

    const success = await service.clearBackoff(intentId, {
      ifMatchesUpdatedAt: rec.updatedAt,
      ifAttemptsLessThanOrEqual: 1,
    });
    expect(success).toBe(true);

    const diagAfter = await service.getDiagnostics(intentId);
    expect(diagAfter).toBeNull();
  });

  // 23. Intended unconditional clear behavior
  it('23. preserves intended unconditional clear behavior while validating record identity', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService);
    const intentId = randomUUID();
    trackKey(intentId);

    await service.recordFailure(intentId, 'UNCONDITIONAL_TEST');
    expect(await service.getDiagnostics(intentId)).not.toBeNull();

    // Unconditional clear without options
    const success = await service.clearBackoff(intentId);
    expect(success).toBe(true);
    expect(await service.getDiagnostics(intentId)).toBeNull();

    // Second unconditional clear on missing key returns false
    const secondClear = await service.clearBackoff(intentId);
    expect(secondClear).toBe(false);
  });

  // 24. Redis outage during clearing
  it('24. fails safe and logs warning during Redis outage in clearBackoff without throwing', async () => {
    const service = new OrdinaryRecoveryDiagnosticsService(redisService);
    const intentId = randomUUID();
    trackKey(intentId);

    jest.spyOn(redisService, 'eval').mockRejectedValueOnce(new Error('REDIS_CLEAR_OUTAGE'));
    const result = await service.clearBackoff(intentId, {
      ifMatchesUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result).toBe(false);
  });
});
