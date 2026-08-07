import { CheckoutAttempt, Prisma } from '@prisma/client';

import { CheckoutAttemptRepository } from '../repositories/checkout-attempt.repository';
import { CheckoutAttemptService } from './checkout-attempt.service';

// CheckoutAttemptService coverage: updateHeartbeat and
// markCommittedInTransaction. createOrResume lives in
// checkout-attempt.service.spec.ts; markFailed, findStalePage, and the
// structural checks live in
// checkout-attempt-failure-pagination.service.spec.ts - split to keep
// every file within the repository's 400-line cap.
describe('CheckoutAttemptService (heartbeat and commit transitions)', () => {
  let repository: jest.Mocked<
    Pick<CheckoutAttemptRepository, 'findById' | 'updateHeartbeatIfProcessing' | 'markCommitted'>
  >;
  let service: CheckoutAttemptService;

  const attemptId = 'attempt-1';
  const customerId = 'customer-1';
  const orderId = 'order-1';
  const now = new Date('2026-08-07T00:00:00.000Z');
  const tx = {} as Prisma.TransactionClient;

  beforeEach(() => {
    repository = {
      findById: jest.fn(),
      updateHeartbeatIfProcessing: jest.fn(),
      markCommitted: jest.fn(),
    };
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

  describe('updateHeartbeat', () => {
    it('succeeds when the conditional update matches', async () => {
      repository.updateHeartbeatIfProcessing.mockResolvedValue({ count: 1 });

      const result = await service.updateHeartbeat(attemptId, customerId, now);

      expect(result).toEqual({ ok: true });
      expect(repository.updateHeartbeatIfProcessing).toHaveBeenCalledWith(attemptId, customerId, now);
    });

    it('rejects a timestamp more than 30 seconds ahead of the server clock without calling the repository', async () => {
      const farFuture = new Date(Date.now() + 30_001);

      const result = await service.updateHeartbeat(attemptId, customerId, farFuture);

      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'now',
        reason: 'now cannot be more than 30 seconds ahead of the server clock',
      });
      expect(repository.updateHeartbeatIfProcessing).not.toHaveBeenCalled();
    });

    it('accepts a timestamp exactly 30 seconds ahead of the server clock', async () => {
      repository.updateHeartbeatIfProcessing.mockResolvedValue({ count: 1 });
      const atTolerance = new Date(Date.now() + 30_000);

      const result = await service.updateHeartbeat(attemptId, customerId, atTolerance);

      expect(result).toEqual({ ok: true });
    });

    it('classifies NOT_FOUND when no row matches', async () => {
      repository.updateHeartbeatIfProcessing.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(null);

      const result = await service.updateHeartbeat(attemptId, customerId, now);

      expect(result).toEqual({ ok: false, code: 'NOT_FOUND' });
    });

    it('classifies OWNERSHIP_MISMATCH when the row belongs to another customer', async () => {
      repository.updateHeartbeatIfProcessing.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(buildAttempt({ customerId: 'someone-else' }));

      const result = await service.updateHeartbeat(attemptId, customerId, now);

      expect(result).toEqual({ ok: false, code: 'OWNERSHIP_MISMATCH' });
    });

    it('classifies NOT_PROCESSING when the row is already COMMITTED or FAILED', async () => {
      repository.updateHeartbeatIfProcessing.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(buildAttempt({ status: 'COMMITTED', orderId: 'order-1' }));

      const result = await service.updateHeartbeat(attemptId, customerId, now);

      expect(result).toEqual({ ok: false, code: 'NOT_PROCESSING' });
    });

    it('classifies HEARTBEAT_NOT_MONOTONIC when a regressive timestamp is the only remaining explanation', async () => {
      repository.updateHeartbeatIfProcessing.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(buildAttempt({ status: 'PROCESSING' }));

      const earlier = new Date(now.getTime() - 1_000);
      const result = await service.updateHeartbeat(attemptId, customerId, earlier);

      expect(result).toEqual({ ok: false, code: 'HEARTBEAT_NOT_MONOTONIC' });
    });
  });

  describe('markCommittedInTransaction', () => {
    it('commits successfully when the conditional update matches', async () => {
      repository.markCommitted.mockResolvedValue({ count: 1 });

      const result = await service.markCommittedInTransaction(tx, attemptId, customerId, orderId, now);

      expect(result).toEqual({ ok: true, alreadyCommitted: false });
      expect(repository.markCommitted).toHaveBeenCalledWith(tx, attemptId, customerId, orderId, now);
    });

    it('is idempotent on a retry with the same orderId', async () => {
      repository.markCommitted.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(buildAttempt({ status: 'COMMITTED', orderId }));

      const result = await service.markCommittedInTransaction(tx, attemptId, customerId, orderId, now);

      expect(result).toEqual({ ok: true, alreadyCommitted: true });
      expect(repository.findById).toHaveBeenCalledWith(attemptId, tx);
    });

    it('reports ORDER_CONFLICT on a different orderId', async () => {
      repository.markCommitted.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(
        buildAttempt({ status: 'COMMITTED', orderId: 'a-different-order' }),
      );

      const result = await service.markCommittedInTransaction(tx, attemptId, customerId, orderId, now);

      expect(result).toEqual({ ok: false, code: 'ORDER_CONFLICT', existingOrderId: 'a-different-order' });
    });

    it('rejects FAILED -> COMMITTED as INVALID_TRANSITION', async () => {
      repository.markCommitted.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(buildAttempt({ status: 'FAILED' }));

      const result = await service.markCommittedInTransaction(tx, attemptId, customerId, orderId, now);

      expect(result).toEqual({ ok: false, code: 'INVALID_TRANSITION' });
    });

    it('classifies NOT_FOUND and OWNERSHIP_MISMATCH', async () => {
      repository.markCommitted.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(null);
      await expect(
        service.markCommittedInTransaction(tx, attemptId, customerId, orderId, now),
      ).resolves.toEqual({ ok: false, code: 'NOT_FOUND' });

      repository.findById.mockResolvedValue(buildAttempt({ customerId: 'someone-else' }));
      await expect(
        service.markCommittedInTransaction(tx, attemptId, customerId, orderId, now),
      ).resolves.toEqual({ ok: false, code: 'OWNERSHIP_MISMATCH' });
    });

    it('throws an internal consistency error for a COMMITTED row with no orderId', async () => {
      repository.markCommitted.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(buildAttempt({ status: 'COMMITTED', orderId: null }));

      await expect(
        service.markCommittedInTransaction(tx, attemptId, customerId, orderId, now),
      ).rejects.toThrow('Internal consistency error');
    });

    it('throws an internal consistency error when a matching PROCESSING row was somehow not updated', async () => {
      repository.markCommitted.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(buildAttempt({ status: 'PROCESSING' }));

      await expect(
        service.markCommittedInTransaction(tx, attemptId, customerId, orderId, now),
      ).rejects.toThrow('Internal consistency error');
    });
  });
});
