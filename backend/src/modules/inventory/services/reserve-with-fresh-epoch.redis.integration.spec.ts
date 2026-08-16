import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { RESERVATION_TTL_SECONDS } from '../constants/inventory.constants';
import { CartScopedReservationEntry, InventoryReservationsService } from './inventory-reservations.service';
import { cleanupKeys, connectRealRedis, getRawReservation, ids, trackKeysFor } from './inventory-reservations.redis-test-helpers';

// CART_SCOPED activation-boundary gate (see the gate design review's final,
// approved atomic fresh-reservation primitive). Real-Redis proof of the
// additive forceFreshEpoch branch in RESERVE_OR_RENEW_SCRIPT, exposed only
// via reserveWithFreshEpoch - never release-then-recreate, never a second
// accounting script. Dedicated isolated DB index - see the sibling
// concurrency/recovery specs' own comments for why 1-8 are already
// claimed.
const ISOLATED_DB_INDEX = 9;

jest.setTimeout(20_000);

describe('InventoryReservationsService.reserveWithFreshEpoch (real Redis)', () => {
  let client: Redis;
  let service: InventoryReservationsService;
  const createdKeys = new Set<string>();

  beforeAll(async () => {
    client = await connectRealRedis();
    await client.select(ISOLATED_DB_INDEX);
    service = new InventoryReservationsService(new RedisService(client));
  });

  afterAll(async () => {
    await client.flushdb();
    await client.quit();
  });

  afterEach(async () => {
    await cleanupKeys(client, createdKeys);
    createdKeys.clear();
  });

  it('yields the exact desired quantity plus a demonstrably fresh ~15-minute expiry on a fresh entry', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    const before = Date.now();
    const result = await service.reserveWithFreshEpoch(cartId, productId, customerId, 7);
    const after = Date.now();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.entry.quantity).toBe(7);
    expect(result.result.underflow).toBeNull();
    // Deterministic given a freshly-reset absoluteExpiresAt: expiresAt is
    // exactly min(now + 900s, now + 3600s) = now + 900s, never capped.
    expect(result.result.entry.expiresAt).toBeGreaterThanOrEqual(before + RESERVATION_TTL_SECONDS * 1000);
    expect(result.result.entry.expiresAt).toBeLessThanOrEqual(after + RESERVATION_TTL_SECONDS * 1000);
  });

  it('resets createdAt/absoluteExpiresAt on an EXISTING entry - the exact gap release-then-recreate existed to avoid without a two-step operation', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);

    const first = await service.reserveOrRenew(cartId, productId, customerId, 3);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const originalAbsoluteExpiresAt = first.result.entry.absoluteExpiresAt;

    // Simulate an old entry close to its absolute cap by rewriting it
    // in-place with an old createdAt/absoluteExpiresAt.
    const staleAbsoluteExpiresAt = Date.now() + 5_000; // 5s from now - would leave almost no headroom under a plain renewal
    const raw = await getRawReservation(client, cartId, productId);
    const entry = JSON.parse(raw!) as CartScopedReservationEntry;
    entry.createdAt = Date.now() - 3_595_000;
    entry.absoluteExpiresAt = staleAbsoluteExpiresAt;
    await client.set(`inv:reserved:{${cartId}}:${productId}`, JSON.stringify(entry));

    const fresh = await service.reserveWithFreshEpoch(cartId, productId, customerId, 3);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.result.entry.absoluteExpiresAt).toBeGreaterThan(staleAbsoluteExpiresAt);
    expect(fresh.result.entry.expiresAt).toBeGreaterThan(Date.now() + RESERVATION_TTL_SECONDS * 1000 - 5_000);
    expect(fresh.result.entry.absoluteExpiresAt).not.toBe(originalAbsoluteExpiresAt);
  });

  it('CHECKOUT_IN_PROGRESS still blocks a fresh-epoch call exactly like an ordinary renewal', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);
    await service.reserveOrRenew(cartId, productId, customerId, 2);
    const raw = await getRawReservation(client, cartId, productId);
    const entry = JSON.parse(raw!) as CartScopedReservationEntry;
    entry.status = 'CHECKOUT_PENDING';
    await client.set(`inv:reserved:{${cartId}}:${productId}`, JSON.stringify(entry));

    const result = await service.reserveWithFreshEpoch(cartId, productId, customerId, 2);

    expect(result).toEqual({ ok: false, code: 'RESERVATION_CHECKOUT_IN_PROGRESS' });
  });

  it('failure before mutation leaves the old valid reservation completely intact (no partial application)', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);
    const original = await service.reserveOrRenew(cartId, productId, customerId, 5);
    expect(original.ok).toBe(true);
    const before = await getRawReservation(client, cartId, productId);

    // A malformed EVAL call (invalid Lua) never reaches the script's own
    // logic - Redis rejects the whole command atomically, proving there is
    // no intermediate, partially-applied state to reason about (unlike
    // the rejected release-then-recreate design, whose two separate EVAL
    // calls left exactly this kind of gap).
    await expect(client.eval('not valid lua {{{', 0)).rejects.toThrow();

    const after = await getRawReservation(client, cartId, productId);
    expect(after).toBe(before);
  });

  it('ordinary reserveOrRenew never sends forceFreshEpoch to the script - structural proof against accidental opt-in', async () => {
    const { cartId, productId, customerId } = ids();
    trackKeysFor(createdKeys, cartId, productId);
    const evalSpy = jest.spyOn(client, 'eval');

    await service.reserveOrRenew(cartId, productId, customerId, 1);

    const call = evalSpy.mock.calls.find((args) => typeof args[0] === 'string' && args[0].includes('forceFreshEpoch'));
    expect(call).toBeDefined();
    // ARGV order is [cartId, productId, customerId, quantity, now, rollingTtlMs, maxLifetimeMs, version, forceFreshEpoch]
    // - the script itself is the last argument in ioredis's eval(script, numKeys, ...keys, ...args) call shape.
    const forceFreshEpochArg = call![call!.length - 1];
    expect(forceFreshEpochArg).toBe('0');
    evalSpy.mockRestore();
  });
});
