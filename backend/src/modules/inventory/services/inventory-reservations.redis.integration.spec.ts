import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import {
  cartIndexKey,
  productIndexKey,
  productSuspectKey,
  productTotalKey,
  reservationKey,
} from '../constants/inventory.constants';
import { InventoryReservationsService } from './inventory-reservations.service';
import {
  cleanupKeys,
  connectRealRedis,
  getCartIndexMembers,
  getProductIndexMembers,
  getRawReservation,
  getStoredTotal,
  getSuspectFlag,
  ids,
  trackKeysFor,
} from './inventory-reservations.redis-test-helpers';

// Real-Redis integration coverage for the cart-scoped reservation model's
// core lifecycle and accounting: reserve/renew/release and availability.
// Reconciliation, malformed/version-mismatch handling, stale-index cleanup,
// and concurrency scenarios live in
// inventory-reservations-reconciliation.redis.integration.spec.ts.
//
// The unit suite (cart-scoped-reservations.service.spec.ts) mocks
// RedisService.eval and can only verify the TypeScript-to-Lua calling
// contract; it cannot exercise the Lua scripts' own arithmetic. This file
// runs the real scripts against a real Redis instance (no ioredis-mock
// exists in this repo) to prove the scripts themselves are correct.
//
// This suite requires a reachable Redis (REDIS_URL) and fails the whole
// file loudly if one is not available - it does not skip. CI already
// provisions a Redis service container for the backend job; local runs
// need Redis running at the configured REDIS_URL.
describe('InventoryReservationsService (real Redis integration - lifecycle/accounting)', () => {
  let client: Redis;
  let service: InventoryReservationsService;
  let createdKeys: Set<string>;

  beforeAll(async () => {
    client = await connectRealRedis();
    service = new InventoryReservationsService(new RedisService(client));
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

  it('1. first reservation: creates the entry, both indexes, and sets the total to the full quantity', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    const outcome = await service.reserveOrRenew(cartId, productId, customerId, 5);
    expect(outcome.ok).toBe(true);

    const rawEntry = await getRawReservation(client, cartId, productId);
    expect(rawEntry).not.toBeNull();
    const entry = JSON.parse(rawEntry!) as Record<string, unknown>;
    expect(entry.quantity).toBe(5);
    expect(entry.cartId).toBe(cartId);
    expect(entry.customerId).toBe(customerId);
    expect(entry.status).toBe('ACTIVE');
    expect(entry.version).toBe(1);

    expect(await getCartIndexMembers(client, cartId)).toEqual([productId]);
    expect(await getProductIndexMembers(client, productId)).toEqual([cartId]);
    expect(await getStoredTotal(client, productId)).toBe('5');
  });

  it('2. quantity increase: the total changes by the positive delta only', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    await service.reserveOrRenew(cartId, productId, customerId, 3);
    await service.reserveOrRenew(cartId, productId, customerId, 8);

    expect(await getStoredTotal(client, productId)).toBe('8');
  });

  it('3. quantity decrease: the total changes by the negative delta only', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    await service.reserveOrRenew(cartId, productId, customerId, 8);
    await service.reserveOrRenew(cartId, productId, customerId, 3);

    expect(await getStoredTotal(client, productId)).toBe('3');
  });

  it('4. no-op renewal: total, createdAt, and absoluteExpiresAt are all unchanged', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    const first = await service.reserveOrRenew(cartId, productId, customerId, 4);
    expect(first.ok).toBe(true);
    const firstEntry = first.ok ? first.result.entry : null;

    const second = await service.reserveOrRenew(cartId, productId, customerId, 4);
    expect(second.ok).toBe(true);

    if (firstEntry && second.ok) {
      expect(second.result.entry.createdAt).toBe(firstEntry.createdAt);
      expect(second.result.entry.absoluteExpiresAt).toBe(firstEntry.absoluteExpiresAt);
    }
    expect(await getStoredTotal(client, productId)).toBe('4');
  });

  it('5. repeated renewal: expiresAt never exceeds absoluteExpiresAt', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    let lastEntry: { expiresAt: number; absoluteExpiresAt: number } | undefined;
    for (let i = 0; i < 3; i += 1) {
      const outcome = await service.reserveOrRenew(cartId, productId, customerId, 2);
      if (outcome.ok) {
        lastEntry = outcome.result.entry;
      }
    }

    expect(lastEntry).toBeDefined();
    expect(lastEntry!.expiresAt).toBeLessThanOrEqual(lastEntry!.absoluteExpiresAt);
  });

  it('6. normal release: deletes the entry, cleans both indexes, subtracts the exact quantity', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    await service.reserveOrRenew(cartId, productId, customerId, 6);
    const result = await service.releaseReservation(cartId, productId);

    expect(result).toEqual({ released: true, quantity: 6, underflow: null });
    expect(await getRawReservation(client, cartId, productId)).toBeNull();
    expect(await getCartIndexMembers(client, cartId)).toEqual([]);
    expect(await getProductIndexMembers(client, productId)).toEqual([]);
    expect(await getStoredTotal(client, productId)).toBe('0');
  });

  it('7. duplicate release: no second decrement', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    await service.reserveOrRenew(cartId, productId, customerId, 6);
    await service.releaseReservation(cartId, productId);
    const second = await service.releaseReservation(cartId, productId);

    expect(second).toEqual({ released: false, quantity: 0, underflow: null });
    expect(await getStoredTotal(client, productId)).toBe('0');
  });

  it('8. underflow: the total is never clamped, the suspect flag is set, structured details are returned', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    await service.reserveOrRenew(cartId, productId, customerId, 10);
    // Simulate a pre-existing inconsistency unrelated to this call.
    await client.set(productTotalKey(productId), '3');

    const result = await service.releaseReservation(cartId, productId);

    expect(result.released).toBe(true);
    expect(result.underflow).toEqual({
      productId,
      cartId,
      reservationQuantity: 10,
      storedTotal: 3,
      operationName: 'releaseReservation',
      timestamp: expect.any(Number) as number,
    });
    expect(await getStoredTotal(client, productId)).toBe('3'); // untouched, not clamped
    expect(await getSuspectFlag(client, productId)).toBe('1');
  });

  it('9. suspect product: rejects new/increased reservations, permits decrease and release', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);
    const otherCart = randomUUID();
    createdKeys.add(reservationKey(otherCart, productId));

    await service.reserveOrRenew(cartId, productId, customerId, 5);
    await client.set(productSuspectKey(productId), '1');

    const rejectedNew = await service.reserveOrRenew(otherCart, productId, randomUUID(), 1);
    expect(rejectedNew).toEqual({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });

    const rejectedIncrease = await service.reserveOrRenew(cartId, productId, customerId, 8);
    expect(rejectedIncrease).toEqual({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });

    const allowedDecrease = await service.reserveOrRenew(cartId, productId, customerId, 2);
    expect(allowedDecrease.ok).toBe(true);

    const allowedRelease = await service.releaseReservation(cartId, productId);
    expect(allowedRelease.released).toBe(true);
  });

  it("10. availability: adds back the requesting cart's own quantity; empty cart context never throws", async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);
    const otherCart = randomUUID();
    createdKeys.add(reservationKey(otherCart, productId));

    await service.reserveOrRenew(cartId, productId, customerId, 4);
    await service.reserveOrRenew(otherCart, productId, randomUUID(), 3);

    await expect(service.getReservedTotalExcludingCart(productId, cartId)).resolves.toBe(3);
    await expect(service.computeAvailableToPurchase(productId, 10, cartId)).resolves.toBe(7);

    await expect(service.getReservedTotalExcludingCart(productId, '')).resolves.toBe(7);
    await expect(service.computeAvailableToPurchase(productId, 10, '')).resolves.toBe(3);
  });

  it('11. expired valid reservation: self-heals the entry, both indexes, and the total', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    const now = Date.now();
    const expiredEntry = {
      version: 1,
      quantity: 4,
      cartId,
      customerId,
      status: 'ACTIVE',
      createdAt: now - 100_000,
      lastRenewedAt: now - 100_000,
      expiresAt: now - 1000,
      absoluteExpiresAt: now + 1_000_000,
      checkoutIdempotencyKey: null,
      checkoutPendingAt: null,
      checkoutPendingExpiresAt: null,
    };
    await client.set(reservationKey(cartId, productId), JSON.stringify(expiredEntry));
    await client.sadd(cartIndexKey(cartId), productId);
    await client.sadd(productIndexKey(productId), cartId);
    await client.set(productTotalKey(productId), '4');

    const active = await service.getActiveReservation(cartId, productId);

    expect(active).toBeNull();
    expect(await getRawReservation(client, cartId, productId)).toBeNull();
    expect(await getCartIndexMembers(client, cartId)).toEqual([]);
    expect(await getProductIndexMembers(client, productId)).toEqual([]);
    expect(await getStoredTotal(client, productId)).toBe('0');
  });
});
