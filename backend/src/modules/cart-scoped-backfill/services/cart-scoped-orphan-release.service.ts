import { Injectable } from '@nestjs/common';

import { RedisService } from '../../../common/redis/redis.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CartScopedOrphanOutcome } from '../types/cart-scoped-backfill.types';

const CART_INDEX_KEY_PATTERN = /^inv:reserved:cart-index:\{([^{}]+)\}$/;

// CART_SCOPED activation-boundary gate (see the gate design review's
// direct-backfill design). A one-time backfill-phase step, run once
// alongside enumeratePositiveTargets/backfillTargets, never repeated by
// the freshness sweep: an orphan that happens to expire between this scan
// and cutover is self-correcting (it shouldn't exist anyway, so its own
// natural lazy-expiry is harmless), unlike a genuine positive target's
// freshness, which the sweep exists specifically to guarantee.
//
// Walks the cart-scoped cart-index the same SCAN technique
// ReservationEngineModeService.verifyRollbackSafe already uses for its own
// rollback-safety walk, but inverted: for every (cartId, productId) pair
// currently live in cart-scoped Redis, a CURRENT CartItem with positive
// quantity must exist, or the hold is stale and released. A positive-item-
// only backfill is insufficient on its own for exactly this reason - a
// stale cart-scoped hold for a deleted/reduced item would otherwise
// survive cutover, over-counting demand against a product forever.
@Injectable()
export class CartScopedOrphanReleaseService {
  constructor(
    private readonly redis: RedisService,
    private readonly cartRepository: CartRepository,
    private readonly inventoryReservations: InventoryReservationsService,
  ) {}

  async discoverAndReleaseOrphans(): Promise<CartScopedOrphanOutcome[]> {
    const client = this.redis.getClient();
    const outcomes: CartScopedOrphanOutcome[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', 'inv:reserved:cart-index:{*}', 'COUNT', 100);
      cursor = nextCursor;
      for (const key of keys) {
        const match = CART_INDEX_KEY_PATTERN.exec(key);
        if (!match) {
          continue;
        }
        const cartId = match[1]!;
        const productIds = await client.smembers(key);
        for (const productId of productIds) {
          const outcome = await this.releaseIfOrphaned(cartId, productId);
          if (outcome) {
            outcomes.push(outcome);
          }
        }
      }
    } while (cursor !== '0');

    return outcomes;
  }

  private async releaseIfOrphaned(cartId: string, productId: string): Promise<CartScopedOrphanOutcome | null> {
    const item = await this.cartRepository.findItemByCartAndProduct(cartId, productId);
    if (item && item.quantity > 0) {
      return null;
    }
    const result = await this.inventoryReservations.releaseReservation(cartId, productId);
    return { cartId, productId, released: result.released };
  }
}
