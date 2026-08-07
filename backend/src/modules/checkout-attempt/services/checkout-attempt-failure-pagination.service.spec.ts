import { CheckoutAttempt } from '@prisma/client';

import { CheckoutAttemptRepository } from '../repositories/checkout-attempt.repository';
import { CheckoutAttemptService } from './checkout-attempt.service';

// CheckoutAttemptService coverage: markFailed and findStalePage.
// createOrResume lives in checkout-attempt.service.spec.ts; updateHeartbeat
// and markCommittedInTransaction live in
// checkout-attempt-transitions.service.spec.ts; the module's
// structural/no-wiring invariants live in
// checkout-attempt-module-boundary.spec.ts - split to keep every file
// within the repository's 400-line cap.
describe('CheckoutAttemptService (failure transition and stale pagination)', () => {
  let repository: jest.Mocked<
    Pick<CheckoutAttemptRepository, 'findById' | 'markFailed' | 'findStaleProcessing'>
  >;
  let service: CheckoutAttemptService;

  const attemptId = 'attempt-1';
  const customerId = 'customer-1';
  const now = new Date('2026-08-07T00:00:00.000Z');

  beforeEach(() => {
    repository = { findById: jest.fn(), markFailed: jest.fn(), findStaleProcessing: jest.fn() };
    service = new CheckoutAttemptService(repository as unknown as CheckoutAttemptRepository);
  });

  function buildAttempt(overrides: Partial<CheckoutAttempt> = {}): CheckoutAttempt {
    return {
      id: attemptId,
      idempotencyKey: 'idem-key-1',
      cartId: 'cart-1',
      customerId,
      status: 'PROCESSING',
      orderId: null,
      failureCode: null,
      failureMessage: null,
      createdAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      ...overrides,
    };
  }

  describe('markFailed', () => {
    it('succeeds on the first PROCESSING -> FAILED write', async () => {
      repository.markFailed.mockResolvedValue({ count: 1 });

      const result = await service.markFailed(attemptId, customerId, 'PAYMENT_DECLINED', 'card declined', now);

      expect(result).toEqual({ ok: true, alreadyFailed: false, detailsMatched: true });
      expect(repository.markFailed).toHaveBeenCalledWith(
        attemptId,
        customerId,
        'PAYMENT_DECLINED',
        'card declined',
        now,
      );
    });

    it('sanitizes a stack-like failureMessage and still transitions to FAILED', async () => {
      repository.markFailed.mockResolvedValue({ count: 1 });
      const raw = 'Error: boom\n    at Object.<anonymous> (file.ts:1:1)\n    at Module._compile (module.js:1:1)';

      await service.markFailed(attemptId, customerId, 'INTERNAL_ERROR', raw, now);

      expect(repository.markFailed).toHaveBeenCalledWith(
        attemptId,
        customerId,
        'INTERNAL_ERROR',
        'Error: boom',
        now,
      );
    });

    it('caps an over-500-character failureMessage to exactly 500 characters after sanitization', async () => {
      repository.markFailed.mockResolvedValue({ count: 1 });
      const overLong = 'x'.repeat(600);

      await service.markFailed(attemptId, customerId, 'INTERNAL_ERROR', overLong, now);

      const persistedMessage = repository.markFailed.mock.calls[0]?.[3];
      expect(persistedMessage).toBe('x'.repeat(500));
    });

    it('never persists raw stack-trace content', async () => {
      repository.markFailed.mockResolvedValue({ count: 1 });
      const raw = 'Error: boom\n    at handler (a.ts:1:1)\n    at process (b.ts:2:2)';

      await service.markFailed(attemptId, customerId, 'INTERNAL_ERROR', raw, now);

      const persistedMessage = repository.markFailed.mock.calls[0]?.[3];
      expect(persistedMessage).not.toContain('at handler');
      expect(persistedMessage).not.toContain('at process');
    });

    it('redacts obvious credential/token-like content', async () => {
      repository.markFailed.mockResolvedValue({ count: 1 });
      const raw = 'upstream call failed: Bearer abc123.def456.ghi789';

      await service.markFailed(attemptId, customerId, 'INTERNAL_ERROR', raw, now);

      const persistedMessage = repository.markFailed.mock.calls[0]?.[3];
      expect(persistedMessage).toContain('[REDACTED]');
      expect(persistedMessage).not.toContain('abc123.def456.ghi789');
    });

    it('stores null when a failureMessage sanitizes down to nothing', async () => {
      repository.markFailed.mockResolvedValue({ count: 1 });
      const onlyStackLines = '    at Object.<anonymous> (file.ts:1:1)\n    at Module._compile (module.js:1:1)';

      await service.markFailed(attemptId, customerId, 'INTERNAL_ERROR', onlyStackLines, now);

      expect(repository.markFailed).toHaveBeenCalledWith(
        attemptId,
        customerId,
        'INTERNAL_ERROR',
        null,
        now,
      );
    });

    it('reports an identical duplicate failure as detailsMatched: true, performing no second write', async () => {
      repository.markFailed.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(
        buildAttempt({ status: 'FAILED', failureCode: 'PAYMENT_DECLINED', failureMessage: 'card declined' }),
      );

      const result = await service.markFailed(attemptId, customerId, 'PAYMENT_DECLINED', 'card declined', now);

      expect(result).toEqual({ ok: true, alreadyFailed: true, detailsMatched: true });
    });

    it('uses the sanitized representation for the repeated-failure comparison, even when the raw inputs differ syntactically', async () => {
      repository.markFailed.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(
        buildAttempt({ status: 'FAILED', failureCode: 'INTERNAL_ERROR', failureMessage: 'Error: boom' }),
      );
      const rawWithStack = 'Error: boom\n    at Object.<anonymous> (file.ts:1:1)';

      const result = await service.markFailed(attemptId, customerId, 'INTERNAL_ERROR', rawWithStack, now);

      expect(result).toEqual({ ok: true, alreadyFailed: true, detailsMatched: true });
    });

    it('preserves the first stored details on a genuinely different duplicate failure', async () => {
      repository.markFailed.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(
        buildAttempt({ status: 'FAILED', failureCode: 'PAYMENT_DECLINED', failureMessage: 'card declined' }),
      );

      const result = await service.markFailed(attemptId, customerId, 'INVENTORY_UNAVAILABLE', 'out of stock', now);

      expect(result).toEqual({ ok: true, alreadyFailed: true, detailsMatched: false });
    });

    it('rejects COMMITTED -> FAILED as INVALID_TRANSITION', async () => {
      repository.markFailed.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(buildAttempt({ status: 'COMMITTED', orderId: 'order-1' }));

      const result = await service.markFailed(attemptId, customerId, 'PAYMENT_DECLINED', null, now);

      expect(result).toEqual({ ok: false, code: 'INVALID_TRANSITION' });
    });

    it('classifies NOT_FOUND and OWNERSHIP_MISMATCH', async () => {
      repository.markFailed.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(null);
      await expect(service.markFailed(attemptId, customerId, 'PAYMENT_DECLINED', null, now)).resolves.toEqual({
        ok: false,
        code: 'NOT_FOUND',
      });

      repository.findById.mockResolvedValue(buildAttempt({ customerId: 'someone-else' }));
      await expect(service.markFailed(attemptId, customerId, 'PAYMENT_DECLINED', null, now)).resolves.toEqual({
        ok: false,
        code: 'OWNERSHIP_MISMATCH',
      });
    });

    it('throws an internal consistency error when a matching PROCESSING row was somehow not updated', async () => {
      repository.markFailed.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(buildAttempt({ status: 'PROCESSING' }));

      await expect(service.markFailed(attemptId, customerId, 'PAYMENT_DECLINED', null, now)).rejects.toThrow(
        'Internal consistency error',
      );
    });

    it.each(['', '   ', 'x'.repeat(65)])(
      'rejects an invalid failureCode %j without calling the repository',
      async (invalidCode) => {
        const result = await service.markFailed(attemptId, customerId, invalidCode, null, now);

        expect(result).toEqual({
          ok: false,
          code: 'INVALID_INPUT',
          field: 'failureCode',
          reason: expect.any(String) as string,
        });
        expect(repository.markFailed).not.toHaveBeenCalled();
      },
    );

    it('accepts a null failureMessage', async () => {
      repository.markFailed.mockResolvedValue({ count: 1 });

      const result = await service.markFailed(attemptId, customerId, 'PAYMENT_DECLINED', null, now);

      expect(result).toEqual({ ok: true, alreadyFailed: false, detailsMatched: true });
      expect(repository.markFailed).toHaveBeenCalledWith(attemptId, customerId, 'PAYMENT_DECLINED', null, now);
    });
  });

  describe('findStalePage', () => {
    function candidate(overrides: Partial<CheckoutAttempt> = {}): CheckoutAttempt {
      return buildAttempt(overrides);
    }

    it('returns a page with nextCursor null when fewer rows than the limit are found', async () => {
      const rows = [candidate({ id: 'a' }), candidate({ id: 'b' })];
      repository.findStaleProcessing.mockResolvedValue(rows);

      const result = await service.findStalePage({ heartbeatBefore: now, cursor: null, limit: 10 });

      expect(result).toEqual({
        ok: true,
        page: {
          items: rows.map((row) => ({
            id: row.id,
            idempotencyKey: row.idempotencyKey,
            cartId: row.cartId,
            customerId: row.customerId,
            lastHeartbeatAt: row.lastHeartbeatAt,
          })),
          nextCursor: null,
        },
      });
      expect(repository.findStaleProcessing).toHaveBeenCalledWith({
        heartbeatBefore: now,
        cursor: null,
        limit: 11,
      });
    });

    it('derives nextCursor from the last row of the trimmed page when more rows exist', async () => {
      const rows = [
        candidate({ id: 'a', lastHeartbeatAt: new Date(now.getTime() - 3_000) }),
        candidate({ id: 'b', lastHeartbeatAt: new Date(now.getTime() - 2_000) }),
        candidate({ id: 'c', lastHeartbeatAt: new Date(now.getTime() - 1_000) }),
      ];
      repository.findStaleProcessing.mockResolvedValue(rows);

      const result = await service.findStalePage({ heartbeatBefore: now, cursor: null, limit: 2 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.page.items).toHaveLength(2);
        expect(result.page.nextCursor).toEqual({ lastHeartbeatAt: rows[1]!.lastHeartbeatAt, id: 'b' });
      }
    });

    it('passes the supplied cursor through to the repository unchanged', async () => {
      repository.findStaleProcessing.mockResolvedValue([]);
      const cursor = { lastHeartbeatAt: new Date(now.getTime() - 5_000), id: 'cursor-id' };

      await service.findStalePage({ heartbeatBefore: now, cursor, limit: 50 });

      expect(repository.findStaleProcessing).toHaveBeenCalledWith({
        heartbeatBefore: now,
        cursor,
        limit: 51,
      });
    });

    it('defaults to the default page size when limit is omitted', async () => {
      repository.findStaleProcessing.mockResolvedValue([]);

      await service.findStalePage({ heartbeatBefore: now, cursor: null });

      expect(repository.findStaleProcessing).toHaveBeenCalledWith({
        heartbeatBefore: now,
        cursor: null,
        limit: 101,
      });
    });

    it('rejects a non-positive-integer limit without calling the repository', async () => {
      const result = await service.findStalePage({ heartbeatBefore: now, cursor: null, limit: 0 });

      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'limit',
        reason: 'limit must be a positive integer',
      });
      expect(repository.findStaleProcessing).not.toHaveBeenCalled();
    });

    it('rejects a limit above the maximum page size without calling the repository', async () => {
      const result = await service.findStalePage({ heartbeatBefore: now, cursor: null, limit: 201 });

      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'limit',
        reason: 'limit cannot exceed 200',
      });
      expect(repository.findStaleProcessing).not.toHaveBeenCalled();
    });

    it('rejects an invalid heartbeatBefore without calling the repository', async () => {
      const result = await service.findStalePage({
        heartbeatBefore: new Date('not-a-date'),
        cursor: null,
        limit: 10,
      });

      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'heartbeatBefore',
        reason: 'heartbeatBefore must be a valid Date',
      });
      expect(repository.findStaleProcessing).not.toHaveBeenCalled();
    });

    it('rejects a cursor with an invalid lastHeartbeatAt', async () => {
      const result = await service.findStalePage({
        heartbeatBefore: now,
        cursor: { lastHeartbeatAt: new Date('not-a-date'), id: 'cursor-id' },
        limit: 10,
      });

      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'cursor.lastHeartbeatAt',
        reason: 'cursor.lastHeartbeatAt must be a valid Date',
      });
      expect(repository.findStaleProcessing).not.toHaveBeenCalled();
    });

    it('rejects a cursor with a non-empty-string id requirement violated', async () => {
      const result = await service.findStalePage({
        heartbeatBefore: now,
        cursor: { lastHeartbeatAt: now, id: '' },
        limit: 10,
      });

      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'cursor.id',
        reason: 'cursor.id must be a non-empty string',
      });
      expect(repository.findStaleProcessing).not.toHaveBeenCalled();
    });
  });
});
