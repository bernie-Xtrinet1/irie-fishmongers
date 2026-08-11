import { randomUUID } from 'crypto';

import { PrismaService } from '../../../database/prisma.service';
import { reservationKey } from '../../inventory/constants/inventory.constants';
import {
  connectRealRedis,
  getCartIndexMembers,
  getProductIndexMembers,
  getRawReservation,
} from '../../inventory/services/inventory-reservations.redis-test-helpers';
import {
  CheckoutIntegrationFixture,
  RealCoordinatorHandles,
  buildRealCoordinator,
  checkoutDto,
  seedReadyCheckout,
  setUpCheckoutIntegrationFixture,
  tearDownCheckoutIntegrationFixture,
} from './checkout-coordinator-integration-test-helpers';

// Phase 16A.0-D, Unit D.3. Proves checkoutMark/checkoutRevert/
// finalizeCheckoutConsumption's real-Redis interactions through
// CheckoutCoordinatorService. Deliberately NOT database index 1 (the
// shared convention used by most real-Redis integration specs), index 2
// (compensation-batch's own dedicated index), or index 3
// (checkout-coordinator.postgres.integration.spec.ts's index - that suite
// also exercises real Redis via buildRealCoordinator). A genuine
// collision between this file and the Postgres-focused suite sharing
// index 3 was reproduced directly (a reservation this suite had just
// seeded was gone/corrupted mid-test when both files' flushdb() calls
// interleaved across parallel Jest workers) - the exact same collision
// class C4.4 first found. This suite gets its own dedicated index,
// documented as test infrastructure only.
jest.setTimeout(30_000);

const ISOLATED_DB_INDEX = 4;

interface RawReservationEntry {
  status: string;
  checkoutIdempotencyKey: string | null;
  quantity: number;
}

function parseRawReservation(raw: string): RawReservationEntry {
  return JSON.parse(raw) as RawReservationEntry;
}

describe('CheckoutCoordinatorService (real Redis)', () => {
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

  it('1. checkoutMark moves the real reservation to CHECKOUT_PENDING with the correct checkout key and quantity', async () => {
    const scenario = await seedReadyCheckout(fixture, handles, { quantity: 3 });
    const idempotencyKey = randomUUID();

    const markResult = await handles.checkoutReservationState.checkoutMark(
      scenario.cartId,
      scenario.customerId,
      idempotencyKey,
      [{ productId: scenario.productId, expectedQuantity: scenario.quantity }],
      Date.now(),
      180,
    );
    expect(markResult.ok).toBe(true);

    const raw = await getRawReservation(redisClient, scenario.cartId, scenario.productId);
    expect(raw).not.toBeNull();
    const entry = parseRawReservation(raw!);
    expect(entry.status).toBe('CHECKOUT_PENDING');
    expect(entry.checkoutIdempotencyKey).toBe(idempotencyKey);
    expect(entry.quantity).toBe(3);
  });

  it('2. a successful checkout consumes the reservation and cleans both the cart and product indexes', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);
    const idempotencyKey = randomUUID();

    const result = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());
    expect(result.ok).toBe(true);

    const raw = await getRawReservation(redisClient, scenario.cartId, scenario.productId);
    expect(raw).toBeNull();
    expect(await getCartIndexMembers(redisClient, scenario.cartId)).not.toContain(
      reservationKey(scenario.cartId, scenario.productId),
    );
    expect(await getProductIndexMembers(redisClient, scenario.productId)).not.toContain(
      reservationKey(scenario.cartId, scenario.productId),
    );
  });

  it('3. a durable transaction failure reverts the reservation back to ACTIVE, not stuck CHECKOUT_PENDING', async () => {
    const scenario = await seedReadyCheckout(fixture, handles, { quantity: 5 });
    await prisma.product.update({ where: { id: scenario.productId }, data: { quantityAvailable: 1 } });
    const idempotencyKey = randomUUID();

    const result = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());
    expect(result).toMatchObject({ ok: false, code: 'ORDER_TRANSACTION_FAILED' });

    const raw = await getRawReservation(redisClient, scenario.cartId, scenario.productId);
    expect(raw).not.toBeNull();
    const entry = parseRawReservation(raw!);
    expect(entry.status).toBe('ACTIVE');
    expect(entry.checkoutIdempotencyKey).toBeNull();
    expect(entry.quantity).toBe(5);
  });

  it('4. a checkoutRevert failure still marks the attempt FAILED, with REVERT_INCOMPLETE', async () => {
    const scenario = await seedReadyCheckout(fixture, handles, { quantity: 5 });
    await prisma.product.update({ where: { id: scenario.productId }, data: { quantityAvailable: 1 } });
    const idempotencyKey = randomUUID();

    // Narrowest documented fault injection: everything else in this call
    // (checkoutMark, the real transaction failure, markFailed) is real -
    // only checkoutRevert's own outcome is overridden for this one call,
    // since a real Redis-level revert failure isn't safely reproducible
    // without corrupting shared infrastructure.
    const spy = jest
      .spyOn(handles.checkoutReservationRecovery, 'checkoutRevert')
      .mockRejectedValueOnce(new Error('simulated Redis outage during revert'));

    const result = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());
    spy.mockRestore();

    expect(result).toMatchObject({ ok: false, code: 'ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE' });

    const attempt = await prisma.checkoutAttempt.findUniqueOrThrow({ where: { idempotencyKey } });
    expect(attempt.status).toBe('FAILED');
    expect(attempt.failureCode).toBe('ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE');
  });

  it('5. a finalize failure after a successful commit leaves the order/attempt committed, still returns success, and never calls markFailed', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);
    const idempotencyKey = randomUUID();

    const finalizeSpy = jest
      .spyOn(handles.checkoutReservationRecovery, 'finalizeCheckoutConsumption')
      .mockRejectedValueOnce(new Error('simulated Redis outage during finalize'));
    const markFailedSpy = jest.spyOn(handles.checkoutAttemptService, 'markFailed');

    const result = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());
    finalizeSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(markFailedSpy).not.toHaveBeenCalled();

    const attempt = await prisma.checkoutAttempt.findUniqueOrThrow({ where: { idempotencyKey } });
    expect(attempt.status).toBe('COMMITTED');
    if (!result.ok) return;
    const order = await prisma.order.findUnique({ where: { id: result.order.id } });
    expect(order).not.toBeNull();

    // The reservation was never actually finalized (the real script never
    // ran because finalizeCheckoutConsumption itself threw) - it remains
    // in CHECKOUT_PENDING, an intentional inconsistency left for deferred
    // (Phase F) recovery rather than papered over here.
    const raw = await getRawReservation(redisClient, scenario.cartId, scenario.productId);
    expect(raw).not.toBeNull();
    const entry = parseRawReservation(raw!);
    expect(entry.status).toBe('CHECKOUT_PENDING');
  });
});
