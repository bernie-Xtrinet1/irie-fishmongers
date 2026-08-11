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

// Phase 16A.0-D, Unit D.3. Proves the Order + CheckoutAttempt COMMITTED
// transaction is genuinely atomic in real Postgres - CheckoutCoordinatorService
// is exercised end-to-end (real Postgres, real Redis, CASH_ON_DELIVERY - no
// external gateway), with production wiring untouched: no CheckoutModule,
// no controller, no AppModule change.
jest.setTimeout(30_000);

const ISOLATED_DB_INDEX = 3;

describe('CheckoutCoordinatorService (real Postgres)', () => {
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

  it('1. persists Order/VendorOrder/OrderItem, decrements stock, clears the cart, writes an inventory event, and commits the attempt - all inside one transaction', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);
    const idempotencyKey = randomUUID();

    const result = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const order = await prisma.order.findUnique({
      where: { id: result.order.id },
      include: { vendorOrders: { include: { items: true } } },
    });
    expect(order).not.toBeNull();
    expect(order?.vendorOrders).toHaveLength(1);
    expect(order?.vendorOrders[0]?.items).toHaveLength(1);

    const product = await prisma.product.findUniqueOrThrow({ where: { id: scenario.productId } });
    expect(product.quantityAvailable).toBe(50 - scenario.quantity);

    const cartItems = await prisma.cartItem.findMany({ where: { cartId: scenario.cartId } });
    expect(cartItems).toHaveLength(0);

    const events = await prisma.inventoryEvent.findMany({ where: { productId: scenario.productId } });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('DECREMENTED');
    expect(events[0]?.quantityDelta).toBe(-scenario.quantity);

    const attempt = await prisma.checkoutAttempt.findUniqueOrThrow({ where: { idempotencyKey } });
    expect(attempt.status).toBe('COMMITTED');
    expect(attempt.orderId).toBe(order?.id);
  });

  it('2. a genuine Postgres stock-race rolls back the whole transaction and ends the attempt FAILED', async () => {
    const scenario = await seedReadyCheckout(fixture, handles, { quantity: 5, price: 500 });
    // Simulate a concurrent legitimate sale draining stock after the
    // reservation/price-lock were established but before this checkout's
    // durable transaction runs - ProductsRepository.adjustStock's own
    // real conditional update (quantityAvailable >= delta) will reject it.
    await prisma.product.update({ where: { id: scenario.productId }, data: { quantityAvailable: 1 } });
    const idempotencyKey = randomUUID();

    const result = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());

    expect(result).toMatchObject({ ok: false, code: 'ORDER_TRANSACTION_FAILED' });

    const orders = await prisma.order.findMany({ where: { customerId: scenario.customerId } });
    expect(orders).toHaveLength(0);
    const events = await prisma.inventoryEvent.findMany({ where: { productId: scenario.productId } });
    expect(events).toHaveLength(0);
    const cartItems = await prisma.cartItem.findMany({ where: { cartId: scenario.cartId } });
    expect(cartItems).toHaveLength(1); // never cleared - the transaction rolled back

    const attempt = await prisma.checkoutAttempt.findUniqueOrThrow({ where: { idempotencyKey } });
    expect(attempt.status).toBe('FAILED');
    expect(attempt.orderId).toBeNull();
    expect(attempt.failureCode).toBe('ORDER_TRANSACTION_FAILED');
  });

  it('3. a non-success markCommittedInTransaction result rolls back the whole transaction - never a partially-created order', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);
    const idempotencyKey = randomUUID();

    // Narrowest documented fault injection: real order creation runs
    // for real inside the transaction; only markCommittedInTransaction's
    // own return value is overridden for this one call, to prove the
    // rollback path without requiring a genuine concurrent race.
    const spy = jest
      .spyOn(handles.checkoutAttemptService, 'markCommittedInTransaction')
      .mockResolvedValueOnce({ ok: false, code: 'NOT_FOUND' });

    const result = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());
    spy.mockRestore();

    expect(result).toMatchObject({ ok: false, code: 'ORDER_TRANSACTION_FAILED' });

    const orders = await prisma.order.findMany({ where: { customerId: scenario.customerId } });
    expect(orders).toHaveLength(0);
    const vendorOrderCount = await prisma.vendorOrder.count({
      where: { order: { customerId: scenario.customerId } },
    });
    expect(vendorOrderCount).toBe(0);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: scenario.productId } });
    expect(product.quantityAvailable).toBe(50); // adjustStock's write rolled back too

    const attempt = await prisma.checkoutAttempt.findUniqueOrThrow({ where: { idempotencyKey } });
    expect(attempt.status).toBe('FAILED');
  });

  it('4. persisted OrderItem.unitPrice comes from the locked pricing snapshot, never the current live Product.price', async () => {
    const scenario = await seedReadyCheckout(fixture, handles, { quantity: 1, price: 500 });
    // Vendor changes the live price after the lock was already established -
    // the lock (see Phase 16A.0-B) must still govern what gets persisted.
    await prisma.product.update({ where: { id: scenario.productId }, data: { price: 999 } });
    const idempotencyKey = randomUUID();

    const result = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const order = await prisma.order.findUnique({
      where: { id: result.order.id },
      include: { vendorOrders: { include: { items: true } } },
    });
    const item = order?.vendorOrders[0]?.items[0];
    expect(item?.unitPrice.toString()).toBe(scenario.lockedUnitPrice);
    expect(item?.unitPrice.toString()).not.toBe('999.00');
  });

  it('5. Order.currency and every OrderItem.currency equal the one canonical locked currency', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);
    const idempotencyKey = randomUUID();

    const result = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const order = await prisma.order.findUnique({
      where: { id: result.order.id },
      include: { vendorOrders: { include: { items: true } } },
    });
    expect(order?.currency).toBe(scenario.currency);
    const allItems = order?.vendorOrders.flatMap((vendorOrder) => vendorOrder.items) ?? [];
    expect(allItems.length).toBeGreaterThan(0);
    expect(allItems.every((item) => item.currency === scenario.currency)).toBe(true);
  });
});
