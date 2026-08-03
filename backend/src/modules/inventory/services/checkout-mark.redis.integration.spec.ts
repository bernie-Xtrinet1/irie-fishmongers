import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { cartIndexKey } from '../constants/inventory.constants';
import {
  buildPlan,
  checkoutIds,
  getRawCheckoutFields,
  getRawReservationValue,
  seedRawReservation,
  trackCheckoutKeysFor,
} from './checkout-reservation-state.redis-test-helpers';
import { CheckoutReservationStateService } from './checkout-reservation-state.service';
import { InventoryReservationsService } from './inventory-reservations.service';
import { cleanupKeys, connectRealRedis } from './inventory-reservations.redis-test-helpers';

// Real-Redis integration coverage for checkoutMark's plan-completeness and
// reservation-validation behavior (Unit 2.4.1). Concurrency, the suspect-
// product policy, and scriptVersion/direct-Lua-invocation coverage live in
// checkout-mark-concurrency.redis.integration.spec.ts - split to keep both
// files within the repository's 400-line file limit. Lease inspection/
// extension, checkoutRevert, finalizeCheckoutConsumption, and
// reconciliation each get their own real-Redis spec in their own later
// sub-unit.
//
// The unit suites mock RedisService.eval and can only verify the
// TypeScript-to-Lua calling contract; they cannot exercise
// CHECKOUT_MARK_SCRIPT's own arithmetic and atomicity. This file runs the
// real script against a real Redis instance (no ioredis-mock exists in
// this repo) to prove the script itself is correct - exactly the same
// reasoning already established for Unit 2.3's real-Redis suites.
//
// Requires a reachable Redis (REDIS_URL) and fails the whole file loudly
// if one is not available - it does not skip.
describe('CheckoutReservationStateService.checkoutMark (real Redis integration)', () => {
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

  it('marks every entry CHECKOUT_PENDING when the plan exactly matches the cart index', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productIds = ['product-a', 'product-b'].map(() => `${cartId}-${Math.random()}`);
    trackCheckoutKeysFor(createdKeys, cartId, productIds);

    await seedActiveReservation(cartId, productIds[0]!, customerId, 3);
    await seedActiveReservation(cartId, productIds[1]!, customerId, 7);

    const plan = buildPlan(productIds, { [productIds[0]!]: 3, [productIds[1]!]: 7 });
    const now = Date.now();
    const result = await checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180);

    expect(result).toEqual({ ok: true, suspectProductIds: [] });

    for (const productId of productIds) {
      const fields = await getRawCheckoutFields(client, cartId, productId);
      expect(fields?.status).toBe('CHECKOUT_PENDING');
      expect(fields?.checkoutIdempotencyKey).toBe(checkoutIdempotencyKey);
      expect(fields?.checkoutPendingAt).toBe(now);
      expect(fields?.checkoutPendingExpiresAt).toBe(now + 180_000);
    }
  });

  it('transitions ACTIVE entries to CHECKOUT_PENDING while preserving quantity/expiresAt/absoluteExpiresAt', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);

    await seedActiveReservation(cartId, productId, customerId, 4);
    const before = await getRawCheckoutFields(client, cartId, productId);

    const now = Date.now();
    const plan = buildPlan([productId], { [productId]: 4 });
    const result = await checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180);

    expect(result.ok).toBe(true);
    const after = await getRawCheckoutFields(client, cartId, productId);
    expect(after?.status).toBe('CHECKOUT_PENDING');
    expect(after?.quantity).toBe(before?.quantity);
    expect(after?.expiresAt).toBe(before?.expiresAt);
    expect(after?.absoluteExpiresAt).toBe(before?.absoluteExpiresAt);
  });

  it('fails with CHECKOUT_PLAN_MISMATCH and zero writes when the plan omits an indexed product', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productIds = [`product-${Math.random()}`, `product-${Math.random()}`];
    trackCheckoutKeysFor(createdKeys, cartId, productIds);

    await seedActiveReservation(cartId, productIds[0]!, customerId, 1);
    await seedActiveReservation(cartId, productIds[1]!, customerId, 1);

    // Plan only mentions the first product - the second is indexed but
    // missing from the plan.
    const plan = buildPlan([productIds[0]!], { [productIds[0]!]: 1 });
    const now = Date.now();
    const result = await checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180);

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'CHECKOUT_PLAN_MISMATCH') {
      expect(result.details.missingFromPlan).toEqual([productIds[1]]);
      expect(result.details.missingFromIndex).toEqual([]);
    } else {
      throw new Error('Expected CHECKOUT_PLAN_MISMATCH');
    }

    for (const productId of productIds) {
      const fields = await getRawCheckoutFields(client, cartId, productId);
      expect(fields?.status).toBe('ACTIVE');
    }
  });

  it('fails with CHECKOUT_PLAN_MISMATCH and zero writes when the plan includes an unindexed product', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    const extraProductId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId, extraProductId]);

    await seedActiveReservation(cartId, productId, customerId, 1);

    const plan = buildPlan([productId, extraProductId], { [productId]: 1, [extraProductId]: 1 });
    const now = Date.now();
    const result = await checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180);

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'CHECKOUT_PLAN_MISMATCH') {
      expect(result.details.missingFromIndex).toEqual([extraProductId]);
    } else {
      throw new Error('Expected CHECKOUT_PLAN_MISMATCH');
    }

    const fields = await getRawCheckoutFields(client, cartId, productId);
    expect(fields?.status).toBe('ACTIVE');
  });

  it('fails with CHECKOUT_PLAN_DUPLICATE_PRODUCT and zero writes', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);

    await seedActiveReservation(cartId, productId, customerId, 1);

    const plan = [
      { productId, expectedQuantity: 1 },
      { productId, expectedQuantity: 1 },
    ];
    const now = Date.now();
    const result = await checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180);

    expect(result).toEqual({ ok: false, code: 'CHECKOUT_PLAN_DUPLICATE_PRODUCT', duplicateProductIds: [productId] });
    const fields = await getRawCheckoutFields(client, cartId, productId);
    expect(fields?.status).toBe('ACTIVE');
  });

  it('fails with RESERVATION_MISSING and zero writes when one entry is missing', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const presentId = `product-${Math.random()}`;
    const missingId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [presentId, missingId]);

    await seedActiveReservation(cartId, presentId, customerId, 1);
    // Index the missing product without a backing reservation key, so the
    // completeness check passes but Pass 1 finds nothing there.
    await client.sadd(cartIndexKey(cartId), missingId);

    const plan = buildPlan([presentId, missingId], { [presentId]: 1, [missingId]: 1 });
    const now = Date.now();
    const result = await checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180);

    expect(result).toEqual({ ok: false, code: 'RESERVATION_MISSING', failedProductId: missingId });
    const fields = await getRawCheckoutFields(client, cartId, presentId);
    expect(fields?.status).toBe('ACTIVE');
  });

  it('fails with RESERVATION_EXPIRED and zero writes when one entry has expired', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const validId = `product-${Math.random()}`;
    const expiredId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [validId, expiredId]);

    await seedActiveReservation(cartId, validId, customerId, 1);
    const now = Date.now();
    const expiredEntry = {
      version: 1,
      quantity: 1,
      cartId,
      customerId,
      status: 'ACTIVE',
      createdAt: now - 1_000_000,
      lastRenewedAt: now - 1_000_000,
      expiresAt: now - 1_000,
      absoluteExpiresAt: now + 1_000_000,
      checkoutIdempotencyKey: null,
      checkoutPendingAt: null,
      checkoutPendingExpiresAt: null,
    };
    await seedRawReservation(client, cartId, expiredId, JSON.stringify(expiredEntry));

    const plan = buildPlan([validId, expiredId], { [validId]: 1, [expiredId]: 1 });
    const result = await checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180);

    expect(result).toEqual({ ok: false, code: 'RESERVATION_EXPIRED', failedProductId: expiredId });
    const fields = await getRawCheckoutFields(client, cartId, validId);
    expect(fields?.status).toBe('ACTIVE');
  });

  it('fails with RESERVATION_QUANTITY_MISMATCH and zero writes', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const validId = `product-${Math.random()}`;
    const mismatchId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [validId, mismatchId]);

    await seedActiveReservation(cartId, validId, customerId, 1);
    await seedActiveReservation(cartId, mismatchId, customerId, 5);

    const plan = buildPlan([validId, mismatchId], { [validId]: 1, [mismatchId]: 999 });
    const now = Date.now();
    const result = await checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180);

    expect(result).toEqual({ ok: false, code: 'RESERVATION_QUANTITY_MISMATCH', failedProductId: mismatchId });
    const fields = await getRawCheckoutFields(client, cartId, validId);
    expect(fields?.status).toBe('ACTIVE');
  });

  it('fails with RESERVATION_OWNER_MISMATCH and zero writes', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const validId = `product-${Math.random()}`;
    const wrongOwnerId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [validId, wrongOwnerId]);

    await seedActiveReservation(cartId, validId, customerId, 1);
    await seedActiveReservation(cartId, wrongOwnerId, customerId, 1);

    const plan = buildPlan([validId, wrongOwnerId], { [validId]: 1, [wrongOwnerId]: 1 });
    const now = Date.now();
    // A different customerId than the one the reservations were seeded with.
    const result = await checkoutState.checkoutMark(cartId, 'someone-else', checkoutIdempotencyKey, plan, now, 180);

    expect(result.ok).toBe(false);
    if (!result.ok && 'failedProductId' in result) {
      expect(result.code).toBe('RESERVATION_OWNER_MISMATCH');
    } else {
      throw new Error('Expected RESERVATION_OWNER_MISMATCH');
    }
    const fields = await getRawCheckoutFields(client, cartId, validId);
    expect(fields?.status).toBe('ACTIVE');
  });

  it('fails with RESERVATION_ABSOLUTE_EXPIRED and zero writes', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const validId = `product-${Math.random()}`;
    const absoluteExpiredId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [validId, absoluteExpiredId]);

    await seedActiveReservation(cartId, validId, customerId, 1);
    const now = Date.now();
    const absoluteExpiredEntry = {
      version: 1,
      quantity: 1,
      cartId,
      customerId,
      status: 'ACTIVE',
      createdAt: now - 4_000_000,
      lastRenewedAt: now - 100,
      expiresAt: now + 100_000, // rolling TTL still valid
      absoluteExpiresAt: now - 1_000, // but the absolute ceiling has passed
      checkoutIdempotencyKey: null,
      checkoutPendingAt: null,
      checkoutPendingExpiresAt: null,
    };
    await seedRawReservation(client, cartId, absoluteExpiredId, JSON.stringify(absoluteExpiredEntry));

    const plan = buildPlan([validId, absoluteExpiredId], { [validId]: 1, [absoluteExpiredId]: 1 });
    const result = await checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180);

    expect(result).toEqual({
      ok: false,
      code: 'RESERVATION_ABSOLUTE_EXPIRED',
      failedProductId: absoluteExpiredId,
    });
    const fields = await getRawCheckoutFields(client, cartId, validId);
    expect(fields?.status).toBe('ACTIVE');
  });

  it('fails with RESERVATION_MALFORMED and zero writes, preserving the malformed value', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const validId = `product-${Math.random()}`;
    const malformedId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [validId, malformedId]);

    await seedActiveReservation(cartId, validId, customerId, 1);
    await seedRawReservation(client, cartId, malformedId, '{not valid json');

    const plan = buildPlan([validId, malformedId], { [validId]: 1, [malformedId]: 1 });
    const now = Date.now();
    const result = await checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180);

    expect(result).toEqual({ ok: false, code: 'RESERVATION_MALFORMED', failedProductId: malformedId });
    const fields = await getRawCheckoutFields(client, cartId, validId);
    expect(fields?.status).toBe('ACTIVE');
    expect(await getRawReservationValue(client, cartId, malformedId)).toBe('{not valid json');
  });

  it('fails with RESERVATION_VERSION_MISMATCH and zero writes', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const validId = `product-${Math.random()}`;
    const mismatchedVersionId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [validId, mismatchedVersionId]);

    await seedActiveReservation(cartId, validId, customerId, 1);
    const now = Date.now();
    const wrongVersionEntry = {
      version: 2,
      quantity: 1,
      cartId,
      customerId,
      status: 'ACTIVE',
      createdAt: now,
      lastRenewedAt: now,
      expiresAt: now + 900_000,
      absoluteExpiresAt: now + 3_600_000,
      checkoutIdempotencyKey: null,
      checkoutPendingAt: null,
      checkoutPendingExpiresAt: null,
    };
    await seedRawReservation(client, cartId, mismatchedVersionId, JSON.stringify(wrongVersionEntry));

    const plan = buildPlan([validId, mismatchedVersionId], { [validId]: 1, [mismatchedVersionId]: 1 });
    const result = await checkoutState.checkoutMark(cartId, customerId, checkoutIdempotencyKey, plan, now, 180);

    expect(result).toEqual({
      ok: false,
      code: 'RESERVATION_VERSION_MISMATCH',
      failedProductId: mismatchedVersionId,
    });
    const fields = await getRawCheckoutFields(client, cartId, validId);
    expect(fields?.status).toBe('ACTIVE');
  });
});
