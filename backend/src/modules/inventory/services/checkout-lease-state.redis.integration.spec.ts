import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { cartIndexKey } from '../constants/inventory.constants';
import { CHECKOUT_LEASE_STATE_SCRIPT } from '../lua/checkout-lease-state-lua-scripts';
import {
  buildReservationEntryJson,
  checkoutIds,
  seedRawReservation,
  trackCheckoutKeysFor,
} from './checkout-reservation-state.redis-test-helpers';
import { CheckoutLeaseStateService } from './checkout-lease-state.service';
import { cleanupKeys, connectRealRedis } from './inventory-reservations.redis-test-helpers';

// Real-Redis integration coverage for getCheckoutPendingLeaseState (Unit
// 2.4.2). Extension coverage lives in its own file,
// checkout-lease-extension.redis.integration.spec.ts - split per the Unit
// 2.4.2 decisions to keep both files within the repository's 400-line
// cap. Every entry is seeded directly via buildReservationEntryJson for
// full, independent control over status/ownership/timestamps.
//
// Requires a reachable Redis (REDIS_URL) and fails the whole file loudly
// if one is not available - it does not skip.
describe('CheckoutLeaseStateService.getCheckoutPendingLeaseState (real Redis integration)', () => {
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

  it('reports a complete, uniform, fully-owned pending cart', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productIds = [`product-${Math.random()}`, `product-${Math.random()}`];
    trackCheckoutKeysFor(createdKeys, cartId, productIds);
    const now = Date.now();

    for (const productId of productIds) {
      await seedRawReservation(
        client,
        cartId,
        productId,
        buildReservationEntryJson(now, {
          cartId,
          customerId,
          status: 'CHECKOUT_PENDING',
          checkoutIdempotencyKey,
          checkoutPendingAt: now,
          checkoutPendingExpiresAt: now + 180_000,
        }),
      );
    }

    const result = await leaseState.getCheckoutPendingLeaseState(cartId, checkoutIdempotencyKey, now);

    expect(result).toEqual({
      ok: true,
      found: true,
      complete: true,
      allOwnedByCheckoutKey: true,
      earliestCheckoutPendingAt: now,
      earliestCheckoutPendingExpiresAt: now + 180_000,
      latestCheckoutPendingExpiresAt: now + 180_000,
      pendingProductIds: [...productIds].sort(),
      activeStatusProductIds: [],
      missingProductIds: [],
      malformedProductIds: [],
      versionMismatchedProductIds: [],
      conflictingKeyProductIds: [],
      expiredLeaseProductIds: [],
      hardLimitViolationProductIds: [],
    });
  });

  it('reports an empty cart index as not found/not complete with every array empty and every timestamp null', async () => {
    const { cartId, checkoutIdempotencyKey } = checkoutIds();
    createdKeys.add(cartIndexKey(cartId));

    const result = await leaseState.getCheckoutPendingLeaseState(cartId, checkoutIdempotencyKey, Date.now());

    expect(result).toEqual({
      ok: true,
      found: false,
      complete: false,
      allOwnedByCheckoutKey: false,
      earliestCheckoutPendingAt: null,
      earliestCheckoutPendingExpiresAt: null,
      latestCheckoutPendingExpiresAt: null,
      pendingProductIds: [],
      activeStatusProductIds: [],
      missingProductIds: [],
      malformedProductIds: [],
      versionMismatchedProductIds: [],
      conflictingKeyProductIds: [],
      expiredLeaseProductIds: [],
      hardLimitViolationProductIds: [],
    });
  });

  it('classifies an ACTIVE member and reports found/complete/allOwnedByCheckoutKey as false', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();

    await seedRawReservation(
      client,
      cartId,
      productId,
      buildReservationEntryJson(now, { cartId, customerId, status: 'ACTIVE' }),
    );

    const result = await leaseState.getCheckoutPendingLeaseState(cartId, checkoutIdempotencyKey, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.found).toBe(false);
      expect(result.complete).toBe(false);
      expect(result.allOwnedByCheckoutKey).toBe(false);
      expect(result.activeStatusProductIds).toEqual([productId]);
    }
  });

  it('classifies a missing reservation', async () => {
    const { cartId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    await client.sadd(cartIndexKey(cartId), productId);

    const result = await leaseState.getCheckoutPendingLeaseState(cartId, checkoutIdempotencyKey, Date.now());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.missingProductIds).toEqual([productId]);
      expect(result.found).toBe(false);
    }
  });

  it('classifies a malformed entry', async () => {
    const { cartId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    await seedRawReservation(client, cartId, productId, '{not valid json');

    const result = await leaseState.getCheckoutPendingLeaseState(cartId, checkoutIdempotencyKey, Date.now());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.malformedProductIds).toEqual([productId]);
    }
  });

  it('classifies a version-mismatched entry', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();

    await seedRawReservation(
      client,
      cartId,
      productId,
      buildReservationEntryJson(now, { cartId, customerId, version: 2, status: 'ACTIVE' }),
    );

    const result = await leaseState.getCheckoutPendingLeaseState(cartId, checkoutIdempotencyKey, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.versionMismatchedProductIds).toEqual([productId]);
    }
  });

  it('classifies a pending entry owned by a different checkout key as conflicting, not owned', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();

    await seedRawReservation(
      client,
      cartId,
      productId,
      buildReservationEntryJson(now, {
        cartId,
        customerId,
        status: 'CHECKOUT_PENDING',
        checkoutIdempotencyKey: `${checkoutIdempotencyKey}-other`,
        checkoutPendingAt: now,
        checkoutPendingExpiresAt: now + 180_000,
      }),
    );

    const result = await leaseState.getCheckoutPendingLeaseState(cartId, checkoutIdempotencyKey, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pendingProductIds).toEqual([productId]);
      expect(result.conflictingKeyProductIds).toEqual([productId]);
      expect(result.found).toBe(false);
      expect(result.allOwnedByCheckoutKey).toBe(false);
    }
  });

  it('classifies an owned pending entry whose lease has already expired', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();

    await seedRawReservation(
      client,
      cartId,
      productId,
      buildReservationEntryJson(now, {
        cartId,
        customerId,
        status: 'CHECKOUT_PENDING',
        checkoutIdempotencyKey,
        checkoutPendingAt: now - 200_000,
        checkoutPendingExpiresAt: now - 1_000,
      }),
    );

    const result = await leaseState.getCheckoutPendingLeaseState(cartId, checkoutIdempotencyKey, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expiredLeaseProductIds).toEqual([productId]);
      expect(result.found).toBe(true);
    }
  });

  it('computes earliest/latest timestamps only across owned-pending entries with staggered values', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productIds = [`product-${Math.random()}`, `product-${Math.random()}`, `product-${Math.random()}`];
    trackCheckoutKeysFor(createdKeys, cartId, productIds);
    const now = Date.now();

    await seedRawReservation(
      client,
      cartId,
      productIds[0]!,
      buildReservationEntryJson(now, {
        cartId,
        customerId,
        status: 'CHECKOUT_PENDING',
        checkoutIdempotencyKey,
        checkoutPendingAt: now - 30_000,
        checkoutPendingExpiresAt: now + 100_000,
      }),
    );
    await seedRawReservation(
      client,
      cartId,
      productIds[1]!,
      buildReservationEntryJson(now, {
        cartId,
        customerId,
        status: 'CHECKOUT_PENDING',
        checkoutIdempotencyKey,
        checkoutPendingAt: now - 10_000,
        checkoutPendingExpiresAt: now + 180_000,
      }),
    );
    // A different-key pending entry must not influence the owned-only
    // earliest/latest aggregation.
    await seedRawReservation(
      client,
      cartId,
      productIds[2]!,
      buildReservationEntryJson(now, {
        cartId,
        customerId,
        status: 'CHECKOUT_PENDING',
        checkoutIdempotencyKey: `${checkoutIdempotencyKey}-other`,
        checkoutPendingAt: now - 999_000,
        checkoutPendingExpiresAt: now + 999_000,
      }),
    );

    const result = await leaseState.getCheckoutPendingLeaseState(cartId, checkoutIdempotencyKey, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.earliestCheckoutPendingAt).toBe(now - 30_000);
      expect(result.earliestCheckoutPendingExpiresAt).toBe(now + 100_000);
      expect(result.latestCheckoutPendingExpiresAt).toBe(now + 180_000);
    }
  });

  it('reports a hard-limit violation when now has reached checkoutPendingAt + MAX_CHECKOUT_PENDING_SECONDS', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();

    await seedRawReservation(
      client,
      cartId,
      productId,
      buildReservationEntryJson(now, {
        cartId,
        customerId,
        status: 'CHECKOUT_PENDING',
        checkoutIdempotencyKey,
        checkoutPendingAt: now - 600_000,
        checkoutPendingExpiresAt: now + 50_000,
      }),
    );

    const result = await leaseState.getCheckoutPendingLeaseState(cartId, checkoutIdempotencyKey, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hardLimitViolationProductIds).toEqual([productId]);
      expect(result.complete).toBe(false);
    }
  });

  it('reports a hard-limit violation for a corrupted stored deadline beyond the ceiling, without also reporting an ordinary expired lease', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();
    // checkoutPendingAt is recent (well below the ceiling on its own), but
    // the stored checkoutPendingExpiresAt is already past
    // checkoutPendingAt + MAX_CHECKOUT_PENDING_SECONDS - a corrupted or
    // unsupported deadline, and one still in the future relative to now,
    // so it must not also land in expiredLeaseProductIds.
    await seedRawReservation(
      client,
      cartId,
      productId,
      buildReservationEntryJson(now, {
        cartId,
        customerId,
        status: 'CHECKOUT_PENDING',
        checkoutIdempotencyKey,
        checkoutPendingAt: now,
        checkoutPendingExpiresAt: now + 700_000,
      }),
    );

    const result = await leaseState.getCheckoutPendingLeaseState(cartId, checkoutIdempotencyKey, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hardLimitViolationProductIds).toEqual([productId]);
      expect(result.expiredLeaseProductIds).toEqual([]);
      expect(result.complete).toBe(false);
    }
  });

  it('includes scriptVersion on the raw Lua result', async () => {
    const { cartId, checkoutIdempotencyKey } = checkoutIds();
    createdKeys.add(cartIndexKey(cartId));

    const raw = await client.eval(
      CHECKOUT_LEASE_STATE_SCRIPT,
      1,
      cartIndexKey(cartId),
      cartId,
      checkoutIdempotencyKey,
      String(Date.now()),
      '600000',
    );
    const parsed = JSON.parse(raw as string) as Record<string, unknown>;
    expect(parsed.scriptVersion).toBe(1);
  });
});
