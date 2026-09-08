import { randomUUID } from 'crypto';
import { PrismaService } from '../../../database/prisma.service';
import {
  RolloutControlsRepository,
  ROLLOUT_CONTROL_LOCK_ID,
  ROLLOUT_CONTROL_LOCK_NAMESPACE,
} from './rollout-controls.repository';
import { CreateRolloutControlDto } from '../dto/rollout-control.dto';

describe('Global rollout revisions (disposable PostgreSQL)', () => {
  const prisma = new PrismaService();
  const replica = new PrismaService();
  const repository = new RolloutControlsRepository(prisma);
  const other = new RolloutControlsRepository(replica);
  const actorId = randomUUID();
  const input: CreateRolloutControlDto = {
    expectedRevision: null,
    newAdmissionStopped: true,
    behavior: 'DENY',
    eligibleCohort: null,
    reason: 'Initial safe state',
  };

  beforeAll(async () => {
    if (process.env.NODE_ENV !== 'test')
      throw new Error('Global singleton tests require the test environment');
    await Promise.all([prisma.$connect(), replica.$connect()]);
    // Never overwrite a global revision owned by another test or environment.
    if (await repository.findCurrent())
      throw new Error('Disposable control table must start empty');
    await prisma.user.create({
      data: {
        id: actorId,
        email: `${actorId}@example.invalid`,
        passwordHash: 'fixture',
        firstName: 'Control',
        lastName: 'Fixture',
      },
    });
  });
  afterEach(async () => {
    await prisma.checkoutRolloutControlRevision.deleteMany({ where: { actorId } });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: actorId } });
    await Promise.all([prisma.$disconnect(), replica.$disconnect()]);
  });
  it('starts absent, appends revisions from one, orders and bounds history without changing prior rows', async () => {
    expect(await repository.findCurrent()).toBeNull();
    const first = await repository.appendIfCurrent(actorId, input);
    if (!first.ok) throw new Error('Expected first revision');
    const second = await repository.appendIfCurrent(actorId, {
      ...input,
      expectedRevision: 1,
      newAdmissionStopped: false,
      behavior: 'SHADOW',
    });
    if (!second.ok) throw new Error('Expected second revision');
    expect([first.control.revision, second.control.revision]).toEqual([1, 2]);
    expect(await repository.findCurrent()).toEqual(second.control);
    expect(await repository.listHistory(0, 1)).toEqual([first.control]);
    expect(await repository.listHistory(1, 1)).toEqual([second.control]);
    expect(
      await prisma.checkoutRolloutControlRevision.findUnique({ where: { id: first.control.id } }),
    ).toEqual(first.control);
  });
  it('concurrent first writers on separate clients have exactly one winner', async () => {
    const results = await Promise.all([
      repository.appendIfCurrent(actorId, input),
      other.appendIfCurrent(actorId, input),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: 'STALE_REVISION' }]);
    expect((await repository.findCurrent())?.revision).toBe(1);
  });
  it('concurrent same-revision writers on separate clients have exactly one winner', async () => {
    await repository.appendIfCurrent(actorId, input);
    const update = { ...input, expectedRevision: 1 };
    const results = await Promise.all([
      repository.appendIfCurrent(actorId, update),
      other.appendIfCurrent(actorId, update),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: 'STALE_REVISION' }]);
    expect((await repository.listHistory(0, 200)).map((r) => r.revision)).toEqual([1, 2]);
  });
  it('rejects stale revisions without appending', async () => {
    await repository.appendIfCurrent(actorId, input);
    expect(await repository.appendIfCurrent(actorId, input)).toEqual({
      ok: false,
      code: 'STALE_REVISION',
    });
    expect(await repository.listHistory(0, 200)).toHaveLength(1);
  });
  it('persists across a disconnected client and fresh repository', async () => {
    const first = await repository.appendIfCurrent(actorId, input);
    await replica.$disconnect();
    const restarted = new PrismaService();
    try {
      expect(await new RolloutControlsRepository(restarted).findCurrent()).toEqual(
        first.ok ? first.control : null,
      );
    } finally {
      await restarted.$disconnect();
    }
  });
  it.each([{ reason: ' ' }, { eligibleCohort: '*' }])(
    'database checks roll back invalid append %j and release the lock',
    async (invalid) => {
      await expect(repository.appendIfCurrent(actorId, { ...input, ...invalid })).rejects.toThrow();
      expect(await repository.findCurrent()).toBeNull();
      expect((await repository.appendIfCurrent(actorId, input)).ok).toBe(true);
    },
  );
  it('enforces revision uniqueness, positive revisions, actor foreign key and preserves history on failures', async () => {
    const first = await repository.appendIfCurrent(actorId, input);
    if (!first.ok) throw new Error('Expected revision');
    await expect(
      prisma.checkoutRolloutControlRevision.create({
        data: { ...first.control, id: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.checkoutRolloutControlRevision.create({
        data: { ...first.control, id: randomUUID(), revision: 0 },
      }),
    ).rejects.toThrow();
    await expect(prisma.user.delete({ where: { id: actorId } })).rejects.toMatchObject({
      code: 'P2003',
    });
    expect(
      await repository.appendIfCurrent(randomUUID(), { ...input, expectedRevision: 1 }),
    ).toEqual({ ok: false, code: 'ACTOR_NOT_FOUND' });
    expect(await repository.listHistory(0, 200)).toEqual([first.control]);
  });
  it('uses the documented transaction lock and releases it on commit', async () => {
    await repository.appendIfCurrent(actorId, input);
    const acquired = await replica.$transaction(
      (tx) =>
        tx.$queryRaw<
          { acquired: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(${ROLLOUT_CONTROL_LOCK_NAMESPACE}::integer, ${ROLLOUT_CONTROL_LOCK_ID}::integer) AS acquired`,
    );
    expect(acquired[0]?.acquired).toBe(true);
    expect(Object.getOwnPropertyNames(RolloutControlsRepository.prototype).sort()).toEqual([
      'appendIfCurrent',
      'constructor',
      'findCurrent',
      'listHistory',
    ]);
  });
});
