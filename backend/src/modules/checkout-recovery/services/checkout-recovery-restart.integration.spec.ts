import { CheckoutRecoverySettlementRepository } from '../repositories/checkout-recovery-settlement.repository';
import { CheckoutRecoveryAcquisitionEvidenceService } from './checkout-recovery-acquisition-evidence.service';
import { CheckoutStaleSettlementService } from './checkout-stale-settlement.service';
import { ReservationFenceRepository } from '../../reservation-fence/repositories/reservation-fence.repository';
import { CheckoutSettlementRepository } from '../../reservation-fence/repositories/checkout-settlement.repository';
import { CheckoutSettlementAuthorityService } from '../../reservation-fence/services/checkout-settlement-authority.service';
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { CheckoutAttemptService } from '../../checkout-attempt/services/checkout-attempt.service';
import { CheckoutAttemptStaleFencingService } from '../../checkout-attempt/services/checkout-attempt-stale-fencing.service';
import { CheckoutReservationStateService } from '../../inventory/services/checkout-reservation-state.service';
import {
  connectRealRedis,
  cleanupKeys,
  trackKeysFor,
  seedHistoricalActiveReservation,
} from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { reservationKey, productTotalKey } from '../../inventory/constants/inventory.constants';
import { CheckoutRecoveryWorkerService } from './checkout-recovery-worker.service';
import { CheckoutRecoveryTelemetryService } from './checkout-recovery-telemetry.service';
import { CheckoutRolloutParticipantsRepository } from '../../checkout-rollout/repositories/checkout-rollout-participants.repository';
import { CheckoutRolloutParticipantsService } from '../../checkout-rollout/services/checkout-rollout-participants.service';

