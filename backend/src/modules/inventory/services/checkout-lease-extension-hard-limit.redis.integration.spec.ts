import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { cartIndexKey, reservationKey } from '../constants/inventory.constants';
import { CHECKOUT_EXTEND_LEASE_SCRIPT } from '../lua/checkout-lease-extend-lua-scripts';
import {
  buildReservationEntryJson,
  checkoutIds,
  getRawCheckoutFields,
  getRawReservationValue,
  seedRawReservation,
  trackCheckoutKeysFor,
} from './checkout-reservation-state.redis-test-helpers';
import { CheckoutLeaseStateService } from './checkout-lease-state.service';
import { cleanupKeys, connectRealRedis } from './inventory-reservations.redis-test-helpers';

// Real-Redis integration coverage for extendCheckoutLease's hard-ceiling
// invariant (Unit 2.4.2 correction), retry/alreadyExtended semantics,
// concurrency, and scriptVersion protocol. Deterministic-priority blocking
// scenarios (missing/malformed/version-mismatch/state-incomplete/key-
// mismatch) and the baseline successful extension live in the sibling file
// checkout-lease-extension.redis.integration.spec.ts - split to keep every
// file within the repository's 400-line cap.
//
// The hard ceiling is `checkoutPendingAt + MAX_CHECKOUT_PENDING_SECONDS`.
// A pending entry violates it when either now has reached/passed the
// ceiling, or its *stored* checkoutPendingExpiresAt already exceeds the
// ceiling (a corrupted or unsupported deadline) - both must fail the
// whole cart atomically with CHECKOUT_PENDING_HARD_LIMIT_REACHED and
// leave every entry, including the offending one, byte-for-byte
// unchanged.
const MAX_CHECKOUT_PENDING_MS = 600_000;

