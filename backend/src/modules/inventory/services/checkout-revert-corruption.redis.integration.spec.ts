import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { productIndexKey, productTotalKey } from '../constants/inventory.constants';
import {
  buildReservationEntryJson,
  checkoutIds,
  getRawCheckoutFields,
  getRawReservationValue,
  seedRawReservation,
} from './checkout-reservation-state.redis-test-helpers';
import { CheckoutReservationRecoveryService } from './checkout-reservation-recovery.service';
import {
  cleanupKeys,
  connectRealRedis,
  getCartIndexMembers,
  getProductIndexMembers,
  getStoredTotal,
  getSuspectFlag,
  trackKeysFor,
} from './inventory-reservations.redis-test-helpers';

// Real-Redis integration coverage for checkoutRevert's corruption/edge
// scenarios (Unit 2.4.3): ACTIVE/different-key skips, missing-member
// cleanup, malformed/version-mismatch preservation, underflow, and a
// mixed-corruption chaos cart proving one bad entry never blocks another.
// Baseline valid-restore/expired-delete scenarios live in
// checkout-revert.redis.integration.spec.ts - split per the Unit 2.4.3
// file-size rules.
describe('CheckoutReservationRecoveryService.checkoutRevert (real Redis integration - corruption)', () => {
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

  it('skips an ACTIVE member, leaving it untouched', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    const now = Date.now();
    trackKeysFor(createdKeys, cartId, productId);
    await seedRawReservation(
      client,
      cartId,
      productId,
      buildReservationEntryJson(now, { cartId, customerId, status: 'ACTIVE' }),
    );

    const result = await recovery.checkoutRevert(cartId, checkoutIdempotencyKey, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skippedProductIds).toEqual([productId]);
    }
    expect((await getRawCheckoutFields(client, cartId, productId))?.status).toBe('ACTIVE');
  });

  it('skips a pending member owned by a different checkout key, leaving it untouched', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    const now = Date.now();
    trackKeysFor(createdKeys, cartId, productId);
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

    const result = await recovery.checkoutRevert(cartId, checkoutIdempotencyKey, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skippedProductIds).toEqual([productId]);
    }
    const after = await getRawCheckoutFields(client, cartId, productId);
    expect(after?.status).toBe('CHECKOUT_PENDING');
    expect(after?.checkoutIdempotencyKey).toBe(`${checkoutIdempotencyKey}-other`);
  });

  it('cleans a stale cart-index member with no backing reservation, reporting nothing', async () => {
    const { cartId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    const now = Date.now();
    trackKeysFor(createdKeys, cartId, productId);
    await client.sadd('inv:reserved:cart-index:{' + cartId + '}', productId);

    const result = await recovery.checkoutRevert(cartId, checkoutIdempotencyKey, now);

    expect(result).toEqual({
      ok: true,
      restoredProductIds: [],
      deletedProductIds: [],
      skippedProductIds: [],
      malformedProductIds: [],
      versionMismatchedProductIds: [],
      underflow: [],
      admissionSuspended: false,
    });
    expect(await getCartIndexMembers(client, cartId)).toEqual([]);
  });

  it('preserves a malformed entry, sets its suspect flag, and reports it - without touching totals', async () => {
    const { cartId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    const now = Date.now();
    trackKeysFor(createdKeys, cartId, productId);
    const rawBefore = '{not valid json';
    await seedRawReservation(client, cartId, productId, rawBefore);
    await client.set(productTotalKey(productId), '5');

    const result = await recovery.checkoutRevert(cartId, checkoutIdempotencyKey, now);

    expect(result).toEqual({
      ok: true,
      restoredProductIds: [],
      deletedProductIds: [],
      skippedProductIds: [],
      malformedProductIds: [productId],
      versionMismatchedProductIds: [],
      underflow: [],
      admissionSuspended: true,
    });
    expect(await getRawReservationValue(client, cartId, productId)).toBe(rawBefore);
    expect(await getSuspectFlag(client, productId)).toBe('1');
    expect(await getStoredTotal(client, productId)).toBe('5');
  });

  it('preserves a version-mismatched entry, sets its suspect flag, and reports it - without touching totals', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    const now = Date.now();
    trackKeysFor(createdKeys, cartId, productId);
    const rawBefore = buildReservationEntryJson(now, {
      cartId,
      customerId,
      version: 2,
      status: 'ACTIVE',
    });
    await seedRawReservation(client, cartId, productId, rawBefore);
    await client.set(productTotalKey(productId), '5');

    const result = await recovery.checkoutRevert(cartId, checkoutIdempotencyKey, now);

    expect(result).toEqual({
      ok: true,
      restoredProductIds: [],
      deletedProductIds: [],
      skippedProductIds: [],
      malformedProductIds: [],
      versionMismatchedProductIds: [productId],
      underflow: [],
      admissionSuspended: true,
    });
    expect(await getRawReservationValue(client, cartId, productId)).toBe(rawBefore);
    expect(await getSuspectFlag(client, productId)).toBe('1');
    expect(await getStoredTotal(client, productId)).toBe('5');
  });

  it('never clamps an underflowing total: leaves it unchanged, sets suspect, and reports the underflow', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    const now = Date.now();
    trackKeysFor(createdKeys, cartId, productId);
    await seedRawReservation(
      client,
      cartId,
      productId,
      buildReservationEntryJson(now, {
        cartId,
        customerId,
        quantity: 10,
        status: 'CHECKOUT_PENDING',
        checkoutIdempotencyKey,
        checkoutPendingAt: now - 1_000,
        checkoutPendingExpiresAt: now - 500,
        expiresAt: now - 500,
      }),
    );
    await client.sadd(productIndexKey(productId), cartId);
    await client.set(productTotalKey(productId), '3'); // less than quantity=10

    const result = await recovery.checkoutRevert(cartId, checkoutIdempotencyKey, now);

    expect(result).toEqual({
      ok: true,
      restoredProductIds: [],
      deletedProductIds: [productId],
      skippedProductIds: [],
      malformedProductIds: [],
      versionMismatchedProductIds: [],
      underflow: [
        {
          productId,
          cartId,
          reservationQuantity: 10,
          storedTotal: 3,
          operationName: 'checkoutRevert',
          timestamp: now,
        },
      ],
      admissionSuspended: true,
    });
    // Never clamped to 0, never guessed - left exactly as it was.
    expect(await getStoredTotal(client, productId)).toBe('3');
    expect(await getSuspectFlag(client, productId)).toBe('1');
    // The entry itself, and its product-index membership, are still
    // removed despite the underflow - only the total arithmetic is
    // skipped.
    expect(await getRawCheckoutFields(client, cartId, productId)).toBeNull();
    expect(await getProductIndexMembers(client, productId)).toEqual([]);
  });

  it('recovers every independently-resolvable product in a mixed-corruption chaos cart, classifying each into its exact bucket', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const now = Date.now();
    const activeId = `product-${Math.random()}`;
    const differentKeyId = `product-${Math.random()}`;
    const missingId = `product-${Math.random()}`;
    const malformedId = `product-${Math.random()}`;
    const versionMismatchId = `product-${Math.random()}`;
    const restoreId = `product-${Math.random()}`;
    const deleteId = `product-${Math.random()}`;
    const productIds = [
      activeId,
      differentKeyId,
      missingId,
      malformedId,
      versionMismatchId,
      restoreId,
      deleteId,
    ];
    for (const productId of productIds) {
      trackKeysFor(createdKeys, cartId, productId);
    }

    await seedRawReservation(
      client,
      cartId,
      activeId,
      buildReservationEntryJson(now, { cartId, customerId, status: 'ACTIVE' }),
    );
    await seedRawReservation(
      client,
      cartId,
      differentKeyId,
      buildReservationEntryJson(now, {
        cartId,
        customerId,
        status: 'CHECKOUT_PENDING',
        checkoutIdempotencyKey: `${checkoutIdempotencyKey}-other`,
        checkoutPendingAt: now,
        checkoutPendingExpiresAt: now + 180_000,
      }),
    );
    await client.sadd('inv:reserved:cart-index:{' + cartId + '}', missingId);
    await seedRawReservation(client, cartId, malformedId, '{not valid json');
    await seedRawReservation(
      client,
      cartId,
      versionMismatchId,
      buildReservationEntryJson(now, { cartId, customerId, version: 2, status: 'ACTIVE' }),
    );
    await seedRawReservation(
      client,
      cartId,
      restoreId,
      buildReservationEntryJson(now, {
        cartId,
        customerId,
        status: 'CHECKOUT_PENDING',
        checkoutIdempotencyKey,
        checkoutPendingAt: now,
        checkoutPendingExpiresAt: now + 180_000,
        expiresAt: now + 500_000,
      }),
    );
    await seedRawReservation(
      client,
      cartId,
      deleteId,
      buildReservationEntryJson(now, {
        cartId,
        customerId,
        quantity: 2,
        status: 'CHECKOUT_PENDING',
        checkoutIdempotencyKey,
        checkoutPendingAt: now - 1_000,
        checkoutPendingExpiresAt: now - 500,
        expiresAt: now - 500,
      }),
    );
    await client.sadd(productIndexKey(deleteId), cartId);
    await client.set(productTotalKey(deleteId), '2');

    const result = await recovery.checkoutRevert(cartId, checkoutIdempotencyKey, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.restoredProductIds).toEqual([restoreId]);
      expect(result.deletedProductIds).toEqual([deleteId]);
      expect(result.skippedProductIds).toEqual([activeId, differentKeyId].sort());
      expect(result.malformedProductIds).toEqual([malformedId]);
      expect(result.versionMismatchedProductIds).toEqual([versionMismatchId]);
      expect(result.underflow).toEqual([]);
      expect(result.admissionSuspended).toBe(true); // malformed/version-mismatch set suspect
    }
    // One bad member (malformed) never blocked the valid ones' recovery.
    expect((await getRawCheckoutFields(client, cartId, restoreId))?.status).toBe('ACTIVE');
    expect(await getRawCheckoutFields(client, cartId, deleteId)).toBeNull();
    expect(await getStoredTotal(client, deleteId)).toBe('0');
  });

  it('reports admissionSuspended true from any combination of suspect-triggering products, each in its correct bucket', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const now = Date.now();
    const malformedId = `product-${Math.random()}`;
    const versionMismatchId = `product-${Math.random()}`;
    const underflowId = `product-${Math.random()}`;
    trackKeysFor(createdKeys, cartId, malformedId);
    trackKeysFor(createdKeys, cartId, versionMismatchId);
    trackKeysFor(createdKeys, cartId, underflowId);

    await seedRawReservation(client, cartId, malformedId, '{not valid json');
    await seedRawReservation(
      client,
      cartId,
      versionMismatchId,
      buildReservationEntryJson(now, { cartId, customerId, version: 2, status: 'ACTIVE' }),
    );
    await seedRawReservation(
      client,
      cartId,
      underflowId,
      buildReservationEntryJson(now, {
        cartId,
        customerId,
        quantity: 6,
        status: 'CHECKOUT_PENDING',
        checkoutIdempotencyKey,
        checkoutPendingAt: now - 1_000,
        checkoutPendingExpiresAt: now - 500,
        expiresAt: now - 500,
      }),
    );
    await client.sadd(productIndexKey(underflowId), cartId);
    await client.set(productTotalKey(underflowId), '1'); // less than quantity=6

    const result = await recovery.checkoutRevert(cartId, checkoutIdempotencyKey, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Every distinct suspect-triggering condition lands in its own,
      // correct bucket - none conflated with another.
      expect(result.malformedProductIds).toEqual([malformedId]);
      expect(result.versionMismatchedProductIds).toEqual([versionMismatchId]);
      expect(result.deletedProductIds).toEqual([underflowId]);
      expect(result.underflow).toEqual([
        expect.objectContaining({ productId: underflowId, reservationQuantity: 6, storedTotal: 1 }),
      ]);
      // True from the OR of all three conditions, not merely
      // underflow.length > 0 - falsifiable by the malformed-only and
      // version-mismatch-only tests above, which report admissionSuspended
      // true with an empty underflow array.
      expect(result.admissionSuspended).toBe(true);
    }
    expect(await getSuspectFlag(client, malformedId)).toBe('1');
    expect(await getSuspectFlag(client, versionMismatchId)).toBe('1');
    expect(await getSuspectFlag(client, underflowId)).toBe('1');
  });
});
