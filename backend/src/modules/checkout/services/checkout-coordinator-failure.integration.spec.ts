import { randomUUID } from 'crypto';

import { OrderPlacedEvent } from '../../../common/events/order-placed.event';
import { PrismaService } from '../../../database/prisma.service';
import { connectRealRedis } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import {
  CheckoutIntegrationFixture,
  RealCoordinatorHandles,
  buildRealCoordinator,
  checkoutDto,
  seedReadyCheckout,
  setUpCheckoutIntegrationFixture,
  tearDownCheckoutIntegrationFixture,
} from './checkout-coordinator-integration-test-helpers';

// Phase 16A.0-D, Unit D.3 (resumed). Remaining failure-window and
// OrderPlacedEvent-emission matrix items not already covered by the
// Postgres/Redis/idempotency integration suites. Dedicated Redis index -
// see the sibling integration specs' own comments for why 1-5 are already
// claimed; this suite also exercises real Redis via buildRealCoordinator.
jest.setTimeout(30_000);

const ISOLATED_DB_INDEX = 6;

describe('CheckoutCoordinatorService failure windows / event emission (real Postgres + Redis)', () => {
  let redisClient: Awaited<ReturnType<typeof connectRealRedis>>;
  let prisma: PrismaService;
  let fixture: CheckoutIntegrationFixture;
  let handles: RealCoordinatorHandles;

  beforeAll(async () => {
    redisClient = await connectRealRedis();
    await redisClient.select(ISOLATED_DB_INDEX);
    prisma = new PrismaService();
    await prisma.onModuleInit();
    fixture = await setUpCheckoutIntegrationFixture(prisma);
  });

  afterAll(async () => {
    await tearDownCheckoutIntegrationFixture(fixture);
    await prisma.onModuleDestroy();
    await redisClient.flushdb();
    await redisClient.quit();
  });

  beforeEach(async () => {
    await redisClient.flushdb();
    handles = buildRealCoordinator(prisma, redisClient);
  });

  describe('OrderPlacedEvent emission', () => {
    it('emits exactly once for a newly committed checkout', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      const events: OrderPlacedEvent[] = [];
      handles.eventEmitter.on(OrderPlacedEvent.eventName, (event: OrderPlacedEvent) => events.push(event));

      const result = await handles.coordinator.checkout(
        scenario.customerId,
        randomUUID(),
        checkoutDto,
        new Date(),
      );

      expect(result.ok).toBe(true);
      expect(events).toHaveLength(1);
      if (result.ok) {
        expect(events[0]?.orderId).toBe(result.order.id);
      }
    });

    it('is NOT emitted when the durable transaction rolls back', async () => {
      const scenario = await seedReadyCheckout(fixture, handles, { quantity: 5 });
      await prisma.product.update({ where: { id: scenario.productId }, data: { quantityAvailable: 1 } });
      const events: OrderPlacedEvent[] = [];
      handles.eventEmitter.on(OrderPlacedEvent.eventName, (event: OrderPlacedEvent) => events.push(event));

      const result = await handles.coordinator.checkout(
        scenario.customerId,
        randomUUID(),
        checkoutDto,
        new Date(),
      );

      expect(result).toMatchObject({ ok: false, code: 'ORDER_TRANSACTION_FAILED' });
      expect(events).toHaveLength(0);
    });

    it('is NOT emitted when checkoutMark fails', async () => {
      const scenario = await seedReadyCheckout(fixture, handles, { quantity: 2 });
      // A quantity mismatch between the canonical plan and the real Redis
      // reservation forces checkoutMark to fail - simulated here by
      // reserving a different quantity than what price-lock/cart agree on.
      await handles.inventoryReservations.reserveOrRenew(
        scenario.cartId,
        scenario.productId,
        scenario.customerId,
        99,
      );
      const events: OrderPlacedEvent[] = [];
      handles.eventEmitter.on(OrderPlacedEvent.eventName, (event: OrderPlacedEvent) => events.push(event));

      const result = await handles.coordinator.checkout(
        scenario.customerId,
        randomUUID(),
        checkoutDto,
        new Date(),
      );

      expect(result).toMatchObject({ ok: false, code: 'CHECKOUT_MARK_FAILED' });
      expect(events).toHaveLength(0);
    });

    it('an ALREADY_COMMITTED replay does not emit the event again', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      const idempotencyKey = randomUUID();
      const first = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());
      expect(first.ok).toBe(true);

      const events: OrderPlacedEvent[] = [];
      handles.eventEmitter.on(OrderPlacedEvent.eventName, (event: OrderPlacedEvent) => events.push(event));

      const second = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());

      expect(second.ok).toBe(true);
      expect(events).toHaveLength(0);
    });
  });

  describe('failure window E - payment initiation throws after durable commit', () => {
    it('returns the committed order with RECONCILE_REQUIRED and same-key replay never reinitiates payment', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      const idempotencyKey = randomUUID();
      const providerSpy = jest
        .spyOn(handles.cashOnDeliveryAdapter, 'createPayment')
        .mockRejectedValueOnce(new Error('simulated payment gateway outage'));

      try {
        const first = await handles.coordinator.checkout(
          scenario.customerId,
          idempotencyKey,
          checkoutDto,
          new Date(),
        );

        expect(first.ok).toBe(true);
        expect(providerSpy).toHaveBeenCalledTimes(1);

        const attempt = await prisma.checkoutAttempt.findUniqueOrThrow({ where: { idempotencyKey } });
        expect(attempt.status).toBe('COMMITTED');

        const order = await prisma.order.findUnique({ where: { id: attempt.orderId ?? '' } });
        expect(order).not.toBeNull();

        const payments = await prisma.payment.findMany({ where: { orderId: attempt.orderId ?? '' } });
        expect(payments).toHaveLength(1);
        expect(payments[0]?.initiationStatus).toBe('RECONCILE_REQUIRED');

        if (first.ok) {
          expect(first.order.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');
          expect(first.order.paymentRedirectUrl).toBeUndefined();
        }

        const retry = await handles.coordinator.checkout(
          scenario.customerId,
          idempotencyKey,
          checkoutDto,
          new Date(),
        );

        expect(retry).toMatchObject({ ok: true });
        expect(providerSpy).toHaveBeenCalledTimes(1);

        if (retry.ok) {
          expect(retry.order.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');
          expect(retry.order.paymentRedirectUrl).toBeUndefined();
        }
      } finally {
        providerSpy.mockRestore();
      }
    });
  });
});
