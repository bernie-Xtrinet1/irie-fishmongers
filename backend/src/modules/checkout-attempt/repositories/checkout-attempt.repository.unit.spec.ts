import { CheckoutAttempt, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { CheckoutAttemptRepository } from './checkout-attempt.repository';

// Mocked-PrismaService coverage for createOrGetByIdempotencyKey's P2002
// branch logic - the one deliberate exception to this codebase's
// established "repository specs run against real Postgres" convention
// (see checkout-attempt.repository.spec.ts). A P2002 targeting a
// constraint other than idempotencyKey cannot be triggered through
// genuine concurrent Postgres calls against this schema (no other unique
// constraint is contended for by this method), so it is exercised here
// with a mocked Prisma client instead.
describe('CheckoutAttemptRepository (mocked P2002 handling)', () => {
  let prisma: { checkoutAttempt: { create: jest.Mock; findUnique: jest.Mock } };
  let repository: CheckoutAttemptRepository;

  const idempotencyKey = 'idem-key-1';
  const cartId = 'cart-1';
  const customerId = 'customer-1';
  const now = new Date('2026-08-07T00:00:00.000Z');

  beforeEach(() => {
    prisma = { checkoutAttempt: { create: jest.fn(), findUnique: jest.fn() } };
    repository = new CheckoutAttemptRepository(prisma as unknown as PrismaService);
  });

  function p2002(target: string[]): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '6.19.3',
      meta: { target },
    });
  }

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

  it('treats a P2002 on idempotencyKey as the expected concurrent-create race and re-reads', async () => {
    prisma.checkoutAttempt.create.mockRejectedValue(p2002(['idempotencyKey']));
    const existing = buildAttempt();
    prisma.checkoutAttempt.findUnique.mockResolvedValue(existing);

    const result = await repository.createOrGetByIdempotencyKey({
      idempotencyKey,
      cartId,
      customerId,
      now,
    });

    expect(result).toEqual({ attempt: existing, created: false });
    expect(prisma.checkoutAttempt.findUnique).toHaveBeenCalledWith({ where: { idempotencyKey } });
  });

  it('rethrows a P2002 targeting a different unique constraint, without re-reading', async () => {
    const error = p2002(['orderId']);
    prisma.checkoutAttempt.create.mockRejectedValue(error);

    await expect(
      repository.createOrGetByIdempotencyKey({ idempotencyKey, cartId, customerId, now }),
    ).rejects.toBe(error);
    expect(prisma.checkoutAttempt.findUnique).not.toHaveBeenCalled();
  });

  it('rethrows a non-P2002 Prisma error unchanged', async () => {
    const error = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: '6.19.3',
    });
    prisma.checkoutAttempt.create.mockRejectedValue(error);

    await expect(
      repository.createOrGetByIdempotencyKey({ idempotencyKey, cartId, customerId, now }),
    ).rejects.toBe(error);
    expect(prisma.checkoutAttempt.findUnique).not.toHaveBeenCalled();
  });

  it('rethrows a completely unrelated error unchanged', async () => {
    const error = new Error('connection reset');
    prisma.checkoutAttempt.create.mockRejectedValue(error);

    await expect(
      repository.createOrGetByIdempotencyKey({ idempotencyKey, cartId, customerId, now }),
    ).rejects.toBe(error);
  });

  it('throws an internal consistency error if the P2002-triggering row cannot be found on re-read', async () => {
    prisma.checkoutAttempt.create.mockRejectedValue(p2002(['idempotencyKey']));
    prisma.checkoutAttempt.findUnique.mockResolvedValue(null);

    await expect(
      repository.createOrGetByIdempotencyKey({ idempotencyKey, cartId, customerId, now }),
    ).rejects.toThrow('Internal consistency error');
  });
});
