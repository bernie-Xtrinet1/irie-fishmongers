import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { reservationHashKey } from '../constants/inventory.constants';
import { InventoryReservationsService } from './inventory-reservations.service';

export interface ReconciliationSummary {
  productsChecked: number;
  reservationsReleased: number;
}

const RESERVED_KEY_PREFIX = 'inv:reserved:';

/**
 * On-demand reconciliation (no scheduler exists in this codebase - see the
 * plan's scoping notes). Cross-checks Redis reservations against live
 * CartItem rows and releases any that are orphaned (cart item removed
 * through some other path) or under-matched (cart item quantity dropped
 * below what was reserved). Reads `prisma.cartItem` directly rather than
 * importing CartModule, to avoid a circular module dependency.
 */
@Injectable()
export class InventoryReconciliationService {
  constructor(
    private readonly redis: RedisService,
    private readonly reservations: InventoryReservationsService,
    private readonly prisma: PrismaService,
  ) {}

  async reconcile(productId?: string): Promise<ReconciliationSummary> {
    const productIds = productId ? [productId] : await this.listProductIdsWithReservations();

    let reservationsReleased = 0;
    for (const id of productIds) {
      reservationsReleased += await this.reconcileProduct(id);
    }

    return { productsChecked: productIds.length, reservationsReleased };
  }

  private async reconcileProduct(productId: string): Promise<number> {
    const raw = await this.redis.hgetall(reservationHashKey(productId));
    const now = Date.now();
    let released = 0;

    for (const [cartId, value] of Object.entries(raw)) {
      const entry = JSON.parse(value) as { quantity: number; expiresAt: number };

      // Already expired - invisible to every read already, nothing to reconcile.
      if (entry.expiresAt <= now) {
        continue;
      }

      const cartItem = await this.prisma.cartItem.findFirst({ where: { cartId, productId } });
      const isOrphaned = !cartItem || cartItem.quantity < entry.quantity;

      if (isOrphaned) {
        await this.reservations.release(productId, cartId);
        released += 1;
      }
    }

    return released;
  }

  private async listProductIdsWithReservations(): Promise<string[]> {
    const client = this.redis.getClient();
    const productIds = new Set<string>();
    let cursor = '0';

    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        'MATCH',
        `${RESERVED_KEY_PREFIX}*`,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      for (const key of keys) {
        productIds.add(key.slice(RESERVED_KEY_PREFIX.length));
      }
    } while (cursor !== '0');

    return Array.from(productIds);
  }
}
