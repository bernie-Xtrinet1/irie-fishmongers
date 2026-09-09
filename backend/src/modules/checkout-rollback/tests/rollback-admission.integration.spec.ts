import { isDeepStrictEqual } from 'util';
import { randomUUID } from 'crypto';
import { CheckoutOperation, CheckoutRolloutBehavior } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { CheckoutOperationRepository } from '../../checkout-operation/repositories/checkout-operation.repository';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { CheckoutRolloutParticipantsRepository } from '../../checkout-rollout/repositories/checkout-rollout-participants.repository';
import { RolloutControlsRepository } from '../../checkout-rollout-admin/repositories/rollout-controls.repository';
import { AtomicCheckoutAdmissionService } from '../../checkout-dispatch/services/atomic-checkout-admission.service';
import { assertDisposableEnvironment, assertDisposableRedisTarget, withCleanup, latch } from './rollback-evidence-test-helpers';

describe('G.4a harness safety without external connections', () => {
  it.each(['redis://127.0.0.1:16479', 'redis://127.0.0.1:16479/8'])('accepts dedicated Redis target %s', target => {
    expect(() => assertDisposableRedisTarget(target)).not.toThrow();
  });
  it.each([undefined, '', 'redis://localhost:6379', 'redis://127.0.0.1:6379',
    'redis://[::1]:6379', 'redis://localhost:16479', 'redis://[::1]:16479',
    'redis://example.invalid:16479', 'redis://127.0.0.1:16480', 'redis://127.0.0.1',
    'http://127.0.0.1:16479', 'redis://127.0.0.1:16479?port=6379',
    'redis://user@127.0.0.1:16479', 'redis://127.1:16479', 'not-a-url',
    'redis://127.0.0.1:16479\n', 'redis://127.0.0.1:16479#fragment'])('rejects unsafe Redis target %s before setup', target => {
    const setup = jest.fn();
    expect(() => { assertDisposableRedisTarget(target); setup(); }).toThrow('G.4a requires disposable Redis');
    expect(setup).not.toHaveBeenCalled();
  });
  it('attempts Prisma cleanup even when Redis cleanup throws; retains primary and cleanup failures', async () => {
    const primary = new Error('primary assertion'), cleanup = new Error('Redis quit');
    const disconnect = jest.fn().mockResolvedValue(undefined);
    await expect(withCleanup(() => Promise.reject(primary), [() => { throw cleanup; }, disconnect]))
      .rejects.toMatchObject({ cause: primary, cleanupErrors: [cleanup] });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
  it('reports cleanup failure when work succeeded and still attempts every cleanup', async () => {
    const disconnect = jest.fn().mockRejectedValue(new Error('Prisma disconnect'));
    const quit = jest.fn().mockRejectedValue(new Error('Redis quit'));
    await expect(withCleanup(() => Promise.resolve(undefined), [quit, disconnect])).rejects.toMatchObject({
      message: 'G.4a cleanup failure', cleanupErrors: [expect.any(Error), expect.any(Error)],
    });
    expect(quit).toHaveBeenCalledTimes(1); expect(disconnect).toHaveBeenCalledTimes(1);
  });
  it('releases and joins a delayed writer before propagating an assertion failure', async () => {
    const gate = latch(), primary = new Error('assertion');
    let completed = false;
    const writer = gate.promise.then(() => { completed = true; });
    await expect(withCleanup(() => Promise.reject(primary), [async () => { gate.release(); await writer; }])).rejects.toBe(primary);
    expect(completed).toBe(true);
  });
});

describe('G.4a durable rollback admission matrix (PostgreSQL)', () => {
  const p = new PrismaService();
  const operations = new CheckoutOperationRepository(p), attempts = new CheckoutAttemptRepository(p);
  const controls = new RolloutControlsRepository(p), participants = new CheckoutRolloutParticipantsRepository(p);
  const admission = new AtomicCheckoutAdmissionService(p, operations, attempts, controls, participants);
  let customerId: string, op: CheckoutOperation;
  beforeAll(async () => { assertDisposableEnvironment(); await p.$connect(); });
  beforeEach(async () => {
    customerId = randomUUID();
    await p.user.create({ data: { id: customerId, email: `${customerId}@example.invalid`, passwordHash: 'fixture', firstName: 'Test', lastName: 'Fixture' } });
    const cart = await p.cart.create({ data: { customerId } });
    op = await p.checkoutOperation.create({ data: { customerId, cartId: cart.id, operationKey: randomUUID(), retryKeyHash: randomUUID() } });
    expect((await participants.appendIfCurrent(customerId, customerId, { enabled: true, cohort: 'pilot', reason: 'G4A fixture', expectedRevision: null })).ok).toBe(true);
    await control(false);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (!customerId) return;
    await p.checkoutAttempt.deleteMany({ where: { customerId } });
    await p.checkoutOperation.deleteMany({ where: { customerId } });
    await p.checkoutRolloutParticipant.deleteMany({ where: { customerId } });
    await p.checkoutRolloutControlRevision.deleteMany({ where: { actorId: customerId } });
    await p.order.deleteMany({ where: { customerId } });
    await p.cart.deleteMany({ where: { customerId } });
    await p.user.delete({ where: { id: customerId } });
  });
  afterAll(async () => { await p.$disconnect(); });
  async function control(stopped: boolean, behavior: CheckoutRolloutBehavior = 'CART_SCOPED') {
    expect((await controls.appendIfCurrent(customerId, { expectedRevision: (await controls.findCurrent())?.revision ?? null,
      newAdmissionStopped: stopped, behavior, eligibleCohort: 'pilot', reason: 'G4A control' })).ok).toBe(true);
  }
  const admit = () => admission.admit({ customerId, cartId: op.cartId, operationId: op.id });
  const admissionEvidence = async () => {
    const result = await admit();
    return result.ok ? { ok: result.ok, decision: result.decision, durable: result.durable } : result;
  };
  const stored = () => p.checkoutOperation.findUniqueOrThrow({ where: { id: op.id } });
  it('M03 failed assignment transaction leaves NULL and no attempt/order/payment', async () => {
    const assign = operations.assignPath.bind(operations);
    jest.spyOn(operations, 'assignPath').mockImplementationOnce(async (...args) => { await assign(...args); throw new Error('before commit'); });
    expect(await admissionEvidence()).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect((await stored()).selectedPath).toBeNull();
    expect(await p.checkoutAttempt.count({ where: { customerId } })).toBe(0);
    expect(await p.order.count({ where: { customerId } })).toBe(0);
    expect(await p.payment.count({ where: { order: { customerId } } })).toBe(0);
  });
  it('M04/M25 BLOCKER-1 committed assignment survives lost response and stop without policy reread', async () => {
    const committed = await admit(); // Response deliberately discarded by caller.
    await control(true);
    const read = jest.spyOn(controls, 'findCurrent');
    expect(isDeepStrictEqual(await admit(), committed)).toBe(true);
    expect(read.mock.calls.length).toBe(0); expect((await stored()).selectedPath).toBe('CART_SCOPED');
    expect(await p.checkoutAttempt.count({ where: { customerId } })).toBe(0);
  });
  it('M26 NULL operation is denied after stop and cannot obtain executable ownership', async () => {
    await control(true); expect(await admissionEvidence()).toEqual({ ok: false, code: 'ADMISSION_DENIED' });
    expect((await stored()).selectedPath).toBeNull();
  });
  it('M27 SHADOW leaves NULL; later stop denies rather than persisting a SHADOW path', async () => {
    await control(false, 'SHADOW'); expect(await admissionEvidence()).toMatchObject({ ok: true, decision: 'SHADOW', durable: false });
    expect((await stored()).selectedPath).toBeNull();
    await control(true, 'SHADOW'); expect(await admissionEvidence()).toEqual({ ok: false, code: 'ADMISSION_DENIED' });
  });
  it('assigned LEGACY survives stop; admission does not claim exactly-once execution', async () => {
    await control(false, 'LEGACY'); expect(await admissionEvidence()).toMatchObject({ decision: 'LEGACY' });
    await control(true); expect(await admissionEvidence()).toMatchObject({ decision: 'LEGACY', durable: true });
    expect((await stored()).selectedPath).toBe('LEGACY');
  });
  it.each(['PROCESSING', 'COMMITTED', 'FAILED'] as const)('stop preserves %s attempt ownership and fenced discovery', async status => {
    await admit();
    const order = status === 'COMMITTED' ? await p.order.create({ data: {
      customerId, deliveryAddressLine1: 'Fixture', deliveryParish: 'KINGSTON', deliveryPhone: '000', currency: 'JMD',
    } }) : null;
    const a = await p.checkoutAttempt.create({ data: { customerId, cartId: op.cartId, idempotencyKey: op.operationKey,
      selectedPath: 'CART_SCOPED', status, orderId: order?.id, failureCode: status === 'FAILED' ? 'STALE_RECOVERY_FENCED' : null } });
    await control(true);
    const read = jest.spyOn(controls, 'findCurrent');
    expect(await admissionEvidence()).toMatchObject({ ok: true, decision: 'EXISTING_ATTEMPT', durable: true });
    expect(read.mock.calls.length).toBe(0); expect(isDeepStrictEqual(await attempts.findById(a.id), a)).toBe(true);
    if (status === 'FAILED') expect((await attempts.findFencedCleanupPage({ cursor: null })).some(row => isDeepStrictEqual(row, a))).toBe(true);
  });
});
