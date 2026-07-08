import { Injectable } from '@nestjs/common';

import { RedisService } from '../../../common/redis/redis.service';
import {
  RESERVATION_HASH_TTL_SECONDS,
  RESERVATION_TTL_SECONDS,
  reservationHashKey,
} from '../constants/inventory.constants';

interface ReservationEntry {
  quantity: number;
  expiresAt: number;
}

/**
 * Redis-backed soft holds on stock, keyed per product as a hash of
 * cartId -> { quantity, expiresAt }. Expiry is enforced by comparing
 * `expiresAt` against the current time on every read (not by relying on
 * Redis's own per-key TTL), so correctness never depends on Redis's
 * eviction timing. Deliberately takes `quantityAvailable` as a parameter
 * rather than looking the product up itself - see the plan's "Avoiding
 * circular module dependencies" section.
 */
@Injectable()
export class InventoryReservationsService {
  constructor(private readonly redis: RedisService) {}

  async getReservedByOthers(productId: string, excludingCartId: string): Promise<number> {
    const active = await this.readActiveEntries(productId);
    let total = 0;
    for (const [cartId, entry] of Object.entries(active)) {
      if (cartId !== excludingCartId) {
        total += entry.quantity;
      }
    }
    return total;
  }

  async getAvailableToPurchase(
    productId: string,
    quantityAvailable: number,
    excludingCartId: string,
  ): Promise<number> {
    const reservedByOthers = await this.getReservedByOthers(productId, excludingCartId);
    return Math.max(0, quantityAvailable - reservedByOthers);
  }

  async reserve(productId: string, cartId: string, quantity: number): Promise<void> {
    const key = reservationHashKey(productId);
    const entry: ReservationEntry = {
      quantity,
      expiresAt: Date.now() + RESERVATION_TTL_SECONDS * 1000,
    };
    await this.redis.hset(key, cartId, JSON.stringify(entry));
    await this.redis.expire(key, RESERVATION_HASH_TTL_SECONDS);
  }

  async release(productId: string, cartId: string): Promise<void> {
    await this.redis.hdel(reservationHashKey(productId), cartId);
  }

  private async readActiveEntries(productId: string): Promise<Record<string, ReservationEntry>> {
    const raw = await this.redis.hgetall(reservationHashKey(productId));
    const now = Date.now();
    const active: Record<string, ReservationEntry> = {};

    for (const [cartId, value] of Object.entries(raw)) {
      const entry = JSON.parse(value) as ReservationEntry;
      if (entry.expiresAt > now) {
        active[cartId] = entry;
      }
    }

    return active;
  }
}