describe('Historical G.PR1 attempts lack explicit stale settlement authority (Postgres and Redis)', () => {
  const prisma = new PrismaService();
  const live = new PrismaService();
  const repo = new CheckoutAttemptRepository(prisma);
  const attempts = new CheckoutAttemptService(repo);
  const fence = new CheckoutAttemptStaleFencingService(repo);
  const keys = new Set<string>();
  let redis: Redis;
  let recovery: CheckoutStaleSettlementService;
  let settlements: CheckoutRecoverySettlementRepository;
  let customerId: string;
  let cartId: string;
  const lease = { assertHeld: () => Promise.resolve() };
  const h1 = new Date(Date.now() - 600000);
  const worker = () =>
    new CheckoutRecoveryWorkerService(
      attempts,
      settlements,
      recovery,
      new CheckoutRecoveryTelemetryService(),
    );
  beforeAll(async () => {
    if (process.env.REDIS_URL !== 'redis://127.0.0.1:16479/11') throw new Error('Exact disposable Redis required');
    await Promise.all([prisma.$connect(), live.$connect()]);
    redis = await connectRealRedis();
    const adapter = new RedisService(redis), fences = new ReservationFenceRepository(prisma);
    const manifests = new CheckoutSettlementRepository(prisma, fences);
    settlements = new CheckoutRecoverySettlementRepository(prisma, fences, manifests, new CheckoutRecoveryAcquisitionEvidenceService(adapter));
    recovery = new CheckoutStaleSettlementService(settlements, new CheckoutSettlementAuthorityService(manifests, fences, adapter), adapter);
    customerId = (
      await prisma.user.create({
        data: {
          email: `pr1-${randomUUID()}@example.invalid`,
          passwordHash: 'fixture',
          firstName: 'Test',
          lastName: 'Fixture',
        },
      })
    ).id;
    cartId = (await prisma.cart.create({ data: { customerId } })).id;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.checkoutAttempt.deleteMany({ where: { customerId } });
    await prisma.checkoutRolloutParticipant.deleteMany({ where: { customerId } });
    await cleanupKeys(redis, keys);
    keys.clear();
  });
  afterAll(async () => {
    try {
      const retainedOrders = await prisma.order.count({ where: { customerId } });
      if (retainedOrders === 0) {
        await prisma.user.delete({ where: { id: customerId } });
      }
    } finally {
      if (redis && redis.status !== 'end') await redis.quit();
      await Promise.all([prisma.$disconnect(), live.$disconnect()]);
    }
  });
  async function create() {
    return (
      await repo.createOrGetByIdempotencyKey({
        customerId,
        cartId,
        selectedPath: 'CART_SCOPED',
        idempotencyKey: randomUUID(),
        now: h1,
      })
    ).attempt;
  }
  it('does not interpret a historical FAILED fence as a settlement obligation; repeated workers preserve totals and ownership', async () => {
    const attempt = await create();
    const productId = randomUUID();
    trackKeysFor(keys, cartId, productId);
    const service = new RedisService(redis);
    await seedHistoricalActiveReservation(
      redis,
      cartId,
      productId,
      customerId,
      2,
    );
    expect(
      await new CheckoutReservationStateService(service).checkoutMark(
        cartId,
        customerId,
        attempt.idempotencyKey,
        [{ productId, expectedQuantity: 2 }],
        Date.now(),
        180,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await fence.fence({
        attemptId: attempt.id,
        customerId,
        selectedPath: 'CART_SCOPED',
        observedHeartbeatAt: h1,
        staleBefore: new Date(Date.now() - 180000),
        now: new Date(),
      }),
    ).toEqual({ ok: true, outcome: 'FENCED' });
    // The original process stops here, without calling Redis cleanup.
    const before = await Promise.all([
      prisma.order.count(),
      prisma.payment.count(),
      prisma.checkoutAttempt.count(),
    ]);
    await worker().runCycle(lease);
    const restored = await redis.get(reservationKey(cartId, productId));
    expect(JSON.parse(restored!)).toMatchObject({ status: 'CHECKOUT_PENDING', quantity: 2 });
    expect(await redis.get(productTotalKey(productId))).toBe('2');
    await worker().runCycle(lease);
    expect(await redis.get(reservationKey(cartId, productId))).toBe(restored);
    expect(await redis.get(productTotalKey(productId))).toBe('2');
    expect(await repo.findById(attempt.id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'STALE_RECOVERY_FENCED',
      selectedPath: 'CART_SCOPED',
      lastHeartbeatAt: h1,
    });
    expect(
      await Promise.all([
        prisma.order.count(),
        prisma.payment.count(),
        prisma.checkoutAttempt.count(),
      ]),
    ).toEqual(before);
  });
  it('a concurrent H2 heartbeat prevents cleanup of the discovered H1 candidate', async () => {
    const attempt = await create();
    const read = attempts.findStalePage.bind(attempts);
    jest.spyOn(attempts, 'findStalePage').mockImplementation(async (input) => {
      const page = await read(input);
      await new CheckoutAttemptRepository(live).updateHeartbeatIfProcessing(
        attempt.id,
        customerId,
        new Date(),
      );
      return page;
    });
    const cleanup = jest.spyOn(recovery, 'continueStaleRecoverySettlement');
    await worker().runCycle(lease);
    expect(cleanup).not.toHaveBeenCalled();
    expect(await repo.findById(attempt.id)).toMatchObject({
      status: 'PROCESSING',
      selectedPath: 'CART_SCOPED',
    });
  });
  it('a concurrent commit rejects stale cleanup and preserves the order and PAID payment', async () => {
    const attempt = await create();
    let orderId = '';
    let committedOrder: unknown;
    const read = attempts.findStalePage.bind(attempts);
    jest.spyOn(attempts, 'findStalePage').mockImplementation(async (input) => {
      const page = await read(input);
      await live.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            customerId,
            deliveryAddressLine1: 'Fixture',
            deliveryParish: 'KINGSTON',
            deliveryPhone: 'fixture',
          },
        });
        orderId = order.id;
        expect(
          await new CheckoutAttemptRepository(live).markCommitted(
            tx,
            attempt.id,
            customerId,
            order.id,
            new Date(),
          ),
        ).toEqual({ count: 1 });
        await tx.payment.create({
          data: { orderId, provider: 'CASH_ON_DELIVERY', status: 'PAID', amount: 42 },
        });
      });
      committedOrder = await live.order.findUnique({
        where: { id: orderId },
        include: { payment: true },
      });
      return page;
    });
    const cleanup = jest.spyOn(recovery, 'continueStaleRecoverySettlement');
    await worker().runCycle(lease);
    expect(cleanup).not.toHaveBeenCalled();
    expect(await repo.findById(attempt.id)).toMatchObject({
      status: 'COMMITTED',
      selectedPath: 'CART_SCOPED',
      orderId,
    });
    expect(
      await prisma.order.findUnique({ where: { id: orderId }, include: { payment: true } }),
    ).toEqual(committedOrder);
  });
  it('participant disable, revision changes and lookup failure cannot reroute recovery', async () => {
    const participants = new CheckoutRolloutParticipantsRepository(prisma);
    const administration = new CheckoutRolloutParticipantsService(participants);
    await administration.setParticipation(customerId, customerId, {
      enabled: true,
      cohort: 'pilot',
      reason: 'fixture',
      expectedRevision: null,
    });
    const attempt = await create();
    await administration.setParticipation(customerId, customerId, {
      enabled: false,
      cohort: 'changed',
      reason: 'fixture disable',
      expectedRevision: 1,
    });
    const lookup = jest
      .spyOn(CheckoutRolloutParticipantsRepository.prototype, 'findCurrent')
      .mockRejectedValue(new Error('lookup unavailable'));
    const cleanup = jest.spyOn(recovery, 'continueStaleRecoverySettlement');
    await worker().runCycle(lease);
    expect(lookup).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(await repo.findById(attempt.id)).toMatchObject({
      status: 'PROCESSING',
      selectedPath: 'CART_SCOPED',
      failureCode: null,
    });
  });
  it('never cleans historical expired inventory without explicit manifest authority', async () => {
    const attempt = await create();
    const productId = randomUUID();
    trackKeysFor(keys, cartId, productId);
    const service = new RedisService(redis);
    await seedHistoricalActiveReservation(
      redis,
      cartId,
      productId,
      customerId,
      2,
    );
    expect(
      await new CheckoutReservationStateService(service).checkoutMark(
        cartId,
        customerId,
        attempt.idempotencyKey,
        [{ productId, expectedQuantity: 2 }],
        Date.now(),
        180,
      ),
    ).toMatchObject({ ok: true });
    // Fixture expiry while preserving the pending key, as occurs under its lease.
    const entry = JSON.parse((await redis.get(reservationKey(cartId, productId)))!) as Record<
      string,
      unknown
    >;
    entry.expiresAt = Date.now() - 1;
    await redis.set(reservationKey(cartId, productId), JSON.stringify(entry));
    jest
      .spyOn(recovery, 'continueStaleRecoverySettlement')
      .mockRejectedValueOnce(new Error('simulated Redis outage'));
    const running = worker();
    await running.runCycle(lease);
    expect(await repo.findById(attempt.id)).toMatchObject({
      status: 'PROCESSING',
      failureCode: null,
    });
    expect(await redis.get(productTotalKey(productId))).toBe('2');
    await running.runCycle(lease);
    expect(await redis.get(reservationKey(cartId, productId))).toBe(JSON.stringify(entry));
    expect(await redis.get(productTotalKey(productId))).toBe('2');
    await running.runCycle(lease);
    expect(await redis.get(productTotalKey(productId))).toBe('2');
  });
  it('cleanup paging excludes unrelated failures and advances tied heartbeat IDs without duplication', async () => {
    const rows = await Promise.all([create(), create(), create()]);
    await prisma.checkoutAttempt.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { status: 'FAILED', failureCode: 'STALE_RECOVERY_FENCED' },
    });
    const unrelated = await create();
    await prisma.checkoutAttempt.update({
      where: { id: unrelated.id },
      data: { status: 'FAILED', failureCode: 'OTHER_FAILURE' },
    });
    expect(await settlements.findPendingStaleSettlementsPage({ afterManifestId: null, limit: 100 })).toEqual([]);
    const first = await repo.findFencedCleanupPage({ cursor: null, limit: 2 });
    expect(first).toHaveLength(2);
    const second = await repo.findFencedCleanupPage({
      cursor: { id: first[1]!.id, lastHeartbeatAt: first[1]!.lastHeartbeatAt },
      limit: 2,
    });
    expect(second).toHaveLength(1);
    expect([...first, ...second].map((row) => row.id).sort()).toEqual(
      rows.map((row) => row.id).sort(),
    );
    expect(() => repo.findFencedCleanupPage({ cursor: null, limit: 201 })).toThrow();
  });
});
