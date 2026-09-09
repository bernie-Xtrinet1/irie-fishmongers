import { randomUUID } from 'crypto';
import { PrismaService } from '../../../database/prisma.service';
import { CheckoutDispatchService } from './checkout-dispatch.service';
import { AtomicCheckoutAdmissionService } from './atomic-checkout-admission.service';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { RolloutControlsRepository } from '../../checkout-rollout-admin/repositories/rollout-controls.repository';
import { CheckoutOperationRepository } from '../../checkout-operation/repositories/checkout-operation.repository';
import { CheckoutOperationService } from '../../checkout-operation/services/checkout-operation.service';
import { PriceLockRepository } from '../../price-lock/repositories/price-lock.repository';
import { PRICE_LOCK_TTL_SECONDS } from '../../price-lock/constants/price-lock.constants';
import { CheckoutShadowComparisonService } from '../../checkout-shadow/services/checkout-shadow-comparison.service';
import { CheckoutRolloutParticipantsRepository } from '../../checkout-rollout/repositories/checkout-rollout-participants.repository';
import { CheckoutRolloutParticipantsService } from '../../checkout-rollout/services/checkout-rollout-participants.service';
import {
  connectRealRedis,
  cleanupKeys,
  trackKeysFor,
} from '../../inventory/services/inventory-reservations.redis-test-helpers';
import {
  buildRealCoordinator,
  checkoutDto,
  seedReadyCheckout,
  setUpCheckoutIntegrationFixture,
  tearDownCheckoutIntegrationFixture,
  CheckoutIntegrationFixture,
  RealCoordinatorHandles,
} from '../../checkout/services/checkout-coordinator-integration-test-helpers';

