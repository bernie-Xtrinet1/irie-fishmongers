import { randomUUID } from 'crypto';

import { PrismaService } from '../../../database/prisma.service';
import { CheckoutRolloutParticipantsService } from '../services/checkout-rollout-participants.service';
import { CheckoutRolloutPolicyService } from '../services/checkout-rollout-policy.service';
import { CheckoutRolloutParticipantsRepository } from './checkout-rollout-participants.repository';

describe('Checkout rollout persistence (real Postgres)', () => {
  const prisma = new PrismaService();
  const repository = new CheckoutRolloutParticipantsRepository(prisma);
  const service = new CheckoutRolloutParticipantsService(repository);
  const policy = new CheckoutRolloutPolicyService(repository);
  const userIds: string[] = [];
  let customerId: string;
  let actorId: string;
  const state = {
    enabled: true,
    cohort: 'pilot',
    reason: 'Approved pilot',
    expectedRevision: null,
  };

  async function user(): Promise<string> {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        email: `g1-${id}@example.com`,
        passwordHash: 'fixture',
        firstName: 'G1',
        lastName: 'Fixture',
      },
    });
    userIds.push(id);
    return id;
  }

  beforeAll(async () => {
    await prisma.$connect();
    actorId = await user();
  });
  beforeEach(async () => {
    customerId = await user();
  });
  afterAll(async () => {
    // Only this suite's UUID-scoped fixtures; never reset shared tables.
    await prisma.checkoutRolloutParticipant.deleteMany({ where: { customerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it('appends enable/disable history with actor, reason and ordered revision; reads current by revision', async () => {
    expect((await policy.evaluateParticipation(customerId)).status).toBe('NOT_FOUND');
    const first = await service.setParticipation(customerId, actorId, state);
    expect((await policy.evaluateParticipation(customerId)).status).toBe('ENABLED');
    const second = await service.setParticipation(customerId, actorId, {
      ...state,
      enabled: false,
      reason: 'Stop future admission',
      expectedRevision: 1,
    });
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    const history = await service.listHistory(customerId);
    expect(history).toEqual([first, second]);
    expect(history[0]).toMatchObject({ actorId, reason: 'Approved pilot', enabled: true });
    expect(history[1]).toMatchObject({ actorId, reason: 'Stop future admission', enabled: false });
    expect(history.every((row) => row.createdAt instanceof Date)).toBe(true);
    expect(await repository.findCurrent(customerId)).toEqual(second);
    expect(await service.listHistory(customerId, 1, 1)).toEqual([second]);
    expect((await policy.evaluateParticipation(customerId)).status).toBe('DISABLED');
    expect(await prisma.checkoutRolloutParticipant.findUnique({ where: { id: first.id } })).toEqual(
      first,
    );
  });

  it('leaves no first revision after a failed initial append', async () => {
    await expect(
      repository.appendIfCurrent(customerId, actorId, { ...state, reason: '' }),
    ).rejects.toThrow();
    expect(await repository.listHistory(customerId)).toEqual([]);
    expect((await policy.evaluateParticipation(customerId)).status).toBe('NOT_FOUND');
    expect((await service.setParticipation(customerId, actorId, state)).revision).toBe(1);
  });

  it('rejects a stale update and duplicate creation without additional history', async () => {
    await service.setParticipation(customerId, actorId, state);
    await expect(service.setParticipation(customerId, actorId, state)).rejects.toThrow(
      'revision changed',
    );
    await service.setParticipation(customerId, actorId, { ...state, expectedRevision: 1 });
    await expect(
      service.setParticipation(customerId, actorId, { ...state, expectedRevision: 1 }),
    ).rejects.toThrow('revision changed');
    expect((await repository.listHistory(customerId)).map((row) => row.revision)).toEqual([1, 2]);
  });

  it('concurrent creation has one winner and one unambiguous current authority', async () => {
    const results = await Promise.all([
      repository.appendIfCurrent(customerId, actorId, state),
      repository.appendIfCurrent(customerId, actorId, { ...state, enabled: false }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, code: 'STALE_REVISION', currentRevision: 1 },
    ]);
    expect(await repository.listHistory(customerId)).toHaveLength(1);
  });

  it('concurrent updates cannot claim the same next revision', async () => {
    await service.setParticipation(customerId, actorId, state);
    const results = await Promise.all([
      repository.appendIfCurrent(customerId, actorId, {
        ...state,
        expectedRevision: 1,
        enabled: false,
      }),
      repository.appendIfCurrent(customerId, actorId, {
        ...state,
        expectedRevision: 1,
        cohort: 'second',
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, code: 'STALE_REVISION', currentRevision: 2 },
    ]);
    expect((await repository.listHistory(customerId)).map((row) => row.revision)).toEqual([1, 2]);
  });

  it('an insert failure leaves current policy and history intact and releases the lock', async () => {
    const first = await service.setParticipation(customerId, actorId, state);
    // Bypass domain validation to exercise the real database CHECK and transaction rollback.
    await expect(
      repository.appendIfCurrent(customerId, actorId, {
        ...state,
        cohort: '*',
        expectedRevision: 1,
      }),
    ).rejects.toThrow();
    expect(await repository.findCurrent(customerId)).toEqual(first);
    expect(await repository.listHistory(customerId)).toEqual([first]);
    const next = await service.setParticipation(customerId, actorId, {
      ...state,
      expectedRevision: 1,
    });
    expect(next.revision).toBe(2);
  });

  it('missing customer/actor cannot create orphaned policy', async () => {
    await expect(service.setParticipation(randomUUID(), actorId, state)).rejects.toThrow(
      'Customer not found',
    );
    await expect(service.setParticipation(customerId, randomUUID(), state)).rejects.toThrow(
      'Actor not found',
    );
    expect(await repository.listHistory(customerId)).toEqual([]);
  });

  it('database uniqueness and restrictive user foreign keys preserve authority/history', async () => {
    const row = await service.setParticipation(customerId, actorId, state);
    await expect(
      prisma.checkoutRolloutParticipant.create({ data: { ...row, id: randomUUID() } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.user.delete({ where: { id: customerId } })).rejects.toMatchObject({
      code: 'P2003',
    });
    await expect(prisma.user.delete({ where: { id: actorId } })).rejects.toMatchObject({
      code: 'P2003',
    });
    expect(await repository.listHistory(customerId)).toEqual([row]);
  });

  it.each([
    { revision: 0 },
    { revision: -1 },
    { cohort: 'a'.repeat(65) },
    { reason: ' ' },
    { reason: 'a'.repeat(501) },
    { customerId: randomUUID() },
    { actorId: randomUUID() },
  ])('migration rejects invalid persisted state %j', async (change) => {
    await expect(
      prisma.checkoutRolloutParticipant.create({
        data: {
          customerId,
          actorId,
          enabled: false,
          cohort: null,
          reason: 'Valid reason',
          revision: 1,
          ...change,
        },
      }),
    ).rejects.toThrow();
    expect(await repository.findCurrent(customerId)).toBeNull();
  });

  it('schema defaults membership to disabled and account deactivation preserves history', async () => {
    const row = await prisma.checkoutRolloutParticipant.create({
      data: { customerId, actorId, reason: 'Initially disabled', revision: 1 },
    });
    expect(row.enabled).toBe(false);
    await prisma.user.update({ where: { id: customerId }, data: { status: 'DEACTIVATED' } });
    expect(await repository.findCurrent(customerId)).toEqual(row);
  });
});
