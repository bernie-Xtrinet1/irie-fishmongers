import { randomUUID } from 'crypto';
import { CheckoutOperation, CheckoutRolloutBehavior, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { CheckoutOperationRepository } from '../../checkout-operation/repositories/checkout-operation.repository';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { CheckoutRolloutParticipantsRepository } from '../../checkout-rollout/repositories/checkout-rollout-participants.repository';
import { RolloutControlsRepository } from '../../checkout-rollout-admin/repositories/rollout-controls.repository';
import { AtomicCheckoutAdmissionService } from './atomic-checkout-admission.service';
import { openAcquisitionSchema } from '../../checkout/services/checkout-acquisition-test-helpers';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('G.3b real PostgreSQL admission and admin races', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openAcquisitionSchema>>;
  let prisma: PrismaService;
  let replica: PrismaService;
  let observer: PrismaService;
  function build(client: PrismaService) {
    const operations = new CheckoutOperationRepository(client);
    const attempts = new CheckoutAttemptRepository(client);
    const controls = new RolloutControlsRepository(client);
    const participants = new CheckoutRolloutParticipantsRepository(client);
    return {
      operations,
      attempts,
      controls,
      participants,
      service: new AtomicCheckoutAdmissionService(
        client,
        operations,
        attempts,
        controls,
        participants,
      ),
    };
  }
  let first: ReturnType<typeof build>;
  let second: ReturnType<typeof build>;
  let customerId: string;
  let operation: CheckoutOperation;
  const context = () => ({ customerId, cartId: operation.cartId, operationId: operation.id });
  const globalInput = (
    behavior: CheckoutRolloutBehavior = 'CART_SCOPED',
    expectedRevision: number | null = null,
    stopped = false,
  ) => ({
    behavior,
    expectedRevision,
    newAdmissionStopped: stopped,
    eligibleCohort: 'pilot',
    reason: 'Admission race fixture',
  });
  const participantInput = (enabled = true, expectedRevision: number | null = null) => ({
    enabled,
    expectedRevision,
    cohort: 'pilot',
    reason: 'Participant race fixture',
  });

  beforeAll(async () => {
    schema = await openAcquisitionSchema();
    prisma = schema.prisma; replica = schema.newClient(); observer = schema.newClient();
    first = build(prisma); second = build(replica);
    if (process.env.NODE_ENV !== 'test') throw new Error('Requires test database');
    await Promise.all([prisma.$connect(), replica.$connect(), observer.$connect()]);
    if (await first.controls.findCurrent())
      throw new Error('Requires disposable empty global controls');
  });
  beforeEach(async () => {
    customerId = randomUUID();
    await prisma.user.create({
      data: {
        id: customerId,
        email: `${customerId}@example.invalid`,
        firstName: 'Atomic',
        lastName: 'Fixture',
        passwordHash: 'fixture',
      },
    });
    const cart = await prisma.cart.create({ data: { customerId } });
    operation = await prisma.checkoutOperation.create({
      data: { customerId, cartId: cart.id, operationKey: randomUUID(), retryKeyHash: randomUUID() },
    });
    if (!await prisma.reservationFenceTransition.count()) {
      const mode = await prisma.reservationEngineModeConfig.create({ data: { mode: 'CART_SCOPED', updatedById: customerId } });
      await prisma.reservationFenceTransition.create({ data: { incarnation: randomUUID(), epoch: 7, revision: 1,
        phase: 'OPEN', protocol: 1, status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), mode: 'CART_SCOPED',
        modeRevision: mode.revision, reason: 'OPEN', actorId: randomUUID() } });
    }
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    // Only this test's UUID-owned records; no table reset or shared-data deletion.
    await prisma.checkoutAttempt.deleteMany({ where: { customerId } });
    await prisma.checkoutOperation.deleteMany({ where: { customerId } });
    await prisma.checkoutRolloutParticipant.deleteMany({ where: { customerId } });
    await prisma.checkoutRolloutControlRevision.deleteMany({ where: { actorId: customerId } });
    await prisma.cart.deleteMany({ where: { customerId } });
    // The first user's retained mode revision is removed with the schema.
  });
  afterAll(async () => {
    try { await Promise.all([replica?.$disconnect(), observer?.$disconnect()]); }
    finally { if (schema) await schema.close(); }
  });

  async function enable(behavior: CheckoutRolloutBehavior = 'CART_SCOPED') {
    expect((await first.controls.appendIfCurrent(customerId, globalInput(behavior))).ok).toBe(true);
    expect(
      (await first.participants.appendIfCurrent(customerId, customerId, participantInput())).ok,
    ).toBe(true);
  }
  const stored = () => prisma.checkoutOperation.findUniqueOrThrow({ where: { id: operation.id } });
  function pauseGlobalRead(repository: RolloutControlsRepository) {
    const entered = latch(),
      resume = latch();
    const read = repository.findCurrent.bind(repository);
    jest
      .spyOn(repository, 'findCurrent')
      .mockImplementationOnce(async (tx?: Prisma.TransactionClient) => {
        entered.release();
        await resume.promise;
        return read(tx);
      });
    return { entered: entered.promise, release: resume.release };
  }
  function pauseParticipantRead(repository: CheckoutRolloutParticipantsRepository) {
    const entered = latch(),
      resume = latch();
    const read = repository.findCurrent.bind(repository);
    jest.spyOn(repository, 'findCurrent').mockImplementationOnce(async (id, tx) => {
      entered.release();
      await resume.promise;
      return read(id, tx);
    });
    return { entered: entered.promise, release: resume.release };
  }
  async function waitForBlockedLock() {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const rows = await observer.$queryRaw<
        { waiting: boolean }[]
      >`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())) AS waiting`;
      if (rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected real PostgreSQL advisory-lock contention');
  }

  it.each(['LEGACY', 'CART_SCOPED'] as const)(
    'commits %s once and preserves it after stop/disable and response loss',
    async (behavior) => {
      await enable(behavior);
      const result = await first.service.admit(context());
      expect(result).toMatchObject({ ok: true, decision: behavior, durable: true });
      expect((await stored()).selectedPath).toBe(behavior);
      await second.controls.appendIfCurrent(customerId, globalInput('DENY', 1, true));
      await second.participants.appendIfCurrent(customerId, customerId, participantInput(false, 1));
      // Discard the first response. A fresh service/client must recover the durable path.
      const readGlobal = jest
        .spyOn(second.controls, 'findCurrent')
        .mockRejectedValue(new Error('policy offline'));
      const readParticipant = jest
        .spyOn(second.participants, 'findCurrent')
        .mockRejectedValue(new Error('policy offline'));
      expect(await second.service.admit(context())).toMatchObject({ ok: true,
        decision: behavior === 'CART_SCOPED' ? 'EXISTING_ATTEMPT' : 'LEGACY' });
      expect(readGlobal).not.toHaveBeenCalled();
      expect(readParticipant).not.toHaveBeenCalled();
      expect(await prisma.checkoutAttempt.count({ where: { customerId } })).toBe(behavior === 'CART_SCOPED' ? 1 : 0);
    },
  );
  it('missing global and participant failure leave no path or fingerprint', async () => {
    expect(await first.service.admit(context())).toEqual({ ok: false, code: 'UNAVAILABLE' });
    await enable();
    jest
      .spyOn(first.participants, 'findCurrent')
      .mockRejectedValue(new Error('database read failure'));
    expect(await first.service.admit(context())).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(await stored()).toMatchObject({ selectedPath: null, priceLockFingerprint: null });
  });
  it('SHADOW remains unassigned and a later stop changes its nondurable selection', async () => {
    await enable('SHADOW');
    expect(await first.service.admit(context())).toMatchObject({
      ok: true,
      decision: 'SHADOW',
      durable: false,
    });
    expect(await stored()).toEqual(operation);
    expect(await prisma.checkoutAttempt.count({ where: { customerId } })).toBe(0);
    expect(await prisma.order.count({ where: { customerId } })).toBe(0);
    expect(await prisma.payment.count({ where: { order: { customerId } } })).toBe(0);
    expect(await prisma.cartItem.count({ where: { cartId: operation.cartId } })).toBe(0);
    await second.controls.appendIfCurrent(customerId, globalInput('SHADOW', 1, true));
    expect(await first.service.admit(context())).toEqual({ ok: false, code: 'ADMISSION_DENIED' });
    expect((await stored()).selectedPath).toBeNull();
  });
  it('an exception after assignment but before commit rolls back path and releases locks', async () => {
    await enable();
    const assign = first.attempts.createWithReservationCapability.bind(first.attempts);
    jest.spyOn(first.attempts, 'createWithReservationCapability').mockImplementationOnce(async (...args) => {
      await assign(...args);
      throw new Error('simulated crash after write before commit');
    });
    expect(await first.service.admit(context())).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect((await stored()).selectedPath).toBeNull();
    expect(await prisma.checkoutAttempt.count({ where: { customerId } })).toBe(0);
    expect(await second.service.admit(context())).toMatchObject({
      ok: true,
      decision: 'CART_SCOPED',
    });
  });
  it.each(['stop', 'legacy'] as const)(
    'admission wins against later global %s mutation',
    async (change) => {
      await enable();
      const paused = pauseGlobalRead(first.controls);
      const admission = first.service.admit(context());
      await paused.entered;
      const mutation = second.controls.appendIfCurrent(
        customerId,
        globalInput(change === 'stop' ? 'DENY' : 'LEGACY', 1, change === 'stop'),
      );
      try {
        await waitForBlockedLock();
      } finally {
        paused.release();
      }
      expect(await admission).toMatchObject({ ok: true, decision: 'CART_SCOPED' });
      expect((await mutation).ok).toBe(true);
      expect(await first.service.admit(context())).toMatchObject({
        ok: true,
        decision: 'EXISTING_ATTEMPT',
      });
      expect((await stored()).selectedPath).toBe('CART_SCOPED');
    },
  );
  it.each(['stop', 'legacy'] as const)(
    'global %s mutation wins against later admission',
    async (change) => {
      await enable();
      const paused = pauseGlobalRead(second.controls);
      const mutation = second.controls.appendIfCurrent(
        customerId,
        globalInput(change === 'stop' ? 'DENY' : 'LEGACY', 1, change === 'stop'),
      );
      await paused.entered;
      const admission = first.service.admit(context());
      try {
        await waitForBlockedLock();
      } finally {
        paused.release();
      }
      expect((await mutation).ok).toBe(true);
      expect(await admission).toMatchObject(
        change === 'stop'
          ? { ok: false, code: 'ADMISSION_DENIED' }
          : { ok: true, decision: 'LEGACY' },
      );
      expect((await stored()).selectedPath).toBe(change === 'stop' ? null : 'LEGACY');
    },
  );
  it('admission wins against later participant disable with no path rewrite', async () => {
    await enable();
    const paused = pauseParticipantRead(first.participants);
    const admission = first.service.admit(context());
    await paused.entered;
    const disable = second.participants.appendIfCurrent(
      customerId,
      customerId,
      participantInput(false, 1),
    );
    try {
      await waitForBlockedLock();
    } finally {
      paused.release();
    }
    expect(await admission).toMatchObject({ ok: true, decision: 'CART_SCOPED' });
    expect((await disable).ok).toBe(true);
    expect(await second.service.admit(context())).toMatchObject({
      ok: true,
      decision: 'EXISTING_ATTEMPT',
    });
  });
  it('participant disable wins against later admission with no reverse lock order', async () => {
    await enable();
    const paused = pauseParticipantRead(second.participants);
    const disable = second.participants.appendIfCurrent(
      customerId,
      customerId,
      participantInput(false, 1),
    );
    await paused.entered;
    const admission = first.service.admit(context());
    try {
      await waitForBlockedLock();
    } finally {
      paused.release();
    }
    expect((await disable).ok).toBe(true);
    expect(await admission).toEqual({ ok: false, code: 'ADMISSION_DENIED' });
    expect((await stored()).selectedPath).toBeNull();
  });
  it('concurrent admissions have one CAS and both observe the same committed ownership', async () => {
    await enable();
    const writeFirst = jest.spyOn(first.operations, 'bindReservationCapability');
    const writeSecond = jest.spyOn(second.operations, 'bindReservationCapability');
    const paused = pauseGlobalRead(first.controls);
    const winner = first.service.admit(context());
    await paused.entered;
    const contender = second.service.admit(context());
    try {
      await waitForBlockedLock();
    } finally {
      paused.release();
    }
    const results = await Promise.all([winner, contender]);
    expect(results[0].ok && results[1].ok && results[0].operation).toEqual(results[1].ok && results[1].operation);
    expect(results[1]).toMatchObject({ ok: true, decision: 'EXISTING_ATTEMPT' });
    expect(results[0]).toMatchObject({ ok: true, decision: 'CART_SCOPED', durable: true });
    expect(writeFirst.mock.calls.length + writeSecond.mock.calls.length).toBe(1);
  });
  it('existing attempt is returned before any policy reads and inconsistent ownership fails closed', async () => {
    await enable();
    await first.service.admit(context());
    expect(await prisma.checkoutAttempt.count({ where: { customerId } })).toBe(1);
    const reads = jest
      .spyOn(first.controls, 'findCurrent')
      .mockRejectedValue(new Error('policy unavailable'));
    expect(await first.service.admit(context())).toMatchObject({
      ok: true,
      decision: 'EXISTING_ATTEMPT',
    });
    expect(reads).not.toHaveBeenCalled();
    expect(await first.service.admit({ ...context(), cartId: randomUUID() })).toEqual({
      ok: false,
      code: 'PATH_MISMATCH',
    });
    expect((await stored()).selectedPath).toBe('CART_SCOPED');
  });
});
