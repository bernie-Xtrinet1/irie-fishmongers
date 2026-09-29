import { RESERVATION_OBSERVATION_SCRIPT } from '../lua/reservation-observation-lua';
import { parseRedisObservation } from '../types/reservation-observation.types';
import { productControlKey } from '../../reservation-fence/types/product-reservation-restriction.types';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { productIndexKey, productTotalKey, productSuspectKey } from '../constants/inventory.constants';
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';

import { openOrdinaryAccountingFixture } from './ordinary-reservation-test-fixture';
import { reservationKey } from '../constants/inventory.constants';
import { InventoryReservationsService } from './inventory-reservations.service';
import {
  cleanupKeys,
  connectRealRedis,
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
  let authority: Awaited<ReturnType<typeof openOrdinaryAccountingFixture>>;
  jest.setTimeout(120000);
  let createdKeys: Set<string>;

  beforeAll(async () => {
    if (process.env.REDIS_URL !== 'redis://127.0.0.1:16479') throw new Error('Exact disposable Redis required');
    client = await connectRealRedis();
    authority = await openOrdinaryAccountingFixture(client);
    service = authority.service;
  });

  afterAll(async () => {
    try { await authority?.close(); } finally { await client?.quit(); }
  });

  beforeEach(() => {
    createdKeys = new Set<string>();
  });

  afterEach(async () => {
    await cleanupKeys(client, createdKeys);
  });

  it('12. malformed JSON: observes corruption without writing suspect state or deleting evidence', async () => {
    const { cartId, productId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    await client.set(reservationKey(cartId, productId), '{not valid json');

    const active = await service.getActiveReservation(cartId, productId);

    expect(active).toEqual({ status: 'MALFORMED' });
    expect(await getSuspectFlag(client, productId)).toBeNull();
    expect(await getRawReservation(client, cartId, productId)).toBe('{not valid json');
    expect(await getStoredTotal(client, productId)).toBeNull();
  });

  it('13. version mismatch: observes untrusted data and retains the entry without writing', async () => {
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

    expect(active).toEqual({ status: 'UNTRUSTED' });
    expect(await getSuspectFlag(client, productId)).toBeNull();
    expect(await getRawReservation(client, cartId, productId)).toBe(mismatched);
  });

  async function observe(productId: string, expected: string[] = []) {
    return parseRedisObservation(await client.eval(RESERVATION_OBSERVATION_SCRIPT, 5,
      productIndexKey(productId), productTotalKey(productId), productSuspectKey(productId),
      productControlKey(productId), RESERVATION_FENCE_KEY,
      productId, Date.now(), 100, JSON.stringify(expected)));
  }
  async function snapshot(productId: string) {
    const keys = [...createdKeys, productControlKey(productId), RESERVATION_FENCE_KEY].sort();
    return Promise.all(keys.map(async key => [key, await client.dump(key)]));
  }
  it.each([2, 20])('observes total %s drift without repairing accounting or suspect', async total => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);
    await authority.reserveWithIntent(cartId, productId, customerId, 5);
    await client.set(productTotalKey(productId), String(total));
    await client.set(productSuspectKey(productId), '1');
    const before = await snapshot(productId);
    const result = await observe(productId, [cartId]);
    expect(result.findings).toContain('QUANTITY_MISMATCH');
    expect(result.accounting.observedQuantityTotal).toBe(5);
    expect(await snapshot(productId)).toEqual(before);
  });
  it('retains stale membership and reports missing entry', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);
    await authority.reserveWithIntent(cartId, productId, customerId, 4);
    await client.del(reservationKey(cartId, productId));
    const before = await snapshot(productId);
    expect((await observe(productId)).findings).toContain('MISSING');
    expect(await snapshot(productId)).toEqual(before);
  });
  it('detects a known hold outside the index without adopting it', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);
    await authority.reserveWithIntent(cartId, productId, customerId, 4);
    await client.srem(productIndexKey(productId), cartId);
    const before = await snapshot(productId);
    expect((await observe(productId, [cartId])).findings).toContain('EXTRA');
    expect(await snapshot(productId)).toEqual(before);
  });
  it.each(['malformed', 'wrong-type', 'overflow', 'reciprocal-missing'])('observes %s with zero writes', async scenario => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);
    await authority.reserveWithIntent(cartId, productId, customerId, 4);
    if (scenario === 'malformed') await client.set(reservationKey(cartId, productId), '{broken');
    if (scenario === 'wrong-type') { await client.del(productIndexKey(productId)); await client.set(productIndexKey(productId), 'wrong'); }
    if (scenario === 'overflow') await client.sadd(productIndexKey(productId), ...Array.from({ length: 101 }, () => randomUUID()));
    if (scenario === 'reciprocal-missing') await client.del('inv:reserved:cart-index:{' + cartId + '}');
    const before = await snapshot(productId);
    expect((await observe(productId, [cartId])).findings).toContain('MEMBERSHIP_UNCERTAIN');
    expect(await snapshot(productId)).toEqual(before);
  });
  it('concurrent observers preserve identical physical state', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);
    await authority.reserveWithIntent(cartId, productId, customerId, 3);
    const before = await snapshot(productId);
    await Promise.all([observe(productId), observe(productId)]);
    expect(await snapshot(productId)).toEqual(before);
  });
  it('17. concurrent reserve operations: the final total equals the sum of active quantities', async () => {
    const productId = randomUUID();
    const carts = Array.from({ length: 5 }, () => randomUUID());
    carts.forEach((cartId) => trackKeysFor(createdKeys, cartId, productId));

    await Promise.all(
      carts.map((cartId) => authority.reserveWithIntent(cartId, productId, randomUUID(), 2)),
    );

    expect(await getStoredTotal(client, productId)).toBe(String(carts.length * 2));
  });

  it('observation concurrent with W1 does not lose the authorized update', async () => {
    const { cartId, productId, customerId } = ids();
    const otherCart = randomUUID();
    trackKeysFor(createdKeys, cartId, productId);
    trackKeysFor(createdKeys, otherCart, productId);
    await authority.reserveWithIntent(cartId, productId, customerId, 3);
    await Promise.all([observe(productId), authority.reserveWithIntent(otherCart, productId, randomUUID(), 4)]);
    expect((await observe(productId)).accounting.observedQuantityTotal).toBe(7);
    expect(await getStoredTotal(client, productId)).toBe('7');
  });
});
