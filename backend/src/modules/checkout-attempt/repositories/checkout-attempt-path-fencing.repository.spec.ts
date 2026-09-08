import { randomUUID } from 'crypto';
import { CheckoutPath } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { CheckoutAttemptRepository } from './checkout-attempt.repository';
import { CheckoutAttemptService } from '../services/checkout-attempt.service';
import { CheckoutAttemptStaleFencingService } from '../services/checkout-attempt-stale-fencing.service';
import { CheckoutRolloutParticipantsRepository } from '../../checkout-rollout/repositories/checkout-rollout-participants.repository';
import { CheckoutRolloutParticipantsService } from '../../checkout-rollout/services/checkout-rollout-participants.service';
import { CheckoutRolloutPolicyService } from '../../checkout-rollout/services/checkout-rollout-policy.service';

// Real independent connections, UUID-scoped fixtures, no scheduler locks.
describe('G.PR0 durable path and stale fencing (Postgres)', () => {
  const prisma = new PrismaService();
  const live = new PrismaService();
  const repository = new CheckoutAttemptRepository(prisma);
  const otherRepository = new CheckoutAttemptRepository(live);
  const lifecycle = new CheckoutAttemptService(repository);
  const fence = new CheckoutAttemptStaleFencingService(repository);
  let customerId: string;
  let cartId: string;
  const now = new Date();
  const h1 = new Date(now.getTime() - 600000);
  const staleBefore = new Date(now.getTime() - 180000);

  beforeAll(async () => {
    await Promise.all([prisma.$connect(), live.$connect()]);
    const user = await prisma.user.create({
      data: {
        email: `pr0-${randomUUID()}@example.invalid`,
        passwordHash: 'fixture',
        firstName: 'Test',
        lastName: 'Fixture',
      },
    });
    customerId = user.id;
    cartId = (await prisma.cart.create({ data: { customerId } })).id;
  });
  afterAll(async () => {
    await prisma.checkoutAttempt.deleteMany({ where: { customerId } });
    await prisma.checkoutRolloutParticipant.deleteMany({ where: { customerId } });
    await prisma.user.delete({ where: { id: customerId } });
    await Promise.all([prisma.$disconnect(), live.$disconnect()]);
  });
  async function create(selectedPath: CheckoutPath = 'CART_SCOPED') {
    return (
      await repository.createOrGetByIdempotencyKey({
        selectedPath,
        customerId,
        cartId,
        idempotencyKey: randomUUID(),
        now: h1,
      })
    ).attempt;
  }
  function input(attemptId: string, selectedPath: CheckoutPath = 'CART_SCOPED') {
    return { attemptId, customerId, selectedPath, observedHeartbeatAt: h1, staleBefore, now };
  }

  it.each(['LEGACY', 'CART_SCOPED'] as const)(
    'persists %s, replays it, and cannot rewrite it through create/resume',
    async (selectedPath) => {
      const attempt = await create(selectedPath);
      expect(attempt.selectedPath).toBe(selectedPath);
      expect(
        await lifecycle.inspectByIdempotencyKey(customerId, attempt.idempotencyKey),
      ).toMatchObject({ attempt: { selectedPath } });
      const opposite = selectedPath === 'LEGACY' ? 'CART_SCOPED' : 'LEGACY';
      expect(await lifecycle.createOrResume({ ...attempt, selectedPath: opposite, now })).toEqual({
        ok: false,
        code: 'CHECKOUT_PATH_MISMATCH',
      });
      expect((await repository.findById(attempt.id))!.selectedPath).toBe(selectedPath);
    },
  );

  it('fences unchanged H1 exactly once across two racing connections; blocks late heartbeat and commit', async () => {
    const attempt = await create();
    const otherFence = new CheckoutAttemptStaleFencingService(otherRepository);
    const results = await Promise.all([
      fence.fence(input(attempt.id)),
      otherFence.fence(input(attempt.id)),
    ]);
    expect(results).toContainEqual({ ok: true, outcome: 'FENCED' });
    expect(results).toContainEqual({ ok: false, code: 'ALREADY_FAILED' });
    expect(await otherRepository.updateHeartbeatIfProcessing(attempt.id, customerId, now)).toEqual({
      count: 0,
    });
    // A late order transaction must roll back when the existing commit guard loses.
    let createdOrderId = '';
    await expect(
      live.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            customerId,
            deliveryAddressLine1: 'Fixture',
            deliveryParish: 'KINGSTON',
            deliveryPhone: 'fixture',
          },
        });
        createdOrderId = order.id;
        const committed = await otherRepository.markCommitted(
          tx,
          attempt.id,
          customerId,
          order.id,
          now,
        );
        expect(committed.count).toBe(0);
        throw new Error('rollback after fenced commit');
      }),
    ).rejects.toThrow('rollback after fenced commit');
    expect(await prisma.order.findUnique({ where: { id: createdOrderId } })).toBeNull();
    expect(await repository.findById(attempt.id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'STALE_RECOVERY_FENCED',
      selectedPath: 'CART_SCOPED',
      lastHeartbeatAt: h1,
      orderId: null,
    });
  });

  it('rejects discovered H1 after a live connection advances heartbeat to H2', async () => {
    const attempt = await create();
    const page = await repository.findStaleProcessing({
      heartbeatBefore: staleBefore,
      cursor: null,
      limit: 200,
    });
    expect(page.find((row) => row.id === attempt.id)?.lastHeartbeatAt).toEqual(h1);
    expect(await otherRepository.updateHeartbeatIfProcessing(attempt.id, customerId, now)).toEqual({
      count: 1,
    });
    expect(await fence.fence(input(attempt.id))).toEqual({ ok: false, code: 'STALE_OBSERVATION' });
    expect(await repository.findById(attempt.id)).toMatchObject({
      status: 'PROCESSING',
      lastHeartbeatAt: now,
      failureCode: null,
      selectedPath: 'CART_SCOPED',
    });
  });

  it('rejects discovered H1 after concurrent commit and preserves the order and PAID payment', async () => {
    const attempt = await create();
    const page = await repository.findStaleProcessing({
      heartbeatBefore: staleBefore,
      cursor: null,
      limit: 200,
    });
    expect(page.find((row) => row.id === attempt.id)?.lastHeartbeatAt).toEqual(h1);
    const order = await live.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          customerId,
          deliveryAddressLine1: 'Fixture',
          deliveryParish: 'KINGSTON',
          deliveryPhone: 'fixture',
        },
      });
      expect(
        await otherRepository.markCommitted(tx, attempt.id, customerId, created.id, now),
      ).toEqual({ count: 1 });
      await tx.payment.create({
        data: { orderId: created.id, provider: 'CASH_ON_DELIVERY', status: 'PAID', amount: 42 },
      });
      return created;
    });
    const before = await prisma.order.findUnique({
      where: { id: order.id },
      include: { payment: true },
    });
    expect(await fence.fence(input(attempt.id))).toEqual({ ok: false, code: 'ALREADY_COMMITTED' });
    expect(
      await prisma.order.findUnique({ where: { id: order.id }, include: { payment: true } }),
    ).toEqual(before);
    expect(await repository.findById(attempt.id)).toMatchObject({
      status: 'COMMITTED',
      orderId: order.id,
      selectedPath: 'CART_SCOPED',
    });
  });

  it('fails closed for unknown historical paths and never stamps a path during replay or recovery', async () => {
    // Explicit fixture for a pre-migration/older-writer row, not a normal creation API.
    const attempt = await prisma.checkoutAttempt.create({
      data: { customerId, cartId, idempotencyKey: randomUUID(), lastHeartbeatAt: h1 },
    });
    expect(await fence.fence(input(attempt.id))).toEqual({ ok: false, code: 'UNKNOWN_PATH' });
    expect(await repository.fenceStaleProcessing({ ...input(attempt.id),
      selectedPath: undefined as unknown as CheckoutPath })).toEqual({ count: 0 });
    expect(await repository.fenceStaleProcessing({ ...input(attempt.id),
      observedHeartbeatAt: undefined as unknown as Date })).toEqual({ count: 0 });
    expect(
      await lifecycle.createOrResume({
        customerId,
        cartId,
        idempotencyKey: attempt.idempotencyKey,
        selectedPath: 'CART_SCOPED',
        now,
      }),
    ).toEqual({ ok: false, code: 'CHECKOUT_PATH_MISMATCH' });
    expect(await repository.findById(attempt.id)).toEqual(attempt);
  });

  it('does not fence another customer, another path, or a fresh observation', async () => {
    const attempt = await create('LEGACY');
    expect(await fence.fence(input(attempt.id))).toEqual({ ok: false, code: 'PATH_MISMATCH' });
    expect(await fence.fence({ ...input(attempt.id, 'LEGACY'), customerId: randomUUID() })).toEqual(
      { ok: false, code: 'OWNERSHIP_MISMATCH' },
    );
    expect(await fence.fence({ ...input(attempt.id, 'LEGACY'), staleBefore: h1 })).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(await repository.findById(attempt.id)).toEqual(attempt);
  });

  it('participant disable and lookup failure cannot change ownership or authorize fallback', async () => {
    const attempt = await create();
    const participants = new CheckoutRolloutParticipantsRepository(prisma);
    const administration = new CheckoutRolloutParticipantsService(participants);
    const policy = new CheckoutRolloutPolicyService(participants);
    await administration.setParticipation(customerId, customerId, {
      enabled: true,
      cohort: 'pilot',
      reason: 'fixture',
      expectedRevision: null,
    });
    await administration.setParticipation(customerId, customerId, {
      enabled: false,
      cohort: 'pilot',
      reason: 'fixture disable',
      expectedRevision: 1,
    });
    expect((await policy.evaluateParticipation(customerId)).status).toBe('DISABLED');
    const readFailure = jest
      .spyOn(participants, 'findCurrent')
      .mockRejectedValue(new Error('lookup failure'));
    expect((await policy.evaluateParticipation(customerId)).status).toBe('LOOKUP_FAILED');
    expect(
      await lifecycle.inspectByIdempotencyKey(customerId, attempt.idempotencyKey),
    ).toMatchObject({ attempt: { selectedPath: 'CART_SCOPED' } });
    readFailure.mockRestore();
    expect(await fence.fence(input(attempt.id))).toEqual({ ok: true, outcome: 'FENCED' });
    expect((await repository.findById(attempt.id))!.selectedPath).toBe('CART_SCOPED');
  });
});
