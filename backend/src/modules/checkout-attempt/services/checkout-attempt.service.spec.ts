import { CheckoutAttempt } from '@prisma/client';

import { CheckoutAttemptRepository } from '../repositories/checkout-attempt.repository';
import { CheckoutAttemptService } from './checkout-attempt.service';

// CheckoutAttemptService coverage: createOrResume only. updateHeartbeat and
// markCommittedInTransaction live in
// checkout-attempt-transitions.service.spec.ts; markFailed, findStalePage,
// and the structural checks live in
// checkout-attempt-failure-pagination.service.spec.ts - split to keep
// every file within the repository's 400-line cap.
// CheckoutAttemptRepository is mocked throughout - real-Postgres behavior
// is covered by checkout-attempt.repository.spec.ts.
describe('CheckoutAttemptService', () => {
  let repository: jest.Mocked<Pick<CheckoutAttemptRepository, 'createOrGetByIdempotencyKey'>>;
  let service: CheckoutAttemptService;

  const idempotencyKey = 'idem-key-1';
  const cartId = 'cart-1';
  const customerId = 'customer-1';
  const now = new Date('2026-08-07T00:00:00.000Z');

  beforeEach(() => {
    repository = { createOrGetByIdempotencyKey: jest.fn() };
    service = new CheckoutAttemptService(repository as unknown as CheckoutAttemptRepository);
  });

  function buildAttempt(overrides: Partial<CheckoutAttempt> = {}): CheckoutAttempt {
    return {
      id: 'attempt-1',
      idempotencyKey,
      cartId,
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

  // CheckoutAttemptSummary deliberately excludes failureMessage - the
  // service never returns the raw Prisma row.
  function toSummary(attempt: CheckoutAttempt) {
    const { failureMessage: _failureMessage, ...summary } = attempt;
    return summary;
  }

  describe('createOrResume', () => {
    it('returns CREATED for a brand-new attempt', async () => {
      const attempt = buildAttempt();
      repository.createOrGetByIdempotencyKey.mockResolvedValue({ attempt, created: true });

      const result = await service.createOrResume({ idempotencyKey, cartId, customerId, now });

      expect(result).toEqual({ ok: true, action: 'CREATED', attempt: toSummary(attempt) });
      expect(repository.createOrGetByIdempotencyKey).toHaveBeenCalledWith({
        idempotencyKey,
        cartId,
        customerId,
        now,
      });
    });

    it('returns RESUMED_PROCESSING for an existing PROCESSING attempt, without touching lastHeartbeatAt', async () => {
      const attempt = buildAttempt({ status: 'PROCESSING' });
      repository.createOrGetByIdempotencyKey.mockResolvedValue({ attempt, created: false });

      const result = await service.createOrResume({ idempotencyKey, cartId, customerId, now });

      expect(result).toEqual({ ok: true, action: 'RESUMED_PROCESSING', attempt: toSummary(attempt) });
    });

    it('returns ALREADY_COMMITTED for an existing COMMITTED attempt', async () => {
      const attempt = buildAttempt({ status: 'COMMITTED', orderId: 'order-1' });
      repository.createOrGetByIdempotencyKey.mockResolvedValue({ attempt, created: false });

      const result = await service.createOrResume({ idempotencyKey, cartId, customerId, now });

      expect(result).toEqual({ ok: true, action: 'ALREADY_COMMITTED', attempt: toSummary(attempt) });
    });

    it('returns ALREADY_FAILED for an existing FAILED attempt, without exposing the raw stored failureMessage', async () => {
      const attempt = buildAttempt({
        status: 'FAILED',
        failureCode: 'CHECKOUT_MARK_FAILED',
        failureMessage: 'internal diagnostic detail that must never reach the caller',
      });
      repository.createOrGetByIdempotencyKey.mockResolvedValue({ attempt, created: false });

      const result = await service.createOrResume({ idempotencyKey, cartId, customerId, now });

      expect(result).toEqual({ ok: true, action: 'ALREADY_FAILED', attempt: toSummary(attempt) });
      expect(JSON.stringify(result)).not.toContain('internal diagnostic detail');
    });

    it('rejects a customerId conflict without exposing the stored customerId', async () => {
      const attempt = buildAttempt({ customerId: 'someone-else' });
      repository.createOrGetByIdempotencyKey.mockResolvedValue({ attempt, created: false });

      const result = await service.createOrResume({ idempotencyKey, cartId, customerId, now });

      expect(result).toEqual({ ok: false, code: 'IDEMPOTENCY_KEY_CONFLICT' });
      expect(JSON.stringify(result)).not.toContain('someone-else');
    });

    it('rejects a cartId conflict without exposing the stored cartId', async () => {
      const attempt = buildAttempt({ cartId: 'a-different-cart' });
      repository.createOrGetByIdempotencyKey.mockResolvedValue({ attempt, created: false });

      const result = await service.createOrResume({ idempotencyKey, cartId, customerId, now });

      expect(result).toEqual({ ok: false, code: 'IDEMPOTENCY_KEY_CONFLICT' });
      expect(JSON.stringify(result)).not.toContain('a-different-cart');
    });
  });
});
