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

// Real-Redis integration coverage for finalizeCheckoutConsumption (Unit
// 2.4.3): matching-key pending consumption (deletion, index cleanup,
// total decrement), duplicate-finalize/concurrent idempotency,
// ACTIVE/wrong-key skips, malformed/version-mismatch preservation, and
// underflow handling identical to checkoutRevert's.
describe('CheckoutReservationRecoveryService.finalizeCheckoutConsumption (real Redis integration)', () => {
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
      }),
    );
    await client.sadd(productIndexKey(productId), cartId);
    await client.set(productTotalKey(productId), String(storedTotal));
  }

  it('deletes matching pending entries, cleans both indexes, and decrements the total exactly once', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productIds = [`product-${Math.random()}`, `product-${Math.random()}`];
    const now = Date.now();

    await seedPendingWithAccounting(cartId, productIds[0]!, customerId, checkoutIdempotencyKey, 2, 2, now);
    await seedPendingWithAccounting(cartId, productIds[1]!, customerId, checkoutIdempotencyKey, 3, 3, now);

    const result = await recovery.finalizeCheckoutConsumption(cartId, checkoutIdempotencyKey);

    expect(result).toEqual({
      ok: true,
      finalizedProductIds: [...productIds].sort(),
      skippedProductIds: [],
      malformedProductIds: [],
      versionMismatchedProductIds: [],
      underflow: [],
      admissionSuspended: false,
    });

    for (const productId of productIds) {
      expect(await getRawCheckoutFields(client, cartId, productId)).toBeNull();
      expect(await getProductIndexMembers(client, productId)).toEqual([]);
    }
    expect(await getCartIndexMembers(client, cartId)).toEqual([]);
    expect(await getStoredTotal(client, productIds[0]!)).toBe('0');
    expect(await getStoredTotal(client, productIds[1]!)).toBe('0');
  });

  it('is a no-op on a duplicate finalize call, and remains idempotent under concurrent duplicate calls', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    const now = Date.now();

    await seedPendingWithAccounting(cartId, productId, customerId, checkoutIdempotencyKey, 5, 5, now);

    const first = await recovery.finalizeCheckoutConsumption(cartId, checkoutIdempotencyKey);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.finalizedProductIds).toEqual([productId]);
    }

    const [second, third] = await Promise.all([
      recovery.finalizeCheckoutConsumption(cartId, checkoutIdempotencyKey),
      recovery.finalizeCheckoutConsumption(cartId, checkoutIdempotencyKey),
    ]);

    for (const outcome of [second, third]) {
      expect(outcome).toEqual({
        ok: true,
        finalizedProductIds: [],
        skippedProductIds: [],
        malformedProductIds: [],
        versionMismatchedProductIds: [],
        underflow: [],
        admissionSuspended: false,
      });
    }
    expect(await getStoredTotal(client, productId)).toBe('0');
  });

  it('skips an ACTIVE member and a member owned by a different checkout key, leaving both untouched', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const activeId = `product-${Math.random()}`;
    const differentKeyId = `product-${Math.random()}`;
    const now = Date.now();
    trackKeysFor(createdKeys, cartId, activeId);
    trackKeysFor(createdKeys, cartId, differentKeyId);

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

    const result = await recovery.finalizeCheckoutConsumption(cartId, checkoutIdempotencyKey);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skippedProductIds).toEqual([activeId, differentKeyId].sort());
      expect(result.finalizedProductIds).toEqual([]);
    }
    expect((await getRawCheckoutFields(client, cartId, activeId))?.status).toBe('ACTIVE');
    expect((await getRawCheckoutFields(client, cartId, differentKeyId))?.status).toBe('CHECKOUT_PENDING');
  });

  it('preserves malformed/version-mismatched entries and reports them, without touching totals', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const malformedId = `product-${Math.random()}`;
    const versionMismatchId = `product-${Math.random()}`;
    const now = Date.now();
    trackKeysFor(createdKeys, cartId, malformedId);
    trackKeysFor(createdKeys, cartId, versionMismatchId);

    const malformedRaw = '{not valid json';
    await seedRawReservation(client, cartId, malformedId, malformedRaw);
    await client.set(productTotalKey(malformedId), '7');
    await seedRawReservation(
      client,
      cartId,
      versionMismatchId,
      buildReservationEntryJson(now, { cartId, customerId, version: 2, status: 'ACTIVE' }),
    );
    await client.set(productTotalKey(versionMismatchId), '8');

    const result = await recovery.finalizeCheckoutConsumption(cartId, checkoutIdempotencyKey);

    expect(result).toEqual({
      ok: true,
      finalizedProductIds: [],
      skippedProductIds: [],
      malformedProductIds: [malformedId],
      versionMismatchedProductIds: [versionMismatchId],
      underflow: [],
      admissionSuspended: true,
    });
    expect(await getRawReservationValue(client, cartId, malformedId)).toBe(malformedRaw);
    expect(await getSuspectFlag(client, malformedId)).toBe('1');
    expect(await getSuspectFlag(client, versionMismatchId)).toBe('1');
    expect(await getStoredTotal(client, malformedId)).toBe('7');
    expect(await getStoredTotal(client, versionMismatchId)).toBe('8');
  });

  it('handles underflow identically to checkoutRevert: never clamps, sets suspect, and reports it', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    const now = Date.now();

    await seedPendingWithAccounting(cartId, productId, customerId, checkoutIdempotencyKey, 9, 2, now);

    const result = await recovery.finalizeCheckoutConsumption(cartId, checkoutIdempotencyKey);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.finalizedProductIds).toEqual([productId]);
      expect(result.underflow).toEqual([
        expect.objectContaining({
          productId,
          cartId,
          reservationQuantity: 9,
          storedTotal: 2,
          operationName: 'finalizeCheckoutConsumption',
        }),
      ]);
      expect(result.admissionSuspended).toBe(true);
    }
    expect(await getStoredTotal(client, productId)).toBe('2');
    expect(await getSuspectFlag(client, productId)).toBe('1');
    expect(await getRawCheckoutFields(client, cartId, productId)).toBeNull();
  });

  it('never mutates any durable Prisma/Product record - structurally, no Prisma import exists in the recovery module', () => {
    const fs = jest.requireActual<typeof import('fs')>('fs');
    const path = jest.requireActual<typeof import('path')>('path');
    const serviceSource = fs.readFileSync(
      path.resolve(__dirname, 'checkout-reservation-recovery.service.ts'),
      'utf8',
    );
    const revertLuaSource = fs.readFileSync(
      path.resolve(__dirname, '../lua/checkout-revert-lua-scripts.ts'),
      'utf8',
    );
    const finalizeLuaSource = fs.readFileSync(
      path.resolve(__dirname, '../lua/checkout-finalize-lua-scripts.ts'),
      'utf8',
    );

    expect(serviceSource).not.toMatch(/prisma/i);
    expect(revertLuaSource).not.toMatch(/prisma/i);
    expect(finalizeLuaSource).not.toMatch(/prisma/i);
  });
});
