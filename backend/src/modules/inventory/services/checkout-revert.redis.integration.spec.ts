import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { productIndexKey, productTotalKey } from '../constants/inventory.constants';
import {
  buildReservationEntryJson,
  checkoutIds,
  getRawCheckoutFields,
  seedRawReservation,
} from './checkout-reservation-state.redis-test-helpers';
import { CheckoutReservationRecoveryService } from './checkout-reservation-recovery.service';
import {
  cleanupKeys,
  connectRealRedis,
  getCartIndexMembers,
  getProductIndexMembers,
  getStoredTotal,
  trackKeysFor,
} from './inventory-reservations.redis-test-helpers';

// Real-Redis integration coverage for checkoutRevert's baseline scenarios
// (Unit 2.4.3): valid-pending restore and expired-pending deletion, both
// with full accounting verification. ACTIVE/different-key/missing/
// malformed/version-mismatch/underflow/chaos scenarios live in
// checkout-revert-corruption.redis.integration.spec.ts - split per the
// Unit 2.4.3 file-size rules. finalizeCheckoutConsumption coverage lives
// in checkout-finalize.redis.integration.spec.ts.
//
// Requires a reachable Redis (REDIS_URL) and fails the whole file loudly
// if one is not available - it does not skip.
describe('CheckoutReservationRecoveryService.checkoutRevert (real Redis integration - baseline)', () => {
  let client: Redis;
  let recovery: CheckoutReservationRecoveryService;
  let createdKeys: Set<string>;

  beforeAll(async () => {
    client = await connectRealRedis();
    recovery = new CheckoutReservationRecoveryService(new RedisService(client));
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

  async function seedPendingWithAccounting(
    cartId: string,
    productId: string,
    customerId: string,
    checkoutIdempotencyKey: string,
    quantity: number,
    expiresAt: number,
    absoluteExpiresAt: number,
    storedTotal: number,
    now: number,
  ): Promise<void> {
    trackKeysFor(createdKeys, cartId, productId);
    await seedRawReservation(
      client,
      cartId,
      productId,
      buildReservationEntryJson(now, {
        cartId,
        customerId,
        quantity,
        status: 'CHECKOUT_PENDING',
        checkoutIdempotencyKey,
        checkoutPendingAt: now,
        checkoutPendingExpiresAt: now + 180_000,
        expiresAt,
        absoluteExpiresAt,
      }),
    );
    await client.sadd(productIndexKey(productId), cartId);
    await client.set(productTotalKey(productId), String(storedTotal));
  }

  it('restores a valid pending reservation to ACTIVE, clearing checkout fields and preserving expiresAt/absoluteExpiresAt', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    const now = Date.now();
    const expiresAt = now + 500_000;
    const absoluteExpiresAt = now + 3_000_000;

    await seedPendingWithAccounting(
      cartId,
      productId,
      customerId,
      checkoutIdempotencyKey,
      3,
      expiresAt,
      absoluteExpiresAt,
      3,
      now,
    );

    const result = await recovery.checkoutRevert(cartId, checkoutIdempotencyKey, now);

    expect(result).toEqual({
      ok: true,
      restoredProductIds: [productId],
      deletedProductIds: [],
      skippedProductIds: [],
      malformedProductIds: [],
      versionMismatchedProductIds: [],
      underflow: [],
      admissionSuspended: false,
    });

    const after = await getRawCheckoutFields(client, cartId, productId);
    expect(after?.status).toBe('ACTIVE');
    expect(after?.checkoutIdempotencyKey).toBeNull();
    expect(after?.checkoutPendingAt).toBeNull();
    expect(after?.checkoutPendingExpiresAt).toBeNull();
    expect(after?.expiresAt).toBe(expiresAt);
    expect(after?.absoluteExpiresAt).toBe(absoluteExpiresAt);
    // Restoring never touches quantity or the product-total projection.
    expect(after?.quantity).toBe(3);
    expect(await getStoredTotal(client, productId)).toBe('3');
  });

  it('deletes an expired pending reservation, cleans both indexes, and decrements the product total exactly once', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    const now = Date.now();

    await seedPendingWithAccounting(
      cartId,
      productId,
      customerId,
      checkoutIdempotencyKey,
      4,
      now - 1_000,
      now + 3_000_000,
      10,
      now,
    );

    const result = await recovery.checkoutRevert(cartId, checkoutIdempotencyKey, now);

    expect(result).toEqual({
      ok: true,
      restoredProductIds: [],
      deletedProductIds: [productId],
      skippedProductIds: [],
      malformedProductIds: [],
      versionMismatchedProductIds: [],
      underflow: [],
      admissionSuspended: false,
    });

    expect(await getRawCheckoutFields(client, cartId, productId)).toBeNull();
    expect(await getCartIndexMembers(client, cartId)).toEqual([]);
    expect(await getProductIndexMembers(client, productId)).toEqual([]);
    expect(await getStoredTotal(client, productId)).toBe('6');
  });

  it('is a no-op on a duplicate revert call after the first has already resolved everything', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    const now = Date.now();

    await seedPendingWithAccounting(
      cartId,
      productId,
      customerId,
      checkoutIdempotencyKey,
      2,
      now - 1_000,
      now + 3_000_000,
      2,
      now,
    );

    const first = await recovery.checkoutRevert(cartId, checkoutIdempotencyKey, now);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.deletedProductIds).toEqual([productId]);
    }

    const second = await recovery.checkoutRevert(cartId, checkoutIdempotencyKey, now);

    expect(second).toEqual({
      ok: true,
      restoredProductIds: [],
      deletedProductIds: [],
      skippedProductIds: [],
      malformedProductIds: [],
      versionMismatchedProductIds: [],
      underflow: [],
      admissionSuspended: false,
    });
    expect(await getStoredTotal(client, productId)).toBe('0');
  });
});