describe('G.2b dispatch through the real coordinator (Postgres and Redis)', () => {
  const prisma = new PrismaService();
  let redis: Awaited<ReturnType<typeof connectRealRedis>>;
  let fixture: CheckoutIntegrationFixture;
  let handles: RealCoordinatorHandles;
  let operations: CheckoutOperationService;
  let dispatcher: CheckoutDispatchService;
  const keys = new Set<string>();
  let admission: AtomicCheckoutAdmissionService;
  const controls = new RolloutControlsRepository(prisma);
  const shadow = { compare: jest.fn() };
  beforeAll(async () => {
    await prisma.$connect();
    redis = await connectRealRedis();
    fixture = await setUpCheckoutIntegrationFixture(prisma);
  });
  beforeEach(async () => {
    if (await controls.findCurrent()) throw new Error('Requires isolated global rollout controls');
    await controls.appendIfCurrent(fixture.userIds[0]!, {
      expectedRevision: null,
      newAdmissionStopped: false,
      behavior: 'CART_SCOPED',
      eligibleCohort: null,
      reason: 'Integration admission',
    });
    handles = buildRealCoordinator(prisma, redis);
    operations = new CheckoutOperationService(
      new CheckoutOperationRepository(prisma),
      handles.cartRepository,
      new PriceLockRepository(prisma),
      handles.priceLockService,
    );
    admission = new AtomicCheckoutAdmissionService(
      prisma,
      new CheckoutOperationRepository(prisma),
      new CheckoutAttemptRepository(prisma),
      controls,
      new CheckoutRolloutParticipantsRepository(prisma),
    );
    dispatcher = new CheckoutDispatchService(
      operations,
      handles.checkoutAttemptService,
      handles.coordinator,
      handles.ordersService,
      admission,
      shadow as unknown as CheckoutShadowComparisonService,
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.checkoutRolloutControlRevision.deleteMany({
      where: { actorId: fixture.userIds[0]! },
    });
  });
  afterAll(async () => {
    await prisma.checkoutOperation.deleteMany({ where: { customerId: { in: fixture.userIds } } });
    await prisma.checkoutRolloutParticipant.deleteMany({
      where: { customerId: { in: fixture.userIds } },
    });
    await tearDownCheckoutIntegrationFixture(fixture);
    await cleanupKeys(redis, keys);
    await redis.quit();
    await prisma.$disconnect();
  });
  async function scenario() {
    const ready = await seedReadyCheckout(fixture, handles);
    await new CheckoutRolloutParticipantsService(
      new CheckoutRolloutParticipantsRepository(prisma),
    ).setParticipation(ready.customerId, ready.customerId, {
      enabled: true,
      cohort: 'pilot',
      reason: 'Integration participant',
      expectedRevision: null,
    });
    trackKeysFor(keys, ready.cartId, ready.productId);
    return { ...ready, retryKey: randomUUID(), dto: checkoutDto, now: new Date() };
  }
  it('issues/prepares/executes once, then replays COMMITTED after cart clearing and participant disable/lookup failure', async () => {
    const ready = await scenario();
    const input = {
      customerId: ready.customerId,
      cartId: ready.cartId,
      retryKey: ready.retryKey,
      dto: ready.dto,
      now: ready.now,
    };
    const pay = jest.spyOn(handles.paymentsService, 'initiatePayment');
    const first = await dispatcher.checkout(input);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('First checkout failed');
    const operation = await prisma.checkoutOperation.findFirstOrThrow({
      where: { customerId: ready.customerId },
    });
    expect(operation.selectedPath).toBe('CART_SCOPED');
    expect(operation.priceLockFingerprint).not.toBeNull();
    expect(
      await prisma.checkoutAttempt.findUnique({
        where: { idempotencyKey: operation.operationKey },
      }),
    ).toMatchObject({ status: 'COMMITTED', selectedPath: 'CART_SCOPED', orderId: first.order.id });
    expect(await prisma.cartItem.count({ where: { cartId: ready.cartId } })).toBe(0);
    const administration = new CheckoutRolloutParticipantsService(
      new CheckoutRolloutParticipantsRepository(prisma),
    );
    await administration.setParticipation(ready.customerId, ready.customerId, {
      enabled: false,
      cohort: 'changed',
      reason: 'fixture disable',
      expectedRevision: 1,
    });
    await controls.appendIfCurrent(fixture.userIds[0]!, {
      expectedRevision: 1,
      newAdmissionStopped: true,
      behavior: 'DENY',
      eligibleCohort: null,
      reason: 'Stop after commit',
    });
    const admit = jest.spyOn(admission, 'admit').mockRejectedValue(new Error('lookup unavailable'));
    const prepare = jest
      .spyOn(operations, 'prepare')
      .mockRejectedValue(new Error('cleared cart must not be prepared'));
    const execute = jest.spyOn(handles.coordinator, 'checkout');
    expect(await dispatcher.checkout(input)).toEqual({ ok: true, order: first.order });
    expect(admit).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await prisma.checkoutOperation.count({ where: { customerId: ready.customerId } })).toBe(
      1,
    );
    expect(await prisma.checkoutAttempt.count({ where: { customerId: ready.customerId } })).toBe(1);
    expect(await prisma.order.count({ where: { customerId: ready.customerId } })).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: first.order.id } })).toBe(1);
    expect(pay).toHaveBeenCalledTimes(1);
  });
  it.each(['expiry', 'quantity'] as const)(
    'bound %s changes require reconfirmation before coordinator execution',
    async (change) => {
      const ready = await scenario();
      const issued = await operations.issue({
        customerId: ready.customerId,
        cartId: ready.cartId,
        retryKey: ready.retryKey,
      });
      if (!issued.ok) throw new Error('Issue failed');
      await operations.assignPath(ready.customerId, issued.operation.id, 'CART_SCOPED');
      const bound = await operations.prepare(ready.customerId, issued.operation.id, ready.now);
      expect(bound.ok).toBe(true);
      if (change === 'quantity') {
        const item = await handles.cartRepository.findItemByCartAndProduct(
          ready.cartId,
          ready.productId,
        );
        await handles.cartRepository.updateItemQuantity(item!.id, 3);
      }
      const before = await prisma.cartItem.findMany({ where: { cartId: ready.cartId } });
      const execute = jest.spyOn(handles.coordinator, 'checkout');
      expect(
        await dispatcher.checkout({
          customerId: ready.customerId,
          cartId: ready.cartId,
          retryKey: ready.retryKey,
          dto: ready.dto,
          now:
            change === 'expiry'
              ? new Date(ready.now.getTime() + PRICE_LOCK_TTL_SECONDS * 1000)
              : ready.now,
        }),
      ).toEqual({ ok: false, code: 'RECONFIRM_REQUIRED' });
      expect(execute).not.toHaveBeenCalled();
      expect(await prisma.cartItem.findMany({ where: { cartId: ready.cartId } })).toEqual(before);
      expect(await prisma.checkoutAttempt.count({ where: { customerId: ready.customerId } })).toBe(
        0,
      );
    },
  );
});
