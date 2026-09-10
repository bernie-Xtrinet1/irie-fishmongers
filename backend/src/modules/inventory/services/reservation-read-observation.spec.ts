import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { assertDisposableEnvironment, withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { CartMutationBarrierConfigRepository } from '../../cart-mutation-barrier/repositories/cart-mutation-barrier-config.repository';
import { ReservationEngineModeConfigRepository } from '../../reservation-engine-mode/repositories/reservation-engine-mode-config.repository';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { cartIndexKey, productIndexKey, productSuspectKey, productTotalKey, reservationKey } from '../constants/inventory.constants';
import { InventoryReservationsService } from './inventory-reservations.service';
import { observeReservation } from './reservation-read-observation';

function entry(cartId: string) {
  const now = Date.now();
  return { version: 1, quantity: 4, cartId, customerId: randomUUID(), status: 'ACTIVE',
    createdAt: now - 1000, lastRenewedAt: now - 1000, expiresAt: now + 60000, absoluteExpiresAt: now + 3600000,
    checkoutIdempotencyKey: null, checkoutPendingAt: null, checkoutPendingExpiresAt: null };
}

describe('G.4b.2b.1 bounded reservation observations', () => {
  it.each(['null', '[]', '42', '"payload"', '{', '{}'])('does not interpret %s as ordinary absence', raw => {
    expect(['MALFORMED', 'UNTRUSTED']).toContain(observeReservation(raw, 'cart-1', Date.now()).status);
  });
  it.each([
    { quantity: -1 }, { quantity: 1.5 }, { expiresAt: 'future' }, { expiresAt: null },
    { status: 'UNKNOWN' }, { cartId: 'other' }, { customerId: null }, { version: 2 },
    { checkoutPendingAt: 1 }, { status: 'CHECKOUT_PENDING' },
  ])('rejects malformed/untrusted shape %# without returning payload', changes => {
    const observed = observeReservation(JSON.stringify({ ...entry('cart-1'), ...changes, secret: 'must-not-escape' }), 'cart-1', Date.now());
    expect(['MALFORMED', 'UNTRUSTED']).toContain(observed.status);
    expect(Object.keys(observed)).toEqual(['status']);
  });
  it('projects valid fields only and distinguishes absent/expired', () => {
    const value = entry('cart-1');
    expect(observeReservation(JSON.stringify({ ...value, secret: 'must-not-escape' }), 'cart-1', Date.now()))
      .toEqual({ status: 'ACTIVE', entry: value });
    expect(observeReservation(null, 'cart-1', Date.now())).toEqual({ status: 'ABSENT' });
    expect(observeReservation(JSON.stringify({ ...value, expiresAt: Date.now() - 1 }), 'cart-1', Date.now()))
      .toEqual({ status: 'EXPIRED' });
  });
  it('propagates transport uncertainty through observation and availability', async () => {
    const error = new Error('SIMULATED_REDIS_UNCERTAINTY');
    const redis = { get: jest.fn().mockRejectedValue(error) };
    const service = new InventoryReservationsService(redis as unknown as RedisService);
    await expect(service.getActiveReservation('cart-1', 'product-1')).rejects.toBe(error);
    await expect(service.getAvailabilityWithSuspectStatus('product-1', 10, 'cart-1')).rejects.toBe(error);
    await expect(service.computeAvailableToPurchase('product-1', 10, 'cart-1')).rejects.toBe(error);
  });
  it('retains a valid checkout-pending representation as an unexpired observation', () => {
    const now = Date.now();
    const value = { ...entry('cart-1'), status: 'CHECKOUT_PENDING', checkoutIdempotencyKey: 'checkout-1',
      checkoutPendingAt: now, checkoutPendingExpiresAt: now + 30000 };
    expect(observeReservation(JSON.stringify(value), 'cart-1', now)).toEqual({ status: 'ACTIVE', entry: value });
  });
  it.each(['NaN', '-1', '1.5', '', 'Infinity'])('does not trust total %s', async total => {
    const redis = { get: jest.fn().mockResolvedValue(total) };
    const service = new InventoryReservationsService(redis as unknown as RedisService);
    expect(await service.getReservedTotalExcludingCart('product-1', '')).toEqual({ status: 'SUSPECT' });
  });
});

describe('G.4b.2b.1 real Redis reads never mutate', () => {
  it.each(['ACTIVE', 'ABSENT', 'EXPIRED', 'MALFORMED', 'UNTRUSTED'] as const)
    ('repeated %s reads, availability and rollback leave every fixture key unchanged', status => isolated(async f => {
      const value = entry(f.cartId);
      const raw = status === 'ABSENT' ? null : status === 'MALFORMED' ? '{broken' : JSON.stringify({ ...value,
        ...(status === 'EXPIRED' ? { expiresAt: Date.now() - 1 } : {}),
        ...(status === 'UNTRUSTED' ? { version: 9 } : {}) });
      if (raw !== null) {
        await f.redis.set(reservationKey(f.cartId, f.productId), raw);
        await f.redis.sadd(cartIndexKey(f.cartId), f.productId);
        await f.redis.sadd(productIndexKey(f.productId), f.cartId);
      }
      await f.redis.set(productTotalKey(f.productId), '4');
      const before = await f.snapshot();
      for (let i = 0; i < 3; i++) {
        expect((await f.service.getActiveReservation(f.cartId, f.productId)).status).toBe(status);
        const untrusted = status === 'MALFORMED' || status === 'UNTRUSTED';
        expect(await f.service.getAvailabilityWithSuspectStatus(f.productId, 10, f.cartId)).toEqual(untrusted
          ? { status: 'SUSPECT' } : { status: 'OK', available: status === 'ACTIVE' ? 10 : 6 });
        expect(await f.service.computeAvailableToPurchase(f.productId, 10, f.cartId)).toBe(untrusted ? 0 : status === 'ACTIVE' ? 10 : 6);
        const rollback = await f.mode.verifyRollbackSafe();
        expect(rollback.clear).toBe(false);
        expect(status === 'ACTIVE' ? rollback.outstandingProductIds : rollback.structureDriftProductIds).toContain(f.productId);
        expect(await f.snapshot()).toEqual(before);
      }
      expect(f.release).not.toHaveBeenCalled();
    }));
  it('an indexed expired hold with zero total still blocks rollback', () => isolated(async f => {
    await f.redis.set(reservationKey(f.cartId, f.productId), JSON.stringify({ ...entry(f.cartId), expiresAt: Date.now() - 1 }));
    await f.redis.sadd(cartIndexKey(f.cartId), f.productId);
    await f.redis.set(productTotalKey(f.productId), '0');
    const before = await f.snapshot();
    expect((await f.mode.verifyRollbackSafe()).structureDriftProductIds).toContain(f.productId);
    expect(await f.snapshot()).toEqual(before);
  }));
  it('WRONGTYPE remains an error, never absence or a successful rollback proof', () => isolated(async f => {
    await f.redis.hset(reservationKey(f.cartId, f.productId), 'bad', 'shape');
    await f.redis.sadd(cartIndexKey(f.cartId), f.productId);
    const before = await f.snapshot();
    await expect(f.service.getActiveReservation(f.cartId, f.productId)).rejects.toThrow('WRONGTYPE');
    await expect(f.mode.verifyRollbackSafe()).rejects.toThrow('WRONGTYPE');
    expect(await f.snapshot()).toEqual(before);
  }));
  it('a valid cart cannot hide malformed state for the same product during rollback', () => isolated(async f => {
    const otherCart = randomUUID();
    const otherKeys = [reservationKey(otherCart, f.productId), cartIndexKey(otherCart)];
    await withCleanup(async () => {
      await f.redis.set(reservationKey(f.cartId, f.productId), JSON.stringify(entry(f.cartId)));
      await f.redis.sadd(cartIndexKey(f.cartId), f.productId);
      await f.redis.set(productTotalKey(f.productId), '4');
      await f.redis.set(otherKeys[0]!, '{broken');
      await f.redis.sadd(otherKeys[1]!, f.productId);
      const snapshot = () => Promise.all([...otherKeys].map(key => f.redis.dump(key)));
      const before = await snapshot();
      expect((await f.mode.verifyRollbackSafe()).structureDriftProductIds).toContain(f.productId);
      expect(await snapshot()).toEqual(before);
    }, [() => f.redis.del(...otherKeys)]);
  }));
});

async function isolated(work: (f: {
  redis: Redis; service: InventoryReservationsService; mode: ReservationEngineModeService;
  cartId: string; productId: string; snapshot: () => Promise<(string | null)[]>; release: jest.SpyInstance;
}) => Promise<void>) {
  assertDisposableEnvironment();
  const redis = new Redis(process.env.REDIS_URL!);
  const cartId = randomUUID(), productId = randomUUID();
  const keys = [reservationKey(cartId, productId), cartIndexKey(cartId), productIndexKey(productId),
    productTotalKey(productId), productSuspectKey(productId)];
  const adapter = new RedisService(redis);
  const service = new InventoryReservationsService(adapter);
  // verifyRollbackSafe is observational and does not access these PG dependencies.
  const mode = new ReservationEngineModeService({} as PrismaService, {} as ReservationEngineModeConfigRepository,
    adapter, service, {} as CartMutationBarrierConfigRepository);
  const release = jest.spyOn(service, 'releaseReservation');
  return withCleanup(() => work({ redis, service, mode, cartId, productId, release,
    snapshot: () => Promise.all(keys.map(key => redis.dump(key))) }), [async () => {
    try { await redis.del(...keys); } finally { release.mockRestore(); await redis.quit(); }
  }]);
}
