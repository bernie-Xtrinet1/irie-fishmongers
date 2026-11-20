import { RedisService } from '../../../common/redis/redis.service';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { RollbackVerificationResult } from '../types/reservation-engine-mode.types';

const CART_INDEX_KEY_PATTERN = /^inv:reserved:cart-index:\{([^{}]+)\}$/;
const PRODUCT_TOTAL_KEY_PATTERN = /^inv:reserved:product-total:\{([^{}]+)\}$/;

export async function verifyRollbackSafeFromRedis(
  redis: RedisService,
  inventoryReservations: InventoryReservationsService,
): Promise<RollbackVerificationResult> {
  const [nonZeroTotalProductIds, liveIndexProductIds] = await Promise.all([
    findProductsWithNonZeroTotal(redis),
    findProductsWithLiveCartIndexReservations(redis, inventoryReservations),
  ]);

  const totalsSet = new Set(nonZeroTotalProductIds);
  const liveSet = new Set(liveIndexProductIds.present);
  const unresolvedSet = new Set(liveIndexProductIds.unresolved);
  const outstandingProductIds: string[] = [];
  const structureDriftProductIds: string[] = [];

  for (const productId of new Set([...totalsSet, ...liveSet, ...unresolvedSet])) {
    if (!unresolvedSet.has(productId) && totalsSet.has(productId) && liveSet.has(productId)) {
      outstandingProductIds.push(productId);
    } else {
      structureDriftProductIds.push(productId);
    }
  }

  outstandingProductIds.sort();
  structureDriftProductIds.sort();

  return {
    clear: outstandingProductIds.length === 0 && structureDriftProductIds.length === 0,
    outstandingProductIds,
    structureDriftProductIds,
  };
}

// Fast-path signal: does any product's aggregated reserved-total key
// report a non-zero value? This is the projection reservation-lifecycle.md
// §7 already documents as capable of OVERCOUNT/UNDERCOUNT drift - one of
// two independent signals, never trusted alone.
async function findProductsWithNonZeroTotal(redis: RedisService): Promise<string[]> {
  const client = redis.getClient();
  const nonZero: string[] = [];
  let cursor = '0';

  do {
    const [nextCursor, keys] = await client.scan(
      cursor,
      'MATCH',
      'inv:reserved:product-total:{*}',
      'COUNT',
      100,
    );
    cursor = nextCursor;
    for (const key of keys) {
      const match = PRODUCT_TOTAL_KEY_PATTERN.exec(key);
      if (!match) {
        continue;
      }
      const value = await client.get(key);
      if (value !== null && Number(value) > 0) {
        nonZero.push(match[1]!);
      }
    }
  } while (cursor !== '0');

  return nonZero;
}

// Ground-truth signal: walk the cart-scoped reservation index
// (inv:reserved:cart-index:{cartId}, per reservation-lifecycle.md §4 -
// every productId a given cart currently holds a reservation for), and
// for every (cartId, productId) member, ask
// InventoryReservationsService.getActiveReservation whether that hold is
// genuinely still live - reusing the exact same parse/expiry logic every
// other read path already depends on, rather than re-deriving it here.
// A stale index member (evicted key, expired entry) is correctly
// retained as unresolved evidence. Aggregated by productId (not cartId) so it is
// directly comparable against findProductsWithNonZeroTotal's per-product
// signal for drift detection.
async function findProductsWithLiveCartIndexReservations(
  redis: RedisService,
  inventoryReservations: InventoryReservationsService,
): Promise<{ present: string[]; unresolved: string[] }> {
  const client = redis.getClient();
  const liveProductIds = new Set<string>();
  const unresolvedProductIds = new Set<string>();
  let cursor = '0';

  do {
    const [nextCursor, keys] = await client.scan(
      cursor,
      'MATCH',
      'inv:reserved:cart-index:{*}',
      'COUNT',
      100,
    );
    cursor = nextCursor;
    for (const key of keys) {
      const match = CART_INDEX_KEY_PATTERN.exec(key);
      if (!match) {
        continue;
      }
      const cartId = match[1]!;
      const productIds = await client.smembers(key);
      for (const productId of productIds) {
        const observation = await inventoryReservations.getActiveReservation(cartId, productId);
        if (observation.status === 'ACTIVE') {
          liveProductIds.add(productId);
        } else {
          // An indexed absence, expired hold or untrusted representation is
          // unresolved evidence. Verification never performs its cleanup.
          unresolvedProductIds.add(productId);
        }
      }
    }
  } while (cursor !== '0');

  return { present: Array.from(liveProductIds), unresolved: Array.from(unresolvedProductIds) };
}
