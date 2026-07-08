import { RedisService } from '../../../common/redis/redis.service';
import { RESERVATION_HASH_TTL_SECONDS } from '../constants/inventory.constants';
import { InventoryReservationsService } from './inventory-reservations.service';

function entryJson(quantity: number, expiresAt: number): string {
  return JSON.stringify({ quantity, expiresAt });
}

describe('InventoryReservationsService', () => {
  let redis: jest.Mocked<Pick<RedisService, 'hset' | 'hget' | 'hgetall' | 'hdel' | 'expire'>>;
  let service: InventoryReservationsService;

  beforeEach(() => {
    redis = {
      hset: jest.fn(),
      hget: jest.fn(),
      hgetall: jest.fn(),
      hdel: jest.fn(),
      expire: jest.fn(),
    };
    service = new InventoryReservationsService(redis as unknown as RedisService);
  });

  describe('reservation expiration', () => {
    it('ignores an expired reservation entirely when computing availability', async () => {
      const expiredEntry = entryJson(5, Date.now() - 1000);
      redis.hgetall.mockResolvedValue({ 'cart-other': expiredEntry });

      const reserved = await service.getReservedByOthers('product-1', 'cart-mine');

      expect(reserved).toBe(0);
    });

    it('still counts a non-expired reservation against availability', async () => {
      const activeEntry = entryJson(5, Date.now() + 1000 * 60);
      redis.hgetall.mockResolvedValue({ 'cart-other': activeEntry });

      const reserved = await service.getReservedByOthers('product-1', 'cart-mine');

      expect(reserved).toBe(5);
    });
  });

  describe('getReservedByOthers', () => {
    it('sums quantities across multiple other carts, excluding the requesting cart', async () => {
      redis.hgetall.mockResolvedValue({
        'cart-mine': entryJson(3, Date.now() + 60_000),
        'cart-a': entryJson(2, Date.now() + 60_000),
        'cart-b': entryJson(4, Date.now() + 60_000),
      });

      const reserved = await service.getReservedByOthers('product-1', 'cart-mine');

      expect(reserved).toBe(6);
    });
  });

  describe('getAvailableToPurchase', () => {
    it('subtracts reservations held by others from quantityAvailable', async () => {
      redis.hgetall.mockResolvedValue({ 'cart-other': entryJson(3, Date.now() + 60_000) });

      const available = await service.getAvailableToPurchase('product-1', 10, 'cart-mine');

      expect(available).toBe(7);
    });

    it('never returns a negative number even if oversubscribed', async () => {
      redis.hgetall.mockResolvedValue({ 'cart-other': entryJson(20, Date.now() + 60_000) });

      const available = await service.getAvailableToPurchase('product-1', 10, 'cart-mine');

      expect(available).toBe(0);
    });
  });

  describe('reserve', () => {
    it('writes a hash entry with a future expiresAt and refreshes the defensive outer TTL', async () => {
      const before = Date.now();
      await service.reserve('product-1', 'cart-mine', 4);

      expect(redis.hset).toHaveBeenCalledTimes(1);
      const [key, field, value] = redis.hset.mock.calls[0]!;
      expect(key).toBe('inv:reserved:product-1');
      expect(field).toBe('cart-mine');
      const parsed = JSON.parse(value) as { quantity: number; expiresAt: number };
      expect(parsed.quantity).toBe(4);
      expect(parsed.expiresAt).toBeGreaterThan(before);

      expect(redis.expire).toHaveBeenCalledWith('inv:reserved:product-1', RESERVATION_HASH_TTL_SECONDS);
    });
  });

  describe('release', () => {
    it('removes exactly the calling cart field and leaves other carts alone', async () => {
      await service.release('product-1', 'cart-mine');

      expect(redis.hdel).toHaveBeenCalledWith('inv:reserved:product-1', 'cart-mine');
      expect(redis.hdel).toHaveBeenCalledTimes(1);
    });
  });
});
