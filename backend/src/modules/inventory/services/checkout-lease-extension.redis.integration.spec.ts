import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { cartIndexKey } from '../constants/inventory.constants';
import {
  buildReservationEntryJson,
  checkoutIds,
  getRawCheckoutFields,
  seedRawReservation,
  trackCheckoutKeysFor,
} from './checkout-reservation-state.redis-test-helpers';
import { CheckoutLeaseStateService } from './checkout-lease-state.service';
import { cleanupKeys, connectRealRedis } from './inventory-reservations.redis-test-helpers';

// Real-Redis integration coverage for extendCheckoutLease's deterministic
// failure-priority scenarios (Unit 2.4.2): RESERVATION_MISSING/MALFORMED/
// VERSION_MISMATCH/CHECKOUT_STATE_INCOMPLETE/RESERVATION_CHECKOUT_KEY_MISMATCH,
// plus the baseline successful extension. Hard-ceiling boundary scenarios,
// retry/alreadyExtended, concurrency, and scriptVersion protocol coverage
// live in checkout-lease-extension-hard-limit.redis.integration.spec.ts -
// split per the Unit 2.4.2 decisions to keep every file within the
// repository's 400-line cap. Lease-inspection coverage lives in its own
// file, checkout-lease-state.redis.integration.spec.ts.
describe('CheckoutLeaseStateService.extendCheckoutLease (real Redis integration)', () => {
  let client: Redis;
  let leaseState: CheckoutLeaseStateService;
  let createdKeys: Set<string>;

  beforeAll(async () => {
    client = await connectRealRedis();
    leaseState = new CheckoutLeaseStateService(new RedisService(client));
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

  async function seedPending(
    cartId: string,
    productId: string,
    customerId: string,
    checkoutIdempotencyKey: string,
    checkoutPendingAt: number,
    checkoutPendingExpiresAt: number,
    now: number,
  ): Promise<void> {
    await seedRawReservation(
      client,
      cartId,
      productId,
      buildReservationEntryJson(now, {
        cartId,
        customerId,
        status: 'CHECKOUT_PENDING',
        checkoutIdempotencyKey,
        checkoutPendingAt,
        checkoutPendingExpiresAt,
      }),
    );
  }

  it('extends every pending entry, writing only checkoutPendingExpiresAt', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productIds = [`product-${Math.random()}`, `product-${Math.random()}`];
    trackCheckoutKeysFor(createdKeys, cartId, productIds);
    const now = Date.now();

    for (const productId of productIds) {
      await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, now, now + 10_000, now);
    }
    const before = await getRawCheckoutFields(client, cartId, productIds[0]!);

    const result = await leaseState.extendCheckoutLease(cartId, checkoutIdempotencyKey, now, 60);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyExtended).toBe(false);
      expect(result.extendedProductIds).toEqual([...productIds].sort());
      expect(result.newCheckoutPendingExpiresAt).toBe(now + 60_000);
    }
    for (const productId of productIds) {
      const after = await getRawCheckoutFields(client, cartId, productId);
      expect(after?.checkoutPendingExpiresAt).toBe(now + 60_000);
      expect(after?.quantity).toBe(before?.quantity);
      expect(after?.expiresAt).toBe(before?.expiresAt);
      expect(after?.absoluteExpiresAt).toBe(before?.absoluteExpiresAt);
      expect(after?.checkoutPendingAt).toBe(now);
    }
  });

  it('blocks every write in the cart when one member is ACTIVE (CHECKOUT_STATE_INCOMPLETE)', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const pendingId = `product-${Math.random()}`;
    const activeId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [pendingId, activeId]);
    const now = Date.now();

    await seedPending(cartId, pendingId, customerId, checkoutIdempotencyKey, now, now + 10_000, now);
    await seedRawReservation(
      client,
      cartId,
      activeId,
      buildReservationEntryJson(now, { cartId, customerId, status: 'ACTIVE' }),
    );

    const result = await leaseState.extendCheckoutLease(cartId, checkoutIdempotencyKey, now, 60);

    expect(result).toEqual({
      ok: false,
      code: 'CHECKOUT_STATE_INCOMPLETE',
      pendingProductIds: [pendingId],
      activeProductIds: [activeId],
    });
    const after = await getRawCheckoutFields(client, cartId, pendingId);
    expect(after?.checkoutPendingExpiresAt).toBe(now + 10_000);
  });

  it('blocks every write when one member is missing (RESERVATION_MISSING)', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const pendingId = `product-${Math.random()}`;
    const missingId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [pendingId, missingId]);
    const now = Date.now();

    await seedPending(cartId, pendingId, customerId, checkoutIdempotencyKey, now, now + 10_000, now);
    await client.sadd(cartIndexKey(cartId), missingId);

    const result = await leaseState.extendCheckoutLease(cartId, checkoutIdempotencyKey, now, 60);

    expect(result).toEqual({ ok: false, code: 'RESERVATION_MISSING', productIds: [missingId] });
    const after = await getRawCheckoutFields(client, cartId, pendingId);
    expect(after?.checkoutPendingExpiresAt).toBe(now + 10_000);
  });

  it('blocks every write when one member is malformed (RESERVATION_MALFORMED)', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const pendingId = `product-${Math.random()}`;
    const malformedId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [pendingId, malformedId]);
    const now = Date.now();

    await seedPending(cartId, pendingId, customerId, checkoutIdempotencyKey, now, now + 10_000, now);
    await seedRawReservation(client, cartId, malformedId, '{not valid json');

    const result = await leaseState.extendCheckoutLease(cartId, checkoutIdempotencyKey, now, 60);

    expect(result).toEqual({ ok: false, code: 'RESERVATION_MALFORMED', productIds: [malformedId] });
    const after = await getRawCheckoutFields(client, cartId, pendingId);
    expect(after?.checkoutPendingExpiresAt).toBe(now + 10_000);
  });

  it('blocks every write when one member has a version mismatch (RESERVATION_VERSION_MISMATCH)', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const pendingId = `product-${Math.random()}`;
    const wrongVersionId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [pendingId, wrongVersionId]);
    const now = Date.now();

    await seedPending(cartId, pendingId, customerId, checkoutIdempotencyKey, now, now + 10_000, now);
    await seedRawReservation(
      client,
      cartId,
      wrongVersionId,
      buildReservationEntryJson(now, { cartId, customerId, version: 2, status: 'ACTIVE' }),
    );

    const result = await leaseState.extendCheckoutLease(cartId, checkoutIdempotencyKey, now, 60);

    expect(result).toEqual({
      ok: false,
      code: 'RESERVATION_VERSION_MISMATCH',
      productIds: [wrongVersionId],
    });
    const after = await getRawCheckoutFields(client, cartId, pendingId);
    expect(after?.checkoutPendingExpiresAt).toBe(now + 10_000);
  });

  it('blocks every write when one member belongs to another checkout key (RESERVATION_CHECKOUT_KEY_MISMATCH)', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const ownedId = `product-${Math.random()}`;
    const conflictingId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [ownedId, conflictingId]);
    const now = Date.now();

    await seedPending(cartId, ownedId, customerId, checkoutIdempotencyKey, now, now + 10_000, now);
    await seedPending(
      cartId,
      conflictingId,
      customerId,
      `${checkoutIdempotencyKey}-other`,
      now,
      now + 10_000,
      now,
    );

    const result = await leaseState.extendCheckoutLease(cartId, checkoutIdempotencyKey, now, 60);

    expect(result).toEqual({
      ok: false,
      code: 'RESERVATION_CHECKOUT_KEY_MISMATCH',
      productIds: [conflictingId],
    });
    const after = await getRawCheckoutFields(client, cartId, ownedId);
    expect(after?.checkoutPendingExpiresAt).toBe(now + 10_000);
  });
});