describe('CheckoutLeaseStateService.extendCheckoutLease (real Redis integration - hard limit, retry, concurrency, protocol)', () => {
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

  it('blocks every write when one member is exactly at the hard ceiling (now >= checkoutPendingAt + MAX_CHECKOUT_PENDING_SECONDS)', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const extendableId = `product-${Math.random()}`;
    const atCeilingId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [extendableId, atCeilingId]);
    const now = Date.now();

    await seedPending(cartId, extendableId, customerId, checkoutIdempotencyKey, now, now + 10_000, now);
    // checkoutPendingAt + MAX_CHECKOUT_PENDING_MS === now exactly - the
    // >= boundary in the hard-ceiling condition, not merely past it.
    await seedPending(
      cartId,
      atCeilingId,
      customerId,
      checkoutIdempotencyKey,
      now - MAX_CHECKOUT_PENDING_MS,
      now - 1,
      now,
    );

    const result = await leaseState.extendCheckoutLease(cartId, checkoutIdempotencyKey, now, 60);

    expect(result).toEqual({
      ok: false,
      code: 'CHECKOUT_PENDING_HARD_LIMIT_REACHED',
      productIds: [atCeilingId],
    });
    const after = await getRawCheckoutFields(client, cartId, extendableId);
    expect(after?.checkoutPendingExpiresAt).toBe(now + 10_000);
  });

  it('blocks every write when one member has a stored checkoutPendingExpiresAt already beyond its hard ceiling', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const extendableId = `product-${Math.random()}`;
    const corruptedId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [extendableId, corruptedId]);
    const now = Date.now();

    await seedPending(cartId, extendableId, customerId, checkoutIdempotencyKey, now, now + 10_000, now);
    const corruptedRawBefore = buildReservationEntryJson(now, {
      cartId,
      customerId,
      status: 'CHECKOUT_PENDING',
      checkoutIdempotencyKey,
      // checkoutPendingAt is recent (ceiling = now + 500_000), but the
      // stored deadline is already past that ceiling - a corrupted or
      // unsupported value, not merely close to expiry, and still in the
      // future relative to now (so it is not an ordinary expired lease).
      checkoutPendingAt: now - 100_000,
      checkoutPendingExpiresAt: now + 600_000,
    });
    await seedRawReservation(client, cartId, corruptedId, corruptedRawBefore);

    const result = await leaseState.extendCheckoutLease(cartId, checkoutIdempotencyKey, now, 60);

    expect(result).toEqual({
      ok: false,
      code: 'CHECKOUT_PENDING_HARD_LIMIT_REACHED',
      productIds: [corruptedId],
    });
    // Not a successful alreadyExtended result - a genuine failure.
    expect(result.ok).toBe(false);

    // Every entry in the cart, including the corrupted one itself, is
    // byte-for-byte unchanged - the deadline is never silently clamped.
    const extendableAfter = await getRawCheckoutFields(client, cartId, extendableId);
    expect(extendableAfter?.checkoutPendingExpiresAt).toBe(now + 10_000);
    const corruptedRawAfter = await getRawReservationValue(client, cartId, corruptedId);
    expect(corruptedRawAfter).toBe(corruptedRawBefore);
  });

  it('extends normally when the stored deadline is valid and below the hard ceiling', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();
    // checkoutPendingAt is old but not yet at the ceiling (ceiling = now +
    // 5_000), and the current stored expiry is comfortably below it.
    const checkoutPendingAt = now - (MAX_CHECKOUT_PENDING_MS - 5_000);

    await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, checkoutPendingAt, now, now);

    const result = await leaseState.extendCheckoutLease(cartId, checkoutIdempotencyKey, now, 3);

    expect(result).toEqual({
      ok: true,
      alreadyExtended: false,
      newCheckoutPendingExpiresAt: now + 3_000,
      extendedProductIds: [productId],
    });
    const after = await getRawCheckoutFields(client, cartId, productId);
    expect(after?.checkoutPendingExpiresAt).toBe(now + 3_000);
  });

  it('returns alreadyExtended: true and performs zero writes on an identical retry', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();

    await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, now, now + 10_000, now);

    const first = await leaseState.extendCheckoutLease(cartId, checkoutIdempotencyKey, now, 60);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.alreadyExtended).toBe(false);
    }
    const afterFirst = await getRawCheckoutFields(client, cartId, productId);

    const second = await leaseState.extendCheckoutLease(cartId, checkoutIdempotencyKey, now, 60);
    expect(second).toEqual({
      ok: true,
      alreadyExtended: true,
      newCheckoutPendingExpiresAt: now + 60_000,
      extendedProductIds: [],
    });

    const afterSecond = await getRawCheckoutFields(client, cartId, productId);
    expect(afterSecond).toEqual(afterFirst);
  });

  it('never extends checkoutPendingExpiresAt past checkoutPendingAt + MAX_CHECKOUT_PENDING_SECONDS', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();
    const checkoutPendingAt = now - (MAX_CHECKOUT_PENDING_MS - 1_000);
    // Current expiry is deliberately below where the hard cap
    // (checkoutPendingAt + MAX_CHECKOUT_PENDING_MS = now + 1_000) will
    // land, so the extension actually writes and the cap is exercised -
    // not merely trivially satisfied by an already-later stored value.
    const currentExpiresAt = now - 5_000;

    await seedPending(
      cartId,
      productId,
      customerId,
      checkoutIdempotencyKey,
      checkoutPendingAt,
      currentExpiresAt,
      now,
    );

    // additionalSeconds is deliberately far larger than the remaining
    // hard-ceiling budget - the cap must still bind.
    const result = await leaseState.extendCheckoutLease(cartId, checkoutIdempotencyKey, now, 10_000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newCheckoutPendingExpiresAt).toBe(checkoutPendingAt + MAX_CHECKOUT_PENDING_MS);
    }
    const after = await getRawCheckoutFields(client, cartId, productId);
    expect(after?.checkoutPendingExpiresAt).toBe(checkoutPendingAt + MAX_CHECKOUT_PENDING_MS);
  });

  it('preserves a consistent, capped final state under concurrent extension calls', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();

    await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, now, now + 10_000, now);

    const [a, b] = await Promise.all([
      leaseState.extendCheckoutLease(cartId, checkoutIdempotencyKey, now, 60),
      leaseState.extendCheckoutLease(cartId, checkoutIdempotencyKey, now, 60),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const extendedCount = [a, b].filter((r) => r.ok && !r.alreadyExtended).length;
    expect(extendedCount).toBeGreaterThanOrEqual(1);

    const after = await getRawCheckoutFields(client, cartId, productId);
    expect(after?.checkoutPendingExpiresAt).toBe(now + 60_000);
  });

  it('includes scriptVersion on the raw Lua result for both success and failure', async () => {
    const { cartId, checkoutIdempotencyKey } = checkoutIds();
    createdKeys.add(cartIndexKey(cartId));

    const emptyResult = await client.eval(
      CHECKOUT_EXTEND_LEASE_SCRIPT,
      1,
      cartIndexKey(cartId),
      cartId,
      checkoutIdempotencyKey,
      String(Date.now()),
      '60000',
      String(MAX_CHECKOUT_PENDING_MS),
    );
    expect((JSON.parse(emptyResult as string) as Record<string, unknown>).scriptVersion).toBe(1);

    const { customerId } = checkoutIds();
    const productId = `product-${Math.random()}`;
    createdKeys.add(reservationKey(cartId, productId));
    const now = Date.now();
    await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, now, now + 10_000, now);

    const successResult = await client.eval(
      CHECKOUT_EXTEND_LEASE_SCRIPT,
      1,
      cartIndexKey(cartId),
      cartId,
      checkoutIdempotencyKey,
      String(now),
      '60000',
      String(MAX_CHECKOUT_PENDING_MS),
    );
    expect((JSON.parse(successResult as string) as Record<string, unknown>).scriptVersion).toBe(1);
  });
});
