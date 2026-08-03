import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { cartIndexKey, productSuspectKey, reservationKey } from '../constants/inventory.constants';
import { CHECKOUT_MARK_SCRIPT } from '../lua/checkout-mark-lua-scripts';
import {
  buildPlan,
  checkoutIds,
  getRawCheckoutFields,
  setSuspectFlag,
  trackCheckoutKeysFor,
} from './checkout-reservation-state.redis-test-helpers';
import { CheckoutReservationStateService } from './checkout-reservation-state.service';
import { CheckoutPlanMismatchDetails } from './checkout-reservation-state.types';
import { InventoryReservationsService } from './inventory-reservations.service';
import { cleanupKeys, connectRealRedis } from './inventory-reservations.redis-test-helpers';

// Concurrency, the suspect-product policy, and scriptVersion/direct-Lua-
// invocation coverage for checkoutMark (Unit 2.4.1). Plan/completeness/
// reservation-validation-failure scenarios live in
// checkout-mark.redis.integration.spec.ts - split to keep both files
// within the repository's 400-line file limit.
//
// Requires a reachable Redis (REDIS_URL) and fails the whole file loudly
// if one is not available - it does not skip.
describe('CheckoutReservationStateService.checkoutMark (real Redis concurrency + protocol)', () => {
  let client: Redis;
  let inventoryReservations: InventoryReservationsService;
  let checkoutState: CheckoutReservationStateService;
  let createdKeys: Set<string>;

  beforeAll(async () => {
    client = await connectRealRedis();
    const redisService = new RedisService(client);
    inventoryReservations = new InventoryReservationsService(redisService);
    checkoutState = new CheckoutReservationStateService(redisService);
  });

  afterAll(async () => {
    await client.quit();
  });

  beforeEach(() => {
    createdKeys = new Set<string>();
  });

  afterEach(async () => {
    await cleanupKeys(client, createdKeys);
  });

  async function seedActiveReservation(
    cartId: string,
    productId: string,
    customerId: string,
    quantity: number,
  ): Promise<void> {
    const outcome = await inventoryReservations.reserveOrRenew(cartId, productId, customerId, quantity);
    if (!outcome.ok) {
      throw new Error(`Failed to seed reservation: ${outcome.code}`);
    }
  }

  it('fails the whole cart atomically with RESERVATION_CHECKOUT_KEY_CONFLICT when a different key is already pending', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const otherKey = `${checkoutIdempotencyKey}-other`;
    const productIds = [`product-${Math.random()}`, `product-${Math.random()}`];
    trackCheckoutKeysFor(createdKeys, cartId, productIds);

    await seedActiveReservation(cartId, productIds[0]!, customerId, 1);
    await seedActiveReservation(cartId, productIds[1]!, customerId, 1);

    const plan = buildPlan(productIds, { [productIds[0]!]: 1, [productIds[1]!]: 1 });
    const now = Date.now();

    const first = await checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180);
    expect(first.ok).toBe(true);

    const second = await checkoutState.checkoutMark(cartId, customerId, otherKey, plan, now, 180);
    expect(second).toEqual({
      ok: false,
      code: 'RESERVATION_CHECKOUT_KEY_CONFLICT',
      failedProductId: expect.any(String) as string,
    });

    for (const productId of productIds) {
      const fields = await getRawCheckoutFields(client, cartId, productId);
      expect(fields?.checkoutIdempotencyKey).toBe(checkoutIdempotencyKey);
    }
  });

  it('succeeds and reports a suspect product without blocking the mark', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);

    await seedActiveReservation(cartId, productId, customerId, 2);
    await setSuspectFlag(client, productId);

    const plan = buildPlan([productId], { [productId]: 2 });
    const now = Date.now();
    const result = await checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180);

    expect(result).toEqual({ ok: true, suspectProductIds: [productId] });
    const fields = await getRawCheckoutFields(client, cartId, productId);
    expect(fields?.status).toBe('CHECKOUT_PENDING');
  });

  it('lets exactly one of two racing different-key calls win', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const otherKey = `${checkoutIdempotencyKey}-race`;
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);

    await seedActiveReservation(cartId, productId, customerId, 1);
    const plan = buildPlan([productId], { [productId]: 1 });
    const now = Date.now();

    const [a, b] = await Promise.all([
      checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180),
      checkoutState.checkoutMark(cartId, customerId, otherKey, plan, now, 180),
    ]);

    const outcomes = [a, b];
    const winners = outcomes.filter((r) => r.ok);
    const losers = outcomes.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if (!losers[0]!.ok) {
      expect(losers[0]!.code).toBe('RESERVATION_CHECKOUT_KEY_CONFLICT');
    }

    const fields = await getRawCheckoutFields(client, cartId, productId);
    expect(fields?.status).toBe('CHECKOUT_PENDING');
    expect([checkoutIdempotencyKey, otherKey]).toContain(fields?.checkoutIdempotencyKey);
  });

  it('lets concurrent same-key calls both succeed with identical final state', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);

    await seedActiveReservation(cartId, productId, customerId, 1);
    const plan = buildPlan([productId], { [productId]: 1 });
    const now = Date.now();

    const [a, b] = await Promise.all([
      checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180),
      checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180),
    ]);

    expect(a).toEqual({ ok: true, suspectProductIds: [] });
    expect(b).toEqual({ ok: true, suspectProductIds: [] });

    const fields = await getRawCheckoutFields(client, cartId, productId);
    expect(fields?.status).toBe('CHECKOUT_PENDING');
    expect(fields?.checkoutIdempotencyKey).toBe(checkoutIdempotencyKey);
  });

  it('leaves zero partial mutation when a mismatched-plan call races a valid call', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const otherKey = `${checkoutIdempotencyKey}-mismatch`;
    const productIds = [`product-${Math.random()}`, `product-${Math.random()}`];
    trackCheckoutKeysFor(createdKeys, cartId, productIds);

    await seedActiveReservation(cartId, productIds[0]!, customerId, 1);
    await seedActiveReservation(cartId, productIds[1]!, customerId, 1);

    const fullPlan = buildPlan(productIds, { [productIds[0]!]: 1, [productIds[1]!]: 1 });
    const incompletePlan = buildPlan([productIds[0]!], { [productIds[0]!]: 1 });
    const now = Date.now();

    const [full, incomplete] = await Promise.all([
      checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, fullPlan, now, 180),
      checkoutState.checkoutMark(cartId, customerId, otherKey, incompletePlan, now, 180),
    ]);

    expect(incomplete).toEqual({
      ok: false,
      code: 'CHECKOUT_PLAN_MISMATCH',
      details: expect.objectContaining({
        missingFromPlan: [productIds[1]],
      }) as CheckoutPlanMismatchDetails,
    });

    // Whichever of the two ran second still observes a fully consistent
    // cart: either the full plan already succeeded (both entries pending)
    // or it has not run yet (both entries still active) - never a mix.
    const statuses = await Promise.all(
      productIds.map(async (productId) => (await getRawCheckoutFields(client, cartId, productId))?.status),
    );
    if (full.ok) {
      expect(statuses).toEqual(['CHECKOUT_PENDING', 'CHECKOUT_PENDING']);
    } else {
      expect(statuses).toEqual(['ACTIVE', 'ACTIVE']);
    }
  });

  describe('direct Lua invocation (bypassing the typed service and its input validation)', () => {
    async function rawEval(
      cartId: string,
      customerId: string,
      checkoutIdempotencyKey: string,
      items: { productId: string; expectedQuantity: number }[],
      now: number,
    ): Promise<Record<string, unknown>> {
      const keys = [
        cartIndexKey(cartId),
        ...items.map((item) => reservationKey(cartId, item.productId)),
        ...items.map((item) => productSuspectKey(item.productId)),
      ];
      const args: (string | number)[] = [
        cartId,
        customerId,
        checkoutIdempotencyKey,
        now,
        180_000,
        600_000,
        items.length,
        ...items.map((item) => item.productId),
        ...items.map((item) => item.expectedQuantity),
      ];
      const raw = await client.eval(CHECKOUT_MARK_SCRIPT, keys.length, ...keys, ...args);
      return JSON.parse(raw as string) as Record<string, unknown>;
    }

    it('includes scriptVersion on an empty-plan (CHECKOUT_PLAN_EMPTY) failure', async () => {
      const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
      const result = await rawEval(cartId, customerId, checkoutIdempotencyKey, [], Date.now());
      expect(result).toEqual({ scriptVersion: 1, err: 'CHECKOUT_PLAN_EMPTY' });
    });

    it('includes scriptVersion on success', async () => {
      const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
      const productId = `product-${Math.random()}`;
      trackCheckoutKeysFor(createdKeys, cartId, [productId]);
      await seedActiveReservation(cartId, productId, customerId, 1);

      const result = await rawEval(
        cartId,
        customerId,
        checkoutIdempotencyKey,
        [{ productId, expectedQuantity: 1 }],
        Date.now(),
      );
      // Raw (unnormalized) Lua output, not the service's mapped result: an
      // empty suspectProductIds table is encoded by this Redis's cjson as
      // a JSON object, not an array - the documented empty-table quirk
      // (see checkout-mark-lua-scripts.ts and
      // CheckoutReservationStateService.toStringArray, which normalizes
      // this on the typed path).
      expect(result).toEqual({ scriptVersion: 1, ok: true, suspectProductIds: {} });
    });

    it('includes scriptVersion on a CHECKOUT_PLAN_MISMATCH failure', async () => {
      const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
      const productId = `product-${Math.random()}`;
      const extraProductId = `product-${Math.random()}`;
      trackCheckoutKeysFor(createdKeys, cartId, [productId, extraProductId]);
      await seedActiveReservation(cartId, productId, customerId, 1);

      const result = await rawEval(
        cartId,
        customerId,
        checkoutIdempotencyKey,
        [
          { productId, expectedQuantity: 1 },
          { productId: extraProductId, expectedQuantity: 1 },
        ],
        Date.now(),
      );
      expect(result).toMatchObject({ scriptVersion: 1, err: 'CHECKOUT_PLAN_MISMATCH' });
    });

    it('includes scriptVersion on a reservation-validation failure', async () => {
      const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
      const missingId = `product-${Math.random()}`;
      trackCheckoutKeysFor(createdKeys, cartId, [missingId]);
      await client.sadd(cartIndexKey(cartId), missingId);

      const result = await rawEval(
        cartId,
        customerId,
        checkoutIdempotencyKey,
        [{ productId: missingId, expectedQuantity: 1 }],
        Date.now(),
      );
      expect(result).toEqual({ scriptVersion: 1, err: 'RESERVATION_MISSING', failedProductId: missingId });
    });
  });
});
