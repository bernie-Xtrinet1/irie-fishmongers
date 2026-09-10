import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { ReservationEngineMode } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutOperationRepository } from '../../checkout-operation/repositories/checkout-operation.repository';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { assertDisposableEnvironment, withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { CompensationTestFixture, seedCartAndProduct, setUpCompensationFixture,
  tearDownCompensationFixture } from '../../mirror-compensation/repositories/compensation-repository-test-helpers';
import { ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { InfrastructureAcknowledgement, ReservationFenceService } from '../services/reservation-fence.service';
import { ReservationCapabilityService } from '../services/reservation-capability.service';
import { FenceResult, FenceTuple } from '../types/reservation-fence.types';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { ReservationMutationAuthorityService } from '../services/reservation-mutation-authority.service';
import { MUTATION_HISTORY_KEY, executionGateKey, resourceGuardKey, mutationPermitKey } from '../lua/reservation-mutation-common.lua';

function success<T>(result: FenceResult<T>): T {
  if (result.code !== 'ACCEPTED') throw new Error(result.code);
  return result.value;
}
interface Fixture {
  prisma: PrismaService; other: PrismaService; redis: Redis; repository: ReservationFenceRepository;
  service: ReservationFenceService; second: ReservationFenceService; capabilities: ReservationCapabilityService;
  secondCapabilities: ReservationCapabilityService; ack: InfrastructureAcknowledgement;
  customerId: string; cartId: string; mode: ReservationEngineMode;
  mutations: ReservationMutationAuthorityService;
  productId: string; extraKeys: string[];
}
async function isolated(work: (f: Fixture) => Promise<void>, mode: ReservationEngineMode = 'CART_SCOPED') {
  assertDisposableEnvironment();
  const prisma = new PrismaService();
  const other = new PrismaService();
  const redis = new Redis(process.env.REDIS_URL!);
  let fixture: CompensationTestFixture | undefined;
  const actorId = randomUUID();
  const repository = new ReservationFenceRepository(prisma);
  const secondRepo = new ReservationFenceRepository(other);
  const service = new ReservationFenceService(repository, new RedisService(redis));
  const second = new ReservationFenceService(secondRepo, new RedisService(redis));
  const mutations = new ReservationMutationAuthorityService(repository, new RedisService(redis));
  const extraKeys: string[] = [];
  return withCleanup(() => withCleanup(async () => {
    await Promise.all([prisma.$connect(), other.$connect()]);
    expect(await redis.exists(RESERVATION_FENCE_KEY)).toBe(0);
    fixture = await setUpCompensationFixture(prisma);
    const { customerId, cartId, productId } = await seedCartAndProduct(fixture);
    await prisma.reservationEngineModeConfig.create({ data: { mode, updatedById: customerId } });
    await work({ prisma, other, redis, repository, service, second, mode, customerId, cartId, mutations, productId, extraKeys,
      capabilities: new ReservationCapabilityService(repository, service, new CheckoutOperationRepository(prisma), new CheckoutAttemptRepository(prisma), mutations),
      secondCapabilities: new ReservationCapabilityService(secondRepo, second, new CheckoutOperationRepository(other), new CheckoutAttemptRepository(other), new ReservationMutationAuthorityService(secondRepo, new RedisService(redis))),
      ack: { actorId, evidenceId: randomUUID(), endpointQuarantined: true, oldPrimaryFenced: true, controlledPromotion: true } });
  }, [async () => {
    await prisma.reservationFenceTransition.deleteMany({ where: { actorId } });
    if (fixture) {
      const ops = await prisma.checkoutOperation.findMany({ where: { customerId: { in: fixture.userIds } }, select: { id: true } });
      for (const op of ops) await redis.del(executionGateKey(op.id));
      await prisma.cartReservationSyncState.deleteMany({ where: { cart: { customerId: { in: fixture.userIds } } } });
      await prisma.checkoutAttempt.deleteMany({ where: { customerId: { in: fixture.userIds } } });
      await prisma.checkoutOperation.deleteMany({ where: { customerId: { in: fixture.userIds } } });
      await prisma.reservationEngineModeConfig.deleteMany({ where: { updatedById: { in: fixture.userIds } } });
      await tearDownCompensationFixture(fixture);
    }
  }, () => redis.del(RESERVATION_FENCE_KEY, MUTATION_HISTORY_KEY, ...extraKeys)]), [() => redis.quit(), () => prisma.$disconnect(), () => other.$disconnect()]);
}
async function bootstrap(f: Fixture) {
  const target = success(await f.service.allocateIncarnation(f.ack));
  expect(target.phase).toBe('FROZEN');
  expect((await f.service.reconcile()).code).toBe('ACCEPTED');
  return target;
}
async function open(f: Fixture) {
  const frozen = await bootstrap(f);
  const target = success(await f.service.prepare(frozen, 'OPEN', f.ack.actorId));
  expect((await f.service.reconcile()).code).toBe('ACCEPTED');
  return target;
}
async function operation(f: Fixture, selectedPath?: 'LEGACY' | 'CART_SCOPED') {
  const row = await f.prisma.checkoutOperation.create({ data: { customerId: f.customerId, cartId: f.cartId,
    operationKey: randomUUID(), retryKeyHash: randomUUID(), selectedPath } });
  return row.id;
}

describe('G.4b.1 PostgreSQL authority and capability persistence', () => {
  it('G.4b.2a.1 binds registration to acknowledged phase and a fixed lease ceiling without reopening gates', () => isolated(async f => {
    const current = await open(f);
    const marker = await f.prisma.cartReservationSyncState.create({ data: { cartId: f.cartId,
      productId: f.productId, expectedMutationVersion: 1, expectedQuantity: 2, generation: 1 } });
    f.extraKeys.push(resourceGuardKey(marker.id));
    const initialized = await f.mutations.initializeResource(marker.id, f.customerId, 1, randomUUID());
    if (initialized.code !== 'ACCEPTED') throw new Error('Resource fixture denied');
    const resources = [initialized.value];
    const positive = { effect: 'RECONCILE_POSITIVE', authorizationPhase: 'OPEN', constraint: { kind: 'NONE' } } as const;
    const repair = await f.mutations.registerRepair(positive, resources, randomUUID());
    if (repair.code !== 'ACCEPTED') throw new Error('Positive permit denied');
    f.extraKeys.push(mutationPermitKey(repair.value.permitId));
    expect(repair.value.authorizationPhase).toBe('OPEN');
    expect((await f.mutations.registerCart(positive, resources, randomUUID())).code).toBe('FENCE_REJECTED');
    const release = { effect: 'RELEASE', authorizationPhase: 'DRAINING', constraint: { kind: 'NONE' } } as const;
    expect((await f.mutations.registerCart(release, resources, randomUUID())).code).toBe('FENCE_REJECTED');
    const id = await operation(f);
    success(await f.capabilities.bind(id, f.customerId, current.epoch));
    const attempt = success(await f.capabilities.createAttempt(id, f.customerId, current.epoch));
    expect((await f.mutations.initializeExecutionGate(id, f.customerId)).code).toBe('ACCEPTED');
    const draining = success(await f.service.prepare(current, 'DRAINING', f.ack.actorId));
    // PREPARED cannot issue, even before its Redis CAS.
    expect((await f.mutations.registerCart(release, resources, randomUUID())).code).toBe('FENCE_REJECTED');
    expect((await f.service.reconcile()).code).toBe('ACCEPTED');
    const before = await f.redis.get(RESERVATION_FENCE_KEY);
    const cleanup = await f.mutations.registerCart(release, resources, randomUUID());
    if (cleanup.code !== 'ACCEPTED') throw new Error('DRAINING release denied');
    f.extraKeys.push(mutationPermitKey(cleanup.value.permitId));
    expect(cleanup.value.tuple).toEqual(draining);
    expect((await f.mutations.registerRepair(positive, resources, randomUUID())).code).toBe('FENCE_REJECTED');
    expect((await f.mutations.registerRepair({ ...positive, authorizationPhase: 'DRAINING' }, resources, randomUUID())).code).toBe('FENCE_REJECTED');
    const lease = { effect: 'CHECKOUT_LEASE_EXTEND', authorizationPhase: 'DRAINING',
      constraint: { kind: 'LEASE_CEILING', ceilingMs: Date.now() + 30000 } } as const;
    const bound = await f.mutations.registerCheckout(lease, resources, randomUUID(), id, attempt.id);
    if (bound.code !== 'ACCEPTED') throw new Error('Bound lease denied');
    f.extraKeys.push(mutationPermitKey(bound.value.permitId));
    expect(bound.value.constraint).toEqual(lease.constraint);
    expect(await f.redis.get(RESERVATION_FENCE_KEY)).toBe(before);
    expect((await f.mutations.closeExecutionGate(id, f.customerId)).code).toBe('ACCEPTED');
    const gate = await f.redis.get(executionGateKey(id));
    expect((await f.mutations.registerCheckout(lease, resources, randomUUID(), id, attempt.id)).code).toBe('FENCE_REJECTED');
    expect(await f.redis.get(executionGateKey(id))).toBe(gate);
    success(await f.service.prepare(draining, 'FROZEN', f.ack.actorId));
    expect((await f.service.reconcile()).code).toBe('ACCEPTED');
    expect((await f.mutations.registerCart(release, resources, randomUUID())).code).toBe('FENCE_REJECTED');
  }));
  it('G.4b.2a registers only acknowledged owned scope, not caller tuple assertions', () => isolated(async f => {
    const current = await open(f);
    const marker = await f.prisma.cartReservationSyncState.create({ data: { cartId: f.cartId,
      productId: f.productId, expectedMutationVersion: 1, expectedQuantity: 2, generation: 1 } });
    f.extraKeys.push(resourceGuardKey(marker.id));
    const initialized = await f.mutations.initializeResource(marker.id, f.customerId, 1, randomUUID());
    if (initialized.code !== 'ACCEPTED') throw new Error('Resource fixture denied');
    const resources = [initialized.value];
    const cart = await f.mutations.registerCart({ effect: 'RESERVE', authorizationPhase: 'OPEN', constraint: { kind: 'NONE' } }, resources, randomUUID());
    if (cart.code !== 'ACCEPTED') throw new Error('Cart permit denied');
    f.extraKeys.push(mutationPermitKey(cart.value.permitId));
    expect(cart.value.family).toBe('PRE_CHECKOUT_CART');
    const repair = await f.mutations.registerRepair({ effect: 'MALFORMED_SUSPECT', authorizationPhase: 'OPEN', constraint: { kind: 'NONE' } }, resources, randomUUID());
    if (repair.code !== 'ACCEPTED') throw new Error('Repair permit denied');
    f.extraKeys.push(mutationPermitKey(repair.value.permitId));
    expect(repair.value.family).toBe('ADMIN_OR_RECOVERY');
    expect((await f.mutations.registerCart({ effect: 'CHECKOUT_MARK', authorizationPhase: 'OPEN', constraint: { kind: 'NONE' } }, resources, randomUUID())).code).toBe('FENCE_REJECTED');
    expect((await f.mutations.registerCart({ effect: 'RESERVE', authorizationPhase: 'OPEN', constraint: { kind: 'NONE' } }, [{ ...resources[0]!, customerId: randomUUID() }], randomUUID())).code).toBe('FENCE_REJECTED');
    const id = await operation(f);
    success(await f.capabilities.bind(id, f.customerId, current.epoch));
    expect((await f.mutations.initializeExecutionGate(id, f.customerId)).code).toBe('ACCEPTED');
    const attempt = success(await f.capabilities.createAttempt(id, f.customerId, current.epoch));
    const checkout = await f.mutations.registerCheckout({ effect: 'CHECKOUT_MARK', authorizationPhase: 'OPEN', constraint: { kind: 'NONE' } }, resources, randomUUID(), id, attempt.id);
    if (checkout.code !== 'ACCEPTED') throw new Error('Execution permit denied');
    f.extraKeys.push(mutationPermitKey(checkout.value.permitId));
    expect(checkout.value.family).toBe('CHECKOUT_EXECUTION_OR_SETTLEMENT');
    const raw = await f.redis.get(mutationPermitKey(checkout.value.permitId));
    const op = await f.prisma.checkoutOperation.findUniqueOrThrow({ where: { id } });
    expect(raw!.includes(op.operationKey)).toBe(false);
    expect(raw!.includes(op.retryKeyHash)).toBe(false);
    await f.service.prepare(current, 'FROZEN', f.ack.actorId);
    expect((await f.mutations.registerCart({ effect: 'RESERVE', authorizationPhase: 'OPEN', constraint: { kind: 'NONE' } }, resources, randomUUID())).code).toBe('FENCE_REJECTED');
  }));
  it('G.4b.2a closes Redis before DB revocation, survives DB failure and retries without reopening', () => isolated(async f => {
    const current = await open(f);
    const id = await operation(f);
    success(await f.capabilities.bind(id, f.customerId, current.epoch));
    expect((await f.mutations.initializeExecutionGate(id, f.customerId)).code).toBe('ACCEPTED');
    const failure = jest.spyOn(CheckoutOperationRepository.prototype, 'revokeReservationCapability').mockImplementationOnce(() => (async () => {
      const gate = JSON.parse((await f.redis.get(executionGateKey(id)))!) as { state: string };
      expect(gate.state).toBe('REVOKED');
      const row = await f.other.checkoutOperation.findUniqueOrThrow({ where: { id } });
      expect(row.reservationCapabilityState).toBe('ACTIVE');
      throw new Error('SIMULATED_DATABASE_FAILURE');
    })() as ReturnType<CheckoutOperationRepository['revokeReservationCapability']>);
    try { await expect(f.capabilities.revoke(id, f.customerId)).rejects.toThrow('SIMULATED_DATABASE_FAILURE'); }
    finally { failure.mockRestore(); }
    expect((await f.mutations.initializeExecutionGate(id, f.customerId)).code).toBe('FENCE_REJECTED');
    expect((await f.capabilities.revoke(id, f.customerId)).code).toBe('ACCEPTED');
    expect((await f.prisma.checkoutOperation.findUniqueOrThrow({ where: { id } })).reservationCapabilityState).toBe('REVOKED');
  }));
  it('G.4b.2a missing gate cannot acknowledge revocation or reconstruct enabled authority', () => isolated(async f => {
    const current = await open(f);
    const id = await operation(f);
    success(await f.capabilities.bind(id, f.customerId, current.epoch));
    expect((await f.mutations.initializeExecutionGate(id, f.customerId)).code).toBe('ACCEPTED');
    expect((await f.mutations.closeExecutionGate(id, f.customerId)).code).toBe('ACCEPTED');
    await f.redis.del(executionGateKey(id));
    expect(await f.mutations.initializeExecutionGate(id, f.customerId))
      .toEqual({ code: 'FENCE_REJECTED', reason: 'MISSING_EXECUTION_GATE' });
    expect((await f.capabilities.revoke(id, f.customerId)).code).toBe('MISSING_EXECUTION_GATE');
    expect((await f.prisma.checkoutOperation.findUniqueOrThrow({ where: { id } })).reservationCapabilityState).toBe('ACTIVE');
  }));
  it('holds the PostgreSQL lock throughout the actual Redis/ack cycle, then releases it', () => isolated(async f => {
    const current = await open(f);
    await f.service.prepare(current, 'FROZEN', f.ack.actorId);
    const original = f.redis.eval.bind(f.redis);
    let checked = false;
    const pause = jest.spyOn(f.redis, 'eval').mockImplementationOnce(async (...args: Parameters<Redis['eval']>) => {
      const locks = await f.other.$transaction(async tx => {
        const rows = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(1380339280, 1) AS acquired`;
        return rows[0]!.acquired;
      });
      expect(locks).toBe(false);
      checked = true;
      return original(...args);
    });
    try { expect((await f.service.reconcile()).code).toBe('ACCEPTED'); }
    finally { pause.mockRestore(); }
    expect(checked).toBe(true);
    const released = await f.other.$transaction(async tx => {
      const rows = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(1380339280, 1) AS acquired`;
      return rows[0]!.acquired;
    });
    expect(released).toBe(true);
  }));
  it('does not backfill an unassigned operation that already has a historical attempt', () => isolated(async f => {
    const current = await open(f);
    const id = await operation(f);
    const op = await f.prisma.checkoutOperation.findUniqueOrThrow({ where: { id } });
    await f.prisma.checkoutAttempt.create({ data: { idempotencyKey: op.operationKey, customerId: f.customerId, cartId: f.cartId } });
    expect((await f.capabilities.bind(id, f.customerId, current.epoch)).code).toBe('UNKNOWN_CAPABILITY');
    await expect(f.prisma.checkoutOperation.update({ where: { id }, data: { selectedPath: 'CART_SCOPED',
      reservationExecutionEpoch: current.epoch, reservationCapabilityState: 'ACTIVE' } })).rejects.toBeDefined();
  }));
  it('requires explicit infrastructure evidence and starts PREPARED/CLOSED', () => isolated(async f => {
    expect((await f.service.allocateIncarnation({ ...f.ack, oldPrimaryFenced: false } as unknown as InfrastructureAcknowledgement)).code).toBe('INFRASTRUCTURE_ACK_REQUIRED');
    const t = success(await f.service.allocateIncarnation(f.ack));
    expect(await f.redis.exists(RESERVATION_FENCE_KEY)).toBe(0);
    const row = await f.prisma.reservationFenceTransition.findUniqueOrThrow({ where: { id: t.transitionId } });
    expect([row.phase, row.status, row.acknowledgedAt]).toEqual(['FROZEN', 'PREPARED', null]);
    expect((await f.service.reconcile()).code).toBe('ACCEPTED');
    expect(success(await f.second.reconcile()).revision).toBe(t.revision);
  }));
  it('opening intent grants nothing until physical CAS and PG acknowledgement', () => isolated(async f => {
    const first = await bootstrap(f);
    const id = await operation(f);
    await f.service.prepare(first, 'OPEN', f.ack.actorId);
    expect((await f.capabilities.bind(id, f.customerId, first.epoch)).code).toBe('DURABLE_REDIS_DISAGREEMENT');
    await f.service.reconcile();
    expect((await f.capabilities.bind(id, f.customerId, first.epoch)).code).toBe('ACCEPTED');
  }));
  it('restriction intent blocks issuance before Redis changes', () => isolated(async f => {
    const current = await open(f);
    await f.service.prepare(current, 'DRAINING', f.ack.actorId);
    expect((JSON.parse((await f.redis.get(RESERVATION_FENCE_KEY))!) as FenceTuple).phase).toBe('OPEN');
    expect((await f.capabilities.bind(await operation(f), f.customerId, current.epoch)).code).toBe('DURABLE_REDIS_DISAGREEMENT');
    expect((await f.service.reconcile()).code).toBe('ACCEPTED');
  }));
  it('crash after physical CAS leaves durable intent; new service/pool completes exact acknowledgement', () => isolated(async f => {
    const current = await open(f);
    const next = success(await f.service.prepare(current, 'FROZEN', f.ack.actorId));
    const crash = jest.spyOn(f.repository, 'acknowledge').mockRejectedValueOnce(new Error('simulated crash'));
    try { await expect(f.service.reconcile()).rejects.toThrow('simulated crash'); }
    finally { crash.mockRestore(); }
    expect((await f.prisma.reservationFenceTransition.findUniqueOrThrow({ where: { id: next.transitionId } })).status).toBe('PREPARED');
    expect(success(await f.second.reconcile()).revision).toBe(next.revision);
    expect(success(await f.second.reconcile()).revision).toBe(next.revision);
  }));
  it('missing control after restart stays closed; no automatic recreation of acknowledged OPEN', () => isolated(async f => {
    await open(f);
    await f.redis.del(RESERVATION_FENCE_KEY);
    expect((await f.second.reconcile()).code).toBe('MISSING_CONTROL');
    expect(await f.redis.exists(RESERVATION_FENCE_KEY)).toBe(0);
  }));
  it('new incarnation cannot adopt restored OPEN; quarantine admission must use an empty endpoint', () => isolated(async f => {
    const old = await open(f);
    const fresh = success(await f.service.allocateIncarnation(f.ack));
    expect(fresh.incarnation === old.incarnation).toBe(false);
    expect(fresh.epoch).toBe(old.epoch);
    expect((await f.second.reconcile()).code).toBe('DURABLE_REDIS_DISAGREEMENT');
    // Test-only physical reset, representing the acknowledged quarantined endpoint.
    await f.redis.del(RESERVATION_FENCE_KEY, MUTATION_HISTORY_KEY);
    expect(success(await f.second.reconcile()).phase).toBe('FROZEN');
  }));
  it.each(['older', 'newer'])('Redis %s than durable authority fails closed', direction => isolated(async f => {
    const current = await open(f);
    await f.redis.set(RESERVATION_FENCE_KEY, JSON.stringify({ ...current, revision: current.revision + (direction === 'older' ? -1 : 1) }));
    expect((await f.second.reconcile()).code).toBe('DURABLE_REDIS_DISAGREEMENT');
    expect((await f.capabilities.bind(await operation(f), f.customerId, current.epoch)).code).toBe('DURABLE_REDIS_DISAGREEMENT');
  }));
  it('mode revision disagreement fails closed even with identical mode text', () => isolated(async f => {
    const current = await open(f);
    await f.prisma.reservationEngineModeConfig.create({ data: { mode: f.mode, updatedById: f.customerId } });
    expect((await f.service.prepare(current, 'FROZEN', f.ack.actorId)).code).toBe('DURABLE_REDIS_DISAGREEMENT');
    expect((await f.second.reconcile()).code).toBe('DURABLE_REDIS_DISAGREEMENT');
  }));
  it('concurrent durable prepare has one authoritative winner', () => isolated(async f => {
    const current = await open(f);
    const results = await Promise.all([f.service.prepare(current, 'FROZEN', f.ack.actorId), f.second.prepare(current, 'DRAINING', f.ack.actorId)]);
    expect(results.map(r => r.code).sort()).toEqual(['ACCEPTED', 'PREDECESSOR_MISMATCH']);
  }));
  it('freeze abort uses a new R, and final retirement cannot bypass the future certificate', () => isolated(async f => {
    const frozen = await bootstrap(f);
    const draining = success(await f.service.prepare(frozen, 'DRAINING', f.ack.actorId));
    expect(draining.revision).toBeGreaterThan(frozen.revision);
    await f.service.reconcile();
    const next = success(await f.service.prepare(draining, 'FROZEN', f.ack.actorId));
    await f.service.reconcile();
    expect((await f.service.prepare(next, 'FROZEN', f.ack.actorId, 'LEGACY')).code).toBe('FUTURE_CERTIFICATE_REQUIRED');
    expect((await f.service.prepare(next, 'RETIRED', f.ack.actorId)).code).toBe('FUTURE_CERTIFICATE_REQUIRED');
  }, 'DRAINING'));
  it('LEGACY never opens or treats bootstrap as a drain certificate', () => isolated(async f => {
    const frozen = await bootstrap(f);
    expect((await f.service.prepare(frozen, 'OPEN', f.ack.actorId)).code).toBe('ILLEGAL_PHASE_TRANSITION');
    expect((await f.service.prepare(frozen, 'RETIRED', f.ack.actorId)).code).toBe('FUTURE_CERTIFICATE_REQUIRED');
  }, 'LEGACY'));
  it('operation binding is assign-once; concurrent clients converge without upgrading', () => isolated(async f => {
    const current = await open(f);
    const id = await operation(f);
    const results = await Promise.all([f.capabilities.bind(id, f.customerId, current.epoch), f.secondCapabilities.bind(id, f.customerId, current.epoch)]);
    expect(results.map(r => r.code)).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect((await f.secondCapabilities.bind(id, f.customerId, current.epoch + 1)).code).toBe('EPOCH_MISMATCH');
    const row = await f.prisma.checkoutOperation.findUniqueOrThrow({ where: { id } });
    expect([row.selectedPath, row.reservationExecutionEpoch, row.reservationCapabilityState]).toEqual(['CART_SCOPED', current.epoch, 'ACTIVE']);
  }));
  it('database rejects epoch upgrade, clearing, provenance change and capability reactivation', () => isolated(async f => {
    const current = await open(f);
    const id = await operation(f);
    await f.capabilities.bind(id, f.customerId, current.epoch);
    expect((await f.mutations.initializeExecutionGate(id, f.customerId)).code).toBe('ACCEPTED');
    await expect(f.prisma.checkoutOperation.update({ where: { id }, data: { reservationExecutionEpoch: current.epoch + 1 } })).rejects.toBeDefined();
    await expect(f.prisma.checkoutOperation.update({ where: { id }, data: { reservationExecutionEpoch: null, reservationCapabilityState: null } })).rejects.toBeDefined();
    await expect(f.prisma.checkoutOperation.update({ where: { id }, data: { selectedPath: 'LEGACY' } })).rejects.toBeDefined();
    expect((await f.capabilities.revoke(id, f.customerId)).code).toBe('ACCEPTED');
    expect((await f.secondCapabilities.revoke(id, f.customerId)).code).toBe('ACCEPTED');
    expect((await f.capabilities.bind(id, f.customerId, current.epoch)).code).toBe('CAPABILITY_REVOKED');
    await expect(f.prisma.checkoutOperation.update({ where: { id }, data: { reservationCapabilityState: 'ACTIVE' } })).rejects.toBeDefined();
  }));
  it('exact inheritance and retry return one attempt; revocation blocks new issuance', () => isolated(async f => {
    const current = await open(f);
    const id = await operation(f);
    await f.capabilities.bind(id, f.customerId, current.epoch);
    expect((await f.mutations.initializeExecutionGate(id, f.customerId)).code).toBe('ACCEPTED');
    expect((await f.capabilities.createAttempt(id, f.customerId, current.epoch + 1)).code).toBe('EPOCH_MISMATCH');
    const results = await Promise.all([f.capabilities.createAttempt(id, f.customerId, current.epoch), f.secondCapabilities.createAttempt(id, f.customerId, current.epoch)]);
    expect(success(results[0]).id === success(results[1]).id).toBe(true);
    const attemptId = success(results[0]).id;
    await f.capabilities.revoke(id, f.customerId);
    expect((await f.capabilities.createAttempt(id, f.customerId, current.epoch)).code).toBe('CAPABILITY_REVOKED');
    // Revocation is admission control, not a ban on terminal attempt updates.
    await f.prisma.checkoutAttempt.update({ where: { id: attemptId }, data: { status: 'FAILED' } });
    await expect(f.prisma.checkoutAttempt.update({ where: { id: attemptId }, data: { reservationExecutionEpoch: current.epoch + 1 } })).rejects.toBeDefined();
    expect(await f.prisma.order.count({ where: { customerId: f.customerId } })).toBe(0);
  }));
  it('database rejects missing/mismatched/revoked inheritance through bypass callers', () => isolated(async f => {
    const current = await open(f);
    const id = await operation(f);
    await f.capabilities.bind(id, f.customerId, current.epoch);
    expect((await f.mutations.initializeExecutionGate(id, f.customerId)).code).toBe('ACCEPTED');
    const op = await f.prisma.checkoutOperation.findUniqueOrThrow({ where: { id } });
    const data = { customerId: f.customerId, cartId: f.cartId, selectedPath: 'CART_SCOPED' as const, idempotencyKey: op.operationKey };
    await expect(f.prisma.checkoutAttempt.create({ data })).rejects.toBeDefined();
    await expect(f.prisma.checkoutAttempt.create({ data: { ...data, reservationExecutionEpoch: current.epoch + 1 } })).rejects.toBeDefined();
    await f.capabilities.revoke(id, f.customerId);
    await expect(f.prisma.checkoutAttempt.create({ data: { ...data, reservationExecutionEpoch: current.epoch } })).rejects.toBeDefined();
  }));
  it.each(['LEGACY', 'CART_SCOPED'] as const)('historical %s NULL epoch is never guessed', path => isolated(async f => {
    const current = await open(f);
    const id = await operation(f, path);
    expect((await f.capabilities.bind(id, f.customerId, current.epoch)).code).toBe('UNKNOWN_CAPABILITY');
    expect((await f.capabilities.createAttempt(id, f.customerId, current.epoch)).code).toBe('UNKNOWN_CAPABILITY');
    expect((await f.prisma.checkoutOperation.findUniqueOrThrow({ where: { id } })).reservationExecutionEpoch).toBeNull();
    await expect(f.prisma.checkoutOperation.update({ where: { id }, data: { selectedPath: 'CART_SCOPED', reservationExecutionEpoch: current.epoch, reservationCapabilityState: 'ACTIVE' } })).rejects.toBeDefined();
  }));
});
