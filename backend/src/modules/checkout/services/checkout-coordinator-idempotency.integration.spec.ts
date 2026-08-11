import { randomUUID } from 'crypto';

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

// Phase 16A.0-D, Unit D.3 (resumed after the D.2.1 correction). Proves the
// exact defect this correction was built to close: a same-key retry after
// a checkout has already committed must return the existing order, never
// PREPARE_FAILED/CART_EMPTY. Also proves the concurrent-same-key race.
// Dedicated Redis index (not 1/2/3/4 - see the sibling integration specs'
// own comments for why each of those is already claimed) since this suite
// also exercises real Redis via buildRealCoordinator.
jest.setTimeout(30_000);

const ISOLATED_DB_INDEX = 5;

describe('CheckoutCoordinatorService idempotency (real Postgres + Redis)', () => {
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

  it('1. a same-key retry after COMMITTED returns the existing order - the defect D.2.1 fixes', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);
    const idempotencyKey = randomUUID();

    const first = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Confirm the cart really is empty now - this is exactly the state
    // that made the bug possible (prepareCheckout would have hit
    // CART_EMPTY before this correction).
    const cartItems = await prisma.cartItem.findMany({ where: { cartId: scenario.cartId } });
    expect(cartItems).toHaveLength(0);

    const second = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());

    expect(second).toEqual({ ok: true, order: first.order });

    const orders = await prisma.order.findMany({ where: { customerId: scenario.customerId } });
    expect(orders).toHaveLength(1);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: scenario.productId } });
    expect(product.quantityAvailable).toBe(50 - scenario.quantity); // decremented exactly once

    const events = await prisma.inventoryEvent.findMany({ where: { productId: scenario.productId } });
    expect(events).toHaveLength(1); // no second DECREMENTED event

    const payments = await prisma.payment.findMany({ where: { orderId: first.order.id } });
    expect(payments).toHaveLength(1); // initiatePayment was never retried
  });

  it('2. two concurrent calls with the same idempotency key produce exactly one order', async () => {
    const scenario = await seedReadyCheckout(fixture, handles, { quantity: 2 });
    const idempotencyKey = randomUUID();

    const [resultA, resultB] = await Promise.all([
      handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date()),
      handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date()),
    ]);

    // Exactly one durable order must exist regardless of which shape each
    // individual response took (a genuine race may have one caller
    // observe PROCESSING and return CHECKOUT_ALREADY_IN_PROGRESS rather
    // than the final committed order - that is an accepted, shipped
    // contract outcome, not weakened here).
    const orders = await prisma.order.findMany({ where: { customerId: scenario.customerId } });
    expect(orders).toHaveLength(1);

    const product = await prisma.product.findUniqueOrThrow({ where: { id: scenario.productId } });
    expect(product.quantityAvailable).toBe(50 - scenario.quantity);

    // Exactly one CheckoutAttempt row exists for this key, durably owned by
    // the requesting customer and COMMITTED - createOrResume's unique
    // constraint guarantees this regardless of which loser shape occurred.
    const attempts = await prisma.checkoutAttempt.findMany({ where: { idempotencyKey } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('COMMITTED');
    expect(attempts[0]?.customerId).toBe(scenario.customerId);

    // Everything before createOrResume's own unique-constraint claim
    // (prepareCheckout, price-lock validation, plan reconciliation) is
    // deliberately NOT synchronized across concurrent racers - only
    // createOrResume is the correctness boundary (see the D.2.1 "race
    // semantics" note). A losing concurrent call may observe a typed
    // pre-attempt outcome depending on exactly how far the winner had
    // progressed when the loser's own reads ran (e.g. the winner already
    // cleared the cart or consumed the price lock's relevant state by the
    // time the loser reads it). IDEMPOTENCY_KEY_CONFLICT and
    // CHECKOUT_ALREADY_FAILED are deliberately EXCLUDED here: both would
    // be inconsistent with the durable state just asserted above (a single
    // COMMITTED attempt owned by this same customer for this same key) -
    // if either were ever observed it would indicate a genuine production
    // defect, not an accepted race shape, so this test intentionally does
    // not tolerate them.
    const acceptableLoserCodes = [
      'CHECKOUT_ALREADY_IN_PROGRESS',
      'PRICE_LOCK_INVALID',
      'PREPARE_FAILED',
      'CHECKOUT_PLAN_MISMATCH',
    ];
    const outcomes = [resultA, resultB].map((r) => (r.ok ? 'SUCCESS' : r.code));
    const successCount = outcomes.filter((o) => o === 'SUCCESS').length;
    expect(successCount).toBeGreaterThanOrEqual(1);
    for (const outcome of outcomes) {
      expect(outcome).not.toBe('IDEMPOTENCY_KEY_CONFLICT');
      expect(outcome).not.toBe('CHECKOUT_ALREADY_FAILED');
      if (outcome !== 'SUCCESS') {
        expect(acceptableLoserCodes).toContain(outcome);
      }
    }
  });

  it('2b. a later same-key retry after the concurrent race resolves replays the committed order', async () => {
    const scenario = await seedReadyCheckout(fixture, handles, { quantity: 2 });
    const idempotencyKey = randomUUID();

    await Promise.all([
      handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date()),
      handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date()),
    ]);

    const committedOrder = await prisma.order.findFirstOrThrow({ where: { customerId: scenario.customerId } });
    const productBeforeRetry = await prisma.product.findUniqueOrThrow({ where: { id: scenario.productId } });
    const paymentsBeforeRetry = await prisma.payment.findMany({ where: { orderId: committedOrder.id } });

    const retry = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());

    expect(retry).toMatchObject({ ok: true, order: { id: committedOrder.id } });
    const orders = await prisma.order.findMany({ where: { customerId: scenario.customerId } });
    expect(orders).toHaveLength(1); // still exactly one order after the retry

    const productAfterRetry = await prisma.product.findUniqueOrThrow({ where: { id: scenario.productId } });
    expect(productAfterRetry.quantityAvailable).toBe(productBeforeRetry.quantityAvailable); // no second decrement

    const paymentsAfterRetry = await prisma.payment.findMany({ where: { orderId: committedOrder.id } });
    expect(paymentsAfterRetry).toHaveLength(paymentsBeforeRetry.length); // no second payment initiation
  });

  it('3. two concurrent calls with different idempotency keys for the same cart: only one durable order, no double stock decrement', async () => {
    const scenario = await seedReadyCheckout(fixture, handles, { quantity: 2 });
    const keyA = randomUUID();
    const keyB = randomUUID();

    const [resultA, resultB] = await Promise.all([
      handles.coordinator.checkout(scenario.customerId, keyA, checkoutDto, new Date()),
      handles.coordinator.checkout(scenario.customerId, keyB, checkoutDto, new Date()),
    ]);

    const orders = await prisma.order.findMany({ where: { customerId: scenario.customerId } });
    expect(orders.length).toBeLessThanOrEqual(1);

    const product = await prisma.product.findUniqueOrThrow({ where: { id: scenario.productId } });
    // Stock is never decremented more than once for the same reservation,
    // regardless of which key(s) succeeded.
    expect(product.quantityAvailable).toBeGreaterThanOrEqual(50 - scenario.quantity);

    const successCount = [resultA, resultB].filter((r) => r.ok).length;
    expect(successCount).toBeLessThanOrEqual(1);
  });
});
