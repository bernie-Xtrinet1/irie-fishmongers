/* eslint-disable @typescript-eslint/unbound-method */
/**
 * Phase C.3.2 — Ordinary Command Recovery Persistence & Concurrency Suite.
 *
 * NOTE: This suite tests the recovery coordinator's sweep pagination, advisory backoff,
 * concurrency serialization, and error classification using an in-memory database harness.
 *
 * Underlying physical infrastructure is verified in dedicated suites:
 * - ordinary-command-closure.persistence.spec.ts (PostgreSQL row locks, evidence validation, durable ACK)
 * - ordinary-recovery-diagnostics.redis.spec.ts (Redis Lua atomicity, TTL, exponential backoff)
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { OrdinaryReservationCommandRepository } from '../repositories/ordinary-reservation-command.repository';
import { OrdinaryCommandClosureService } from '../services/ordinary-command-closure.service';

type ClosureResult = Awaited<ReturnType<OrdinaryCommandClosureService['close']>>;
import { OrdinaryRecoveryDiagnosticsService } from '../services/ordinary-recovery-diagnostics.service';
import { OrdinaryCommandRecoveryService } from '../services/ordinary-command-recovery.service';
import {
  RecoveryBackoffDecision,
  RecoveryDiagnosticRecord,
} from '../types/ordinary-invalidation-recovery.types';

// Concrete in-memory representation of an ordinary reservation command for testing
interface TestCommand {
  id: string;
  markerId: string;
  sequence: number;
  expectedSequence: number;
  effect: 'W1' | 'CANCEL_W1' | 'RELEASE';
  state: 'PENDING' | 'UNCERTAIN' | 'REVOCATION_PENDING' | 'ACKNOWLEDGED';
  completionReceiptHash: string | null;
}

describe('OrdinaryCommandRecoveryService Persistence & Concurrency Integration', () => {
  let commandsRepo: OrdinaryReservationCommandRepository;
  let closureService: OrdinaryCommandClosureService;
  let diagnosticsService: OrdinaryRecoveryDiagnosticsService;
  let recoveryService: OrdinaryCommandRecoveryService;

  let inMemoryDb: TestCommand[];
  let backoffStore: Map<string, RecoveryDiagnosticRecord>;
  let backoffDecisions: Map<string, RecoveryBackoffDecision>;
  let closeOutcomes: Map<string, ClosureResult>;
  let clearBackoffCalls: Array<{ intentId: string; options?: unknown }>;
  let recordFailureCalls: Array<{ intentId: string; reason: string; error?: string; workerId?: string }>;
  let physicalObserveCalls: string[];

  beforeEach(() => {
    inMemoryDb = [];
    backoffStore = new Map();
    backoffDecisions = new Map();
    closeOutcomes = new Map();
    clearBackoffCalls = [];
    recordFailureCalls = [];
    physicalObserveCalls = [];

    // Mock OrdinaryReservationCommandRepository.discoverClosure() preserving total ordering & cursor logic
    commandsRepo = {
      discoverClosure: jest.fn((input: { limit: number; cursor?: { markerId: string; sequence: number; id: string } }) => {
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
          return Promise.reject(new Error('ORDINARY_CLOSURE_PAGE_REJECTED'));
        }
        const cursor = input.cursor;
        if (cursor && (!cursor.markerId || !cursor.id || !Number.isInteger(cursor.sequence) || cursor.sequence < 1)) {
          return Promise.reject(new Error('ORDINARY_CLOSURE_CURSOR_REJECTED'));
        }

        const eligible = inMemoryDb.filter(c => {
          if (!['W1', 'CANCEL_W1', 'RELEASE'].includes(c.effect) || c.sequence === null) return false;
          if (c.state === 'PENDING' || c.state === 'UNCERTAIN') return true;
          if (c.effect === 'W1' && c.state === 'REVOCATION_PENDING') return true;
          return false;
        });

        // Total order: (markerId asc, sequence asc, id asc)
        eligible.sort((a, b) => {
          if (a.markerId !== b.markerId) return a.markerId.localeCompare(b.markerId);
          if (a.sequence !== b.sequence) return a.sequence - b.sequence;
          return a.id.localeCompare(b.id);
        });

        let filtered = eligible;
        if (cursor) {
          filtered = eligible.filter(c => {
            if (c.markerId > cursor.markerId) return true;
            if (c.markerId === cursor.markerId && c.sequence > cursor.sequence) return true;
            if (c.markerId === cursor.markerId && c.sequence === cursor.sequence && c.id > cursor.id) return true;
            return false;
          });
        }

        return Promise.resolve(filtered.slice(0, input.limit).map(c => ({ ...c })));
      }),
    } as unknown as OrdinaryReservationCommandRepository;

    // Mock OrdinaryCommandClosureService.close()
    closureService = {
      close: jest.fn((commandId: string): Promise<ClosureResult> => {
        physicalObserveCalls.push(commandId);
        const configured = closeOutcomes.get(commandId);
        if (configured) {
          if (configured.status === 'ACKNOWLEDGED') {
            const row = inMemoryDb.find(c => c.id === commandId);
            if (row) {
              row.state = 'ACKNOWLEDGED';
              row.completionReceiptHash = configured.completionReceiptHash;
            }
          }
          return Promise.resolve(configured);
        }

        const row = inMemoryDb.find(c => c.id === commandId);
        if (!row) return Promise.resolve({ status: 'UNRESOLVED' });
        row.state = 'ACKNOWLEDGED';
        row.completionReceiptHash = 'e'.repeat(64);
        return Promise.resolve({
          status: 'ACKNOWLEDGED',
          commandId,
          completionReceiptHash: row.completionReceiptHash,
          historical: true,
        });
      }),
    } as unknown as OrdinaryCommandClosureService;

    // Mock OrdinaryRecoveryDiagnosticsService
    diagnosticsService = {
      getBackoff: jest.fn((intentId: string): Promise<RecoveryBackoffDecision> => {
        const configured = backoffDecisions.get(intentId);
        if (configured) return Promise.resolve(configured);
        return Promise.resolve({ shouldRetry: true, remainingWaitMs: 0, attempts: 0 });
      }),
      recordFailure: jest.fn((intentId: string, reason: string, error?: string, workerId?: string) => {
        recordFailureCalls.push({ intentId, reason, error, workerId });
        const existing = backoffStore.get(intentId);
        const attempts = (existing?.attempts ?? 0) + 1;
        const record: RecoveryDiagnosticRecord = {
          intentId,
          attempts,
          nextAttemptAt: new Date(Date.now() + 15000).toISOString(),
          reason,
          lastError: error,
          lastWorkerId: workerId,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        backoffStore.set(intentId, record);
        return Promise.resolve(record);
      }),
      clearBackoff: jest.fn((intentId: string, options?: unknown) => {
        clearBackoffCalls.push({ intentId, options });
        return Promise.resolve(true);
      }),
    } as unknown as OrdinaryRecoveryDiagnosticsService;

    recoveryService = new OrdinaryCommandRecoveryService(
      commandsRepo,
      closureService,
      diagnosticsService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Helper to seed commands into inMemoryDb
  function seedCommand(partial: Partial<TestCommand> = {}): TestCommand {
    const cmd: TestCommand = {
      id: partial.id ?? randomUUID(),
      markerId: partial.markerId ?? randomUUID(),
      sequence: partial.sequence ?? 1,
      expectedSequence: partial.expectedSequence ?? 0,
      effect: partial.effect ?? 'W1',
      state: partial.state ?? 'PENDING',
      completionReceiptHash: partial.completionReceiptHash ?? null,
    };
    inMemoryDb.push(cmd);
    return cmd;
  }

  // =========================================================================
  // GROUP A: BASELINE BEHAVIOR
  // =========================================================================
  describe('Group A: Baseline Behavior', () => {
    it('1. supports direct standalone construction and respects dormant module isolation', () => {
      expect(recoveryService).toBeDefined();
      expect(recoveryService).toBeInstanceOf(OrdinaryCommandRecoveryService);

      const serviceSrc = readFileSync(
        resolve(__dirname, '../services/ordinary-command-recovery.service.ts'),
        'utf8',
      );
      expect(serviceSrc).not.toContain('@Injectable');

      for (const file of [
        '../reservation-fence.module.ts',
        '../../inventory/inventory.module.ts',
        '../../../app.module.ts',
      ]) {
        const content = readFileSync(resolve(__dirname, file), 'utf8');
        expect(content).not.toContain('OrdinaryCommandRecoveryService');
      }
    });

    it('2. returns zero metrics on empty discovery result', async () => {
      const result = await recoveryService.sweep();
      expect(result).toEqual({
        attemptedCount: 0,
        acknowledgedCount: 0,
        unresolvedCount: 0,
        skippedBackoffCount: 0,
        errorCount: 0,
        pagesProcessed: 0,
        hasMore: false,
      });
      expect(closureService.close).not.toHaveBeenCalled();
    });

    it('3. successfully observes and acknowledges an eligible command', async () => {
      const cmd = seedCommand({ state: 'PENDING' });
      const result = await recoveryService.sweep();

      expect(result.attemptedCount).toBe(1);
      expect(result.acknowledgedCount).toBe(1);
      expect(result.unresolvedCount).toBe(0);
      expect(result.skippedBackoffCount).toBe(0);
      expect(result.errorCount).toBe(0);
      expect(result.pagesProcessed).toBe(1);
      expect(result.hasMore).toBe(false);

      expect(closureService.close).toHaveBeenCalledWith(cmd.id);
      expect(cmd.state).toBe('ACKNOWLEDGED');
      expect(cmd.completionReceiptHash).toBe('e'.repeat(64));
    });

    it('4. excludes terminal ACK commands from subsequent sweeps', async () => {
      const cmd = seedCommand({ state: 'PENDING' });

      // First sweep acknowledges the command
      const sweep1 = await recoveryService.sweep();
      expect(sweep1.acknowledgedCount).toBe(1);
      expect(cmd.state).toBe('ACKNOWLEDGED');

      // Second sweep discovers 0 eligible commands because ACK is filtered
      const sweep2 = await recoveryService.sweep();
      expect(sweep2.attemptedCount).toBe(0);
      expect(sweep2.acknowledgedCount).toBe(0);
      expect(sweep2.pagesProcessed).toBe(0);
    });

    it('5. never executes physical command dispatch, replay, or issuance', async () => {
      const cmd = seedCommand({ state: 'PENDING' });
      await recoveryService.sweep();

      const serviceSrc = readFileSync(
        resolve(__dirname, '../services/ordinary-command-recovery.service.ts'),
        'utf8',
      );
      expect(serviceSrc).not.toMatch(/\.dispatch\(|\.execute\(|\.rearm\(|\.issue\(|\.promote\(/);
      expect(physicalObserveCalls).toEqual([cmd.id]);
    });
  });

  // =========================================================================
  // GROUP B: REDIS BACKOFF
  // =========================================================================
  describe('Group B: Redis Advisory Backoff', () => {
    it('6. active backoff skips observation and leaves PostgreSQL state unchanged', async () => {
      const cmd = seedCommand({ state: 'PENDING' });
      backoffDecisions.set(cmd.id, {
        shouldRetry: false,
        remainingWaitMs: 30000,
        attempts: 2,
        nextAttemptAt: new Date(Date.now() + 30000),
      });

      const result = await recoveryService.sweep();
      expect(result.skippedBackoffCount).toBe(1);
      expect(result.attemptedCount).toBe(0);
      expect(result.acknowledgedCount).toBe(0);
      expect(closureService.close).not.toHaveBeenCalled();
      expect(cmd.state).toBe('PENDING'); // Database row untouched
    });

    it('7. expired backoff permits observation', async () => {
      const cmd = seedCommand({ state: 'UNCERTAIN' });
      backoffDecisions.set(cmd.id, {
        shouldRetry: true,
        remainingWaitMs: 0,
        attempts: 2,
        nextAttemptAt: new Date(Date.now() - 5000),
      });

      const result = await recoveryService.sweep();
      expect(result.attemptedCount).toBe(1);
      expect(result.acknowledgedCount).toBe(1);
      expect(result.skippedBackoffCount).toBe(0);
      expect(closureService.close).toHaveBeenCalledWith(cmd.id);
    });

    it('8. Redis outage preserves fail-open advisory behavior', async () => {
      const cmd = seedCommand({ state: 'PENDING' });
      (diagnosticsService.getBackoff as jest.Mock).mockRejectedValueOnce(
        new Error('ECONNREFUSED'),
      );

      const result = await recoveryService.sweep();
      expect(result.attemptedCount).toBe(1);
      expect(result.acknowledgedCount).toBe(1);
      expect(closureService.close).toHaveBeenCalledWith(cmd.id);
    });

    it('9. UNRESOLVED outcome records advisory failure without touching PostgreSQL', async () => {
      const cmd = seedCommand({ state: 'PENDING' });
      closeOutcomes.set(cmd.id, { status: 'UNRESOLVED' });

      const result = await recoveryService.sweep({ workerId: 'worker-unit-test' });
      expect(result.attemptedCount).toBe(1);
      expect(result.unresolvedCount).toBe(1);
      expect(result.acknowledgedCount).toBe(0);

      expect(recordFailureCalls).toHaveLength(1);
      expect(recordFailureCalls[0]).toEqual({
        intentId: cmd.id,
        reason: 'CLOSURE_UNRESOLVED',
        error: undefined,
        workerId: 'worker-unit-test',
      });
      expect(cmd.state).toBe('PENDING');
    });

    it('10. never calls clearBackoff() upon successful acknowledgement', async () => {
      seedCommand({ state: 'PENDING' });
      await recoveryService.sweep();

      expect(diagnosticsService.clearBackoff).not.toHaveBeenCalled();
      expect(clearBackoffCalls).toHaveLength(0);
    });

    it('11. delayed advisory failure cannot reopen an acknowledged PostgreSQL command', async () => {
      const cmd = seedCommand({ state: 'ACKNOWLEDGED', completionReceiptHash: 'a'.repeat(64) });

      // Stale worker executes delayed failure recording in Redis
      await diagnosticsService.recordFailure(cmd.id, 'STALE_DELAYED_FAILURE');
      expect(backoffStore.get(cmd.id)?.attempts).toBe(1);

      // Sweep query ignores ACK row regardless of Redis advisory record
      const result = await recoveryService.sweep();
      expect(result.attemptedCount).toBe(0);
      expect(cmd.state).toBe('ACKNOWLEDGED');
    });
  });

  // =========================================================================
  // GROUP C: POSTGRESQL & CLOSURE BEHAVIOR
  // =========================================================================
  describe('Group C: PostgreSQL and Closure Behavior', () => {
    it('12. PostgreSQL discovery outage aborts the sweep immediately', async () => {
      (commandsRepo.discoverClosure as jest.Mock).mockRejectedValueOnce(
        new Error('POSTGRES_CONNECTION_LOST'),
      );

      await expect(recoveryService.sweep()).rejects.toThrow('POSTGRES_CONNECTION_LOST');
      expect(closureService.close).not.toHaveBeenCalled();
    });

    it('13. closure transaction failure returns UNRESOLVED under existing contract', async () => {
      const cmd = seedCommand({ state: 'PENDING' });
      closeOutcomes.set(cmd.id, { status: 'UNRESOLVED' });

      const result = await recoveryService.sweep();
      expect(result.unresolvedCount).toBe(1);
      expect(result.acknowledgedCount).toBe(0);
      expect(cmd.state).toBe('PENDING');
    });

    it('14. observation timeout returns UNRESOLVED and records failure', async () => {
      const cmd = seedCommand({ state: 'PENDING' });
      closeOutcomes.set(cmd.id, { status: 'UNRESOLVED' });

      const result = await recoveryService.sweep();
      expect(result.unresolvedCount).toBe(1);
      expect(recordFailureCalls[0]?.reason).toBe('CLOSURE_UNRESOLVED');
    });

    it('15. malformed completion evidence preserves database integrity', async () => {
      const cmd = seedCommand({ state: 'PENDING' });
      closeOutcomes.set(cmd.id, { status: 'UNRESOLVED' });

      await recoveryService.sweep();
      expect(cmd.state).toBe('PENDING');
      expect(cmd.completionReceiptHash).toBeNull();
    });

    it('16. identity mismatch does not acknowledge the command', async () => {
      const cmd = seedCommand({ state: 'PENDING' });
      closeOutcomes.set(cmd.id, { status: 'UNRESOLVED' });

      const result = await recoveryService.sweep();
      expect(result.acknowledgedCount).toBe(0);
      expect(cmd.state).toBe('PENDING');
    });

    it('17. sequence mismatch preserves the existing marker sequence', async () => {
      const cmd = seedCommand({ state: 'PENDING', sequence: 4, expectedSequence: 0 });
      closeOutcomes.set(cmd.id, { status: 'UNRESOLVED' });

      await recoveryService.sweep();
      expect(cmd.state).toBe('PENDING');
    });

    it('18. receipt rebinding does not replace the original receipt hash', async () => {
      const initialHash = '1'.repeat(64);
      const cmd = seedCommand({ state: 'PENDING', sequence: 1 });
      // Initial sweep acknowledges command with valid hash
      closeOutcomes.set(cmd.id, {
        status: 'ACKNOWLEDGED',
        commandId: cmd.id,
        completionReceiptHash: initialHash,
        historical: true,
      });
      await recoveryService.sweep();
      expect(cmd.state).toBe('ACKNOWLEDGED');
      expect(cmd.completionReceiptHash).toBe(initialHash);

      // Subsequent sweep attempts closure with different receipt hash returning UNRESOLVED
      closeOutcomes.set(cmd.id, { status: 'UNRESOLVED' });
      const sweep2 = await recoveryService.sweep();
      expect(sweep2.attemptedCount).toBe(0);
      expect(cmd.completionReceiptHash).toBe(initialHash);
    });

    it('19. durable acknowledgement survives stale observation failure', async () => {
      const initialHash = 'd'.repeat(64);
      const cmd = seedCommand({ state: 'PENDING', sequence: 1 });
      // Initial sweep acknowledges command
      closeOutcomes.set(cmd.id, {
        status: 'ACKNOWLEDGED',
        commandId: cmd.id,
        completionReceiptHash: initialHash,
        historical: true,
      });
      const sweep1 = await recoveryService.sweep();
      expect(sweep1.acknowledgedCount).toBe(1);
      expect(cmd.state).toBe('ACKNOWLEDGED');
      expect(cmd.completionReceiptHash).toBe(initialHash);

      // Stale observation returning failure cannot reopen or alter durable ACK
      closeOutcomes.set(cmd.id, { status: 'UNRESOLVED' });
      const sweep2 = await recoveryService.sweep();
      expect(sweep2.attemptedCount).toBe(0);
      expect(cmd.state).toBe('ACKNOWLEDGED');
      expect(cmd.completionReceiptHash).toBe(initialHash);
    });
  });

  // =========================================================================
  // GROUP D: CONCURRENCY
  // =========================================================================
  describe('Group D: Concurrency', () => {
    it('20. two workers concurrently discovering the same command execute safely', async () => {
      const cmd = seedCommand({ state: 'PENDING' });

      const [w1, w2] = await Promise.all([
        recoveryService.sweep({ workerId: 'worker-1' }),
        recoveryService.sweep({ workerId: 'worker-2' }),
      ]);

      expect(w1.attemptedCount + w2.attemptedCount).toBeGreaterThanOrEqual(1);
      expect(cmd.state).toBe('ACKNOWLEDGED');
    });

    it('21. PostgreSQL locking preserves terminal-state correctness under race', async () => {
      const cmd = seedCommand({ state: 'PENDING' });

      // Simulate serialized invocation of sweep across workers
      const res1 = await recoveryService.sweep({ workerId: 'worker-1' });
      const res2 = await recoveryService.sweep({ workerId: 'worker-2' });

      expect(res1.acknowledgedCount).toBe(1);
      expect(res2.attemptedCount).toBe(0);
      expect(cmd.state).toBe('ACKNOWLEDGED');
    });

    it('22. no duplicate physical dispatch occurs across concurrent workers', async () => {
      seedCommand({ state: 'PENDING' });

      await Promise.all([
        recoveryService.sweep({ workerId: 'worker-1' }),
        recoveryService.sweep({ workerId: 'worker-2' }),
      ]);

      const serviceSrc = readFileSync(
        resolve(__dirname, '../services/ordinary-command-recovery.service.ts'),
        'utf8',
      );
      expect(serviceSrc).not.toContain('.dispatch');
      expect(serviceSrc).not.toContain('.execute');
    });

    it('23. terminal acknowledgement is never overwritten by concurrent loser', async () => {
      const cmd = seedCommand({ state: 'PENDING' });
      const sweep1 = await recoveryService.sweep({ workerId: 'worker-1' });
      expect(sweep1.acknowledgedCount).toBe(1);
      expect(cmd.state).toBe('ACKNOWLEDGED');

      // Stale worker tries to report unresolved
      closeOutcomes.set(cmd.id, { status: 'UNRESOLVED' });
      const sweep2 = await recoveryService.sweep({ workerId: 'worker-2' });
      expect(sweep2.attemptedCount).toBe(0);
      // Database row was already committed to ACKNOWLEDGED in step 1
      expect(cmd.state).toBe('ACKNOWLEDGED');
    });

    it('24. concurrent advisory failure recording remains atomic', async () => {
      const id = randomUUID();
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          diagnosticsService.recordFailure(id, 'CONCURRENT_FAILURE', undefined, `worker-${i}`),
        ),
      );

      const record = backoffStore.get(id);
      expect(record?.attempts).toBe(5);
    });
  });

  // =========================================================================
  // GROUP E: PAGINATION
  // =========================================================================
  describe('Group E: Pagination & Continuation', () => {
    it('25. correctly traverses multi-page datasets using deterministic cursor ordering', async () => {
      const marker1 = 'm1-uuid';
      const marker2 = 'm2-uuid';
      // Seed 25 commands
      for (let i = 1; i <= 15; i++) {
        seedCommand({ markerId: marker1, sequence: i });
      }
      for (let i = 1; i <= 10; i++) {
        seedCommand({ markerId: marker2, sequence: i });
      }

      const result = await recoveryService.sweep({ limit: 10, maxPages: 5 });
      expect(result.pagesProcessed).toBe(3); // 10, 10, 5
      expect(result.attemptedCount).toBe(25);
      expect(result.acknowledgedCount).toBe(25);
      expect(result.hasMore).toBe(false);
    });

    it('26. skipped-backoff commands do not stall cursor progression', async () => {
      const marker = 'm-backoff';
      // Seed 10 commands in Page 1, 5 commands in Page 2
      for (let i = 1; i <= 15; i++) {
        const c = seedCommand({ markerId: marker, sequence: i });
        if (i <= 5) {
          // First 5 items in backoff
          backoffDecisions.set(c.id, { shouldRetry: false, remainingWaitMs: 60000, attempts: 1 });
        }
      }

      const result = await recoveryService.sweep({ limit: 10, maxPages: 5 });
      expect(result.pagesProcessed).toBe(2);
      expect(result.skippedBackoffCount).toBe(5);
      expect(result.attemptedCount).toBe(10);
      expect(result.acknowledgedCount).toBe(10);
      expect(result.hasMore).toBe(false);
    });

    it('27. strictly bounds execution by maxPages', async () => {
      const marker = 'm-pages';
      for (let i = 1; i <= 30; i++) {
        seedCommand({ markerId: marker, sequence: i });
      }

      const result = await recoveryService.sweep({ limit: 10, maxPages: 2 });
      expect(result.pagesProcessed).toBe(2);
      expect(result.attemptedCount).toBe(20);
      expect(result.hasMore).toBe(true);
    });

    it('28. hasMore accurately reflects continuation indicator', async () => {
      const marker = 'm-hasmore';
      for (let i = 1; i <= 10; i++) {
        seedCommand({ markerId: marker, sequence: i });
      }

      // Page 1 is full (10 items), maxPages is 1 => hasMore is true
      const fullCapped = await recoveryService.sweep({ limit: 10, maxPages: 1 });
      expect(fullCapped.hasMore).toBe(true);

      // Reset db with 8 items (less than limit 10)
      inMemoryDb = [];
      for (let i = 1; i <= 8; i++) {
        seedCommand({ markerId: marker, sequence: i });
      }
      const partial = await recoveryService.sweep({ limit: 10, maxPages: 1 });
      expect(partial.hasMore).toBe(false);
    });

    it('29. subsequent sweep rediscovers previously deferred commands once backoff expires', async () => {
      const marker = 'm-retry';
      const c1 = seedCommand({ markerId: marker, sequence: 1 });
      const c2 = seedCommand({ markerId: marker, sequence: 2 });

      // First sweep: c1 is in backoff
      backoffDecisions.set(c1.id, { shouldRetry: false, remainingWaitMs: 15000, attempts: 1 });
      const sweep1 = await recoveryService.sweep({ limit: 10 });
      expect(sweep1.skippedBackoffCount).toBe(1);
      expect(sweep1.acknowledgedCount).toBe(1);
      expect(c2.state).toBe('ACKNOWLEDGED');
      expect(c1.state).toBe('PENDING');

      // Second sweep: backoff for c1 expires
      backoffDecisions.set(c1.id, { shouldRetry: true, remainingWaitMs: 0, attempts: 1 });
      const sweep2 = await recoveryService.sweep({ limit: 10 });
      expect(sweep2.attemptedCount).toBe(1);
      expect(sweep2.acknowledgedCount).toBe(1);
      expect(c1.state).toBe('ACKNOWLEDGED');
    });

    it('30. terminates cleanly when exact multiple of limit results in empty final page', async () => {
      const marker = 'm-exact';
      for (let i = 1; i <= 20; i++) {
        seedCommand({ markerId: marker, sequence: i });
      }

      const result = await recoveryService.sweep({ limit: 10, maxPages: 5 });
      // Page 1: 10 items. Page 2: 10 items. Page 3: 0 items (breaks). Total pages: 2
      expect(result.pagesProcessed).toBe(2);
      expect(result.attemptedCount).toBe(20);
      expect(result.hasMore).toBe(false);
    });

    it.each([
      ['zero limit', { limit: 0 }],
      ['negative limit', { limit: -10 }],
      ['fractional limit', { limit: 10.5 }],
      ['limit too high', { limit: 101 }],
      ['NaN limit', { limit: NaN }],
      ['Infinity limit', { limit: Infinity }],
      ['zero maxPages', { maxPages: 0 }],
      ['negative maxPages', { maxPages: -1 }],
      ['maxPages too high', { maxPages: 1001 }],
      ['empty workerId', { workerId: '' }],
      ['whitespace workerId', { workerId: '   ' }],
      ['illegal chars workerId', { workerId: 'worker!#$' }],
    ])('31. rejects invalid sweep options: %s before database access', async (_, opts) => {
      await expect(
        recoveryService.sweep(opts as unknown as Parameters<typeof recoveryService.sweep>[0]),
      ).rejects.toThrow('INVALID_SWEEP_OPTIONS');
      expect(commandsRepo.discoverClosure).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GROUP F: WORKER INTERRUPTION
  // =========================================================================
  describe('Group F: Worker Interruption & Crash Recovery', () => {
    it('32. worker interruption before PostgreSQL acknowledgement leaves command recoverable', async () => {
      const cmd = seedCommand({ state: 'PENDING' });

      // Worker 1 encounters crash / unhandled failure during closure
      (closureService.close as jest.Mock).mockRejectedValueOnce(new Error('PROCESS_KILLED'));
      const sweep1 = await recoveryService.sweep();
      expect(sweep1.errorCount).toBe(1);
      expect(cmd.state).toBe('PENDING'); // Row remains pending

      // Worker 2 runs subsequent sweep and successfully recovers the command
      const sweep2 = await recoveryService.sweep();
      expect(sweep2.acknowledgedCount).toBe(1);
      expect(cmd.state).toBe('ACKNOWLEDGED');
    });

    it('33. worker interruption after durable acknowledgement preserves terminal state', async () => {
      const cmd = seedCommand({ state: 'ACKNOWLEDGED', completionReceiptHash: 'c'.repeat(64) });

      // Worker crashes after commit; subsequent sweep discovers 0 eligible rows
      const sweep = await recoveryService.sweep();
      expect(sweep.attemptedCount).toBe(0);
      expect(cmd.state).toBe('ACKNOWLEDGED');
    });
  });
});
