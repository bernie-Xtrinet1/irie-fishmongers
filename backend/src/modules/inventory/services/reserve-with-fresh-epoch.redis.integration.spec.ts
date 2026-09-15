import { Redis } from 'ioredis';
import { RedisService } from '../../../common/redis/redis.service';
import { InventoryReservationsService } from './inventory-reservations.service';
import { reservationKey, productTotalKey, cartIndexKey, productIndexKey } from '../constants/inventory.constants';
import { cleanupKeys, connectRealRedis, ids, trackKeysFor, seedHistoricalActiveReservation } from './inventory-reservations.redis-test-helpers';

// Hard-lifetime reset is not one of the approved W1 transitions. Until it has
// its own explicit authority, the old administrative entry point is fail-closed.
describe('administrative freshness reset remains deferred under W1 fencing', () => {
  let redis: Redis;
  let service: InventoryReservationsService;
  const keys = new Set<string>();
  beforeAll(async () => {
    redis = await connectRealRedis();
    service = new InventoryReservationsService(new RedisService(redis));
  });
  afterAll(async () => {
    try { if (redis) await cleanupKeys(redis, keys); } finally { if (redis) await redis.quit(); }
  });
  it.each(['absent', 'active', 'near-hard-limit', 'checkout-pending', 'malformed'] as const)
    ('rejects %s with no physical effect or implicit rolling renewal', async state => {
      const { cartId, productId, customerId } = ids();
      trackKeysFor(keys, cartId, productId);
      if (state !== 'absent') {
        await seedHistoricalActiveReservation(redis, cartId, productId, customerId, 3);
        const entry = JSON.parse((await redis.get(reservationKey(cartId, productId)))!) as Record<string, unknown>;
        if (state === 'near-hard-limit') entry.absoluteExpiresAt = Date.now() + 1000;
        if (state === 'checkout-pending') { entry.status = 'CHECKOUT_PENDING'; entry.checkoutIdempotencyKey = 'existing-owner'; }
        await redis.set(reservationKey(cartId, productId), state === 'malformed' ? '{' : JSON.stringify(entry));
      }
      const snapshot = () => Promise.all([redis.get(reservationKey(cartId, productId)), redis.get(productTotalKey(productId)),
        redis.smembers(cartIndexKey(cartId)), redis.smembers(productIndexKey(productId))]);
      const before = await snapshot();
      expect(await service.reserveWithFreshEpoch(cartId, productId, customerId, 7)).toEqual({ ok: false, code: 'FENCE_REJECTED' });
      expect(await snapshot()).toEqual(before);
    });
});
