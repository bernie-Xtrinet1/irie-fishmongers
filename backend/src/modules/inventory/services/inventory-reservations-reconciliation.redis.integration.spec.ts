import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { reservationKey } from '../constants/inventory.constants';
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

// Real-Redis integration coverage for malformed/version-mismatched entry
// handling, product reserved-total reconciliation, stale-index cleanup,
// and concurrency. Core reserve/renew/release/availability lifecycle
// coverage lives in inventory-reservations.redis.integration.spec.ts.
//
// This suite requires a reachable Redis (REDIS_URL) and fails the whole
// file loudly if one is not available - it does not skip. See
// inventory-reservations.redis.integration.spec.ts for the rationale.
describe('InventoryReservationsService (real Redis integration - reconciliation)', () => {
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

  it('12. malformed JSON: sets suspect, never guesses a quantity, never deletes the evidence', async () => {
    const { cartId, productId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    await client.set(reservationKey(cartId, productId), '{not valid json');

    const active = await service.getActiveReservation(cartId, productId);

    expect(active).toBeNull();
    expect(await getSuspectFlag(client, productId)).toBe('1');
    expect(await getRawReservation(client, cartId, productId)).toBe('{not valid json');
    expect(await getStoredTotal(client, productId)).toBeNull();
  });

  it('13. version mismatch: sets suspect and retains the entry for diagnostics', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    const mismatched = JSON.stringify({
      version: 2,
      quantity: 4,
      cartId,
      customerId,
      status: 'ACTIVE',
      createdAt: Date.now(),
      lastRenewedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      absoluteExpiresAt: Date.now() + 3_600_000,
      checkoutIdempotencyKey: null,
      checkoutPendingAt: null,
      checkoutPendingExpiresAt: null,
    });
    await client.set(reservationKey(cartId, productId), mismatched);

    const active = await service.getActiveReservation(cartId, productId);

    expect(active).toBeNull();
    expect(await getSuspectFlag(client, productId)).toBe('1');
    expect(await getRawReservation(client, cartId, productId)).toBe(mismatched);
  });

  it('14. reconciliation OVERCOUNT: writes the calculated total, admission is not suspended', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    await service.reserveOrRenew(cartId, productId, customerId, 5);
    await client.set(`inv:reserved:product-total:{${productId}}`, '20');

    const result = await service.reconcileProductReservedTotal(productId);

    expect(result.driftDirection).toBe('OVERCOUNT');
    expect(result.calculatedTotal).toBe(5);
    expect(result.repairedValue).toBe(5);
    expect(result.admissionSuspended).toBe(false);
    expect(await getStoredTotal(client, productId)).toBe('5');
    expect(await getSuspectFlag(client, productId)).toBeNull();
  });

  it('15. reconciliation UNDERCOUNT: suspects before repair, verifies, clears suspect only after success', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    await service.reserveOrRenew(cartId, productId, customerId, 9);
    await client.set(`inv:reserved:product-total:{${productId}}`, '2');

    const result = await service.reconcileProductReservedTotal(productId);

    expect(result.driftDirection).toBe('UNDERCOUNT');
    expect(result.calculatedTotal).toBe(9);
    expect(result.repairedValue).toBe(9);
    expect(result.admissionSuspended).toBe(false);
    expect(await getStoredTotal(client, productId)).toBe('9');
    expect(await getSuspectFlag(client, productId)).toBeNull();
  });

  it('16. stale product-index member: removed atomically, both indexes cleaned', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    await service.reserveOrRenew(cartId, productId, customerId, 4);
    await client.del(reservationKey(cartId, productId));

    const result = await service.reconcileProductReservedTotal(productId);

    expect(result.staleMembersRemoved).toBe(1);
    expect(await getProductIndexMembers(client, productId)).toEqual([]);
    expect(await getCartIndexMembers(client, cartId)).toEqual([]);
  });

  it('17. concurrent reserve operations: the final total equals the sum of active quantities', async () => {
    const productId = randomUUID();
    const carts = Array.from({ length: 5 }, () => randomUUID());
    carts.forEach((cartId) => trackKeysFor(createdKeys, cartId, productId));

    await Promise.all(
      carts.map((cartId) => service.reserveOrRenew(cartId, productId, randomUUID(), 2)),
    );

    expect(await getStoredTotal(client, productId)).toBe(String(carts.length * 2));
  });

  it('18. concurrent reconciliation and reservation mutation: no lost update, final total matches active reservations', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);
    const otherCart = randomUUID();
    createdKeys.add(reservationKey(otherCart, productId));

    await service.reserveOrRenew(cartId, productId, customerId, 3);

    await Promise.all([
      service.reconcileProductReservedTotal(productId),
      service.reserveOrRenew(otherCart, productId, randomUUID(), 4),
    ]);

    const verify = await service.reconcileProductReservedTotal(productId);
    expect(verify.driftDirection).toBe('NO_DRIFT');
    expect(verify.calculatedTotal).toBe(7);
    expect(await getStoredTotal(client, productId)).toBe('7');
  });
});
