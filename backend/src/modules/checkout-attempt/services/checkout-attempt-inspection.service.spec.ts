import { CheckoutAttempt } from '@prisma/client';

import { CheckoutAttemptRepository } from '../repositories/checkout-attempt.repository';
import { CheckoutAttemptService } from './checkout-attempt.service';

// Phase 16A.0-D.2.1. CheckoutAttemptService.inspectByIdempotencyKey - the
// read-only preflight added to close the same-key-after-COMMITTED gap
// found during D.3 integration testing. Split from
// checkout-attempt.service.spec.ts (createOrResume only) to keep every
// file within the repository's 400-line cap, matching this module's
// established split convention.
describe('CheckoutAttemptService.inspectByIdempotencyKey', () => {
  let repository: jest.Mocked<Pick<CheckoutAttemptRepository, 'findByIdempotencyKey'>>;
  let service: CheckoutAttemptService;

  const idempotencyKey = 'idem-key-1';
  const cartId = 'cart-1';
  const customerId = 'customer-1';
  const now = new Date('2026-08-11T00:00:00.000Z');

  beforeEach(() => {
    repository = { findByIdempotencyKey: jest.fn() };
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

  function toSummary(attempt: CheckoutAttempt) {
    const { failureMessage: _failureMessage, ...summary } = attempt;
    return summary;
  }

  it('1. returns NOT_FOUND when no row exists for the key', async () => {
    repository.findByIdempotencyKey.mockResolvedValue(null);

    const result = await service.inspectByIdempotencyKey(customerId, idempotencyKey);

    expect(result).toEqual({ action: 'NOT_FOUND' });
    expect(repository.findByIdempotencyKey).toHaveBeenCalledWith(idempotencyKey);
  });

  it('2. returns RESUMED_PROCESSING for a same-customer PROCESSING row', async () => {
    const attempt = buildAttempt({ status: 'PROCESSING' });
    repository.findByIdempotencyKey.mockResolvedValue(attempt);

    const result = await service.inspectByIdempotencyKey(customerId, idempotencyKey);

    expect(result).toEqual({ action: 'RESUMED_PROCESSING', attempt: toSummary(attempt) });
  });

  it('3. returns ALREADY_FAILED for a same-customer FAILED row, without exposing the raw failureMessage', async () => {
    const attempt = buildAttempt({
      status: 'FAILED',
      failureCode: 'ORDER_TRANSACTION_FAILED',
      failureMessage: 'internal diagnostic detail that must never reach the caller',
    });
    repository.findByIdempotencyKey.mockResolvedValue(attempt);

    const result = await service.inspectByIdempotencyKey(customerId, idempotencyKey);

    expect(result).toEqual({ action: 'ALREADY_FAILED', attempt: toSummary(attempt) });
    expect(JSON.stringify(result)).not.toContain('internal diagnostic detail');
  });

  it('4. returns ALREADY_COMMITTED for a same-customer COMMITTED row', async () => {
    const attempt = buildAttempt({ status: 'COMMITTED', orderId: 'order-1' });
    repository.findByIdempotencyKey.mockResolvedValue(attempt);

    const result = await service.inspectByIdempotencyKey(customerId, idempotencyKey);

    expect(result).toEqual({ action: 'ALREADY_COMMITTED', attempt: toSummary(attempt) });
  });

  it('5. returns IDEMPOTENCY_KEY_CONFLICT for a row owned by another customer', async () => {
    const attempt = buildAttempt({ customerId: 'someone-else', status: 'COMMITTED', orderId: 'order-1' });
    repository.findByIdempotencyKey.mockResolvedValue(attempt);

    const result = await service.inspectByIdempotencyKey(customerId, idempotencyKey);

    expect(result).toEqual({ action: 'IDEMPOTENCY_KEY_CONFLICT' });
  });

  it('6. the conflict result exposes no stored customerId, cartId, orderId, or status', async () => {
    const attempt = buildAttempt({
      customerId: 'someone-else',
      cartId: 'their-secret-cart',
      status: 'COMMITTED',
      orderId: 'their-secret-order',
    });
    repository.findByIdempotencyKey.mockResolvedValue(attempt);

    const result = await service.inspectByIdempotencyKey(customerId, idempotencyKey);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('someone-else');
    expect(serialized).not.toContain('their-secret-cart');
    expect(serialized).not.toContain('their-secret-order');
    expect(serialized).not.toContain('COMMITTED');
  });

  it('7. performs no write - only findByIdempotencyKey is ever called', async () => {
    repository.findByIdempotencyKey.mockResolvedValue(buildAttempt());
    await service.inspectByIdempotencyKey(customerId, idempotencyKey);
    expect(Object.keys(repository)).toEqual(['findByIdempotencyKey']);
  });

  it('8. never mutates lastHeartbeatAt - the returned summary reflects the stored value unchanged', async () => {
    const originalHeartbeat = new Date('2026-08-01T00:00:00.000Z');
    const attempt = buildAttempt({ lastHeartbeatAt: originalHeartbeat });
    repository.findByIdempotencyKey.mockResolvedValue(attempt);

    const result = await service.inspectByIdempotencyKey(customerId, idempotencyKey);

    expect(result).toMatchObject({ attempt: { lastHeartbeatAt: originalHeartbeat } });
  });
});
