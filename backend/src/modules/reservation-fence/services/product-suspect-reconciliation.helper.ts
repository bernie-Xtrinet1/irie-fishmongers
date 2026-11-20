import { Prisma, ProductReservationRestriction } from '@prisma/client';

import { RedisService } from '../../../common/redis/redis.service';
import {
  cartIndexKey,
  productIndexKey,
  productSuspectKey,
  productTotalKey,
  reservationKey,
} from '../../inventory/constants/inventory.constants';
import { observeReservation } from '../../inventory/services/reservation-read-observation';
import { checkoutPinKey } from '../lua/checkout-settlement.lua';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY } from '../lua/reservation-mutation-common.lua';
import {
  ClearanceActiveCartSnapshot,
  ClearanceReconciliationSnapshot,
  ClearanceTargetManifestEntry,
  RECONCILIATION_SCAN_MAX_ITERATIONS,
  RECONCILIATION_SCAN_MAX_KEYS,
  canonicalClearanceJson,
  clearanceSha256Hex,
} from '../types/product-suspect-clearance.types';
import { productControlKey } from '../types/product-reservation-restriction.types';
import { FenceTuple } from '../types/reservation-fence.types';

export interface ReconcileProductSuccess {
  ok: true;
  snapshot: ClearanceReconciliationSnapshot;
  reconciliationDigest: string;
}

export interface ReconcileProductFailure {
  ok: false;
  code: string;
  message: string;
}

const UNSAFE_PRODUCT_CHARS = /[{}*?\s]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseNonNegIntString(raw: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const num = Number(raw);
  return Number.isSafeInteger(num) ? num : null;
}

function extractCartIdFromKey(key: string, productId: string): string | null {
  const prefix = 'inv:reserved:{';
  const suffix = `}:${productId}`;
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return null;
  const cartId = key.slice(prefix.length, key.length - suffix.length);
  return cartId.length > 0 ? cartId : null;
}

async function scanProductReservationKeys(
  redis: RedisService,
  productId: string,
): Promise<{ ok: true; cartIds: string[] } | ReconcileProductFailure> {
  const client = redis.getClient();
  const pattern = `inv:reserved:*:${productId}`;
  let cursor = '0';
  let iterations = 0;
  const cartIds = new Set<string>();

  do {
    if (iterations >= RECONCILIATION_SCAN_MAX_ITERATIONS) {
      return { ok: false, code: 'RECONCILIATION_SCOPE_EXCEEDED', message: 'Redis keyspace scan exceeded iteration bound' };
    }
    iterations += 1;
    const [nextCursor, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = nextCursor;
    for (const key of batch) {
      const cartId = extractCartIdFromKey(key, productId);
      if (cartId) cartIds.add(cartId);
      if (cartIds.size > RECONCILIATION_SCAN_MAX_KEYS) {
        return { ok: false, code: 'RECONCILIATION_SCOPE_EXCEEDED', message: 'Product reservation count exceeded scan bound' };
      }
    }
  } while (cursor !== '0');

  return { ok: true, cartIds: [...cartIds].sort() };
}

function verifyControlKeyRestricted(
  rawControl: string | null,
  pttl: number,
  productId: string,
  restriction: ProductReservationRestriction,
  fence: FenceTuple,
): string | null {
  if (!rawControl || pttl !== -1) return 'MISSING_OR_EPHEMERAL_PRODUCT_CONTROL';
  try {
    const parsed: unknown = JSON.parse(rawControl);
    if (!isRecord(parsed) || Object.keys(parsed).length !== 7) return 'MALFORMED_PRODUCT_CONTROL';
    if (
      parsed.version !== 1 ||
      parsed.productId !== productId ||
      parsed.state !== 'RESTRICTED' ||
      parsed.restrictionId !== restriction.id ||
      parsed.restrictionRevision !== restriction.restrictionRevision ||
      parsed.incarnation !== fence.incarnation ||
      parsed.epoch !== fence.epoch
    ) {
      return 'CONTROL_STATE_MISMATCH';
    }
    return null;
  } catch {
    return 'MALFORMED_PRODUCT_CONTROL';
  }
}

export async function reconcileProductForClearance(params: {
  tx: Prisma.TransactionClient;
  redis: RedisService;
  productId: string;
  restriction: ProductReservationRestriction;
  clearedControlRevision: number;
  fence: FenceTuple;
  nowMs?: number;
}): Promise<ReconcileProductSuccess | ReconcileProductFailure> {
  const { tx, redis, productId, restriction, clearedControlRevision, fence } = params;
  if (!productId || UNSAFE_PRODUCT_CHARS.test(productId)) {
    return { ok: false, code: 'INVALID_PRODUCT_ID', message: 'Invalid product identifier' };
  }

  const product = await tx.product.findUnique({ where: { id: productId }, select: { id: true, quantityAvailable: true } });
  if (!product) return { ok: false, code: 'PRODUCT_NOT_FOUND', message: 'Product does not exist' };
  if (!Number.isInteger(product.quantityAvailable) || product.quantityAvailable < 0) {
    return { ok: false, code: 'INVALID_QUANTITY_AVAILABLE', message: 'Invalid product quantityAvailable' };
  }

  const client = redis.getClient();
  const [rawFence, histIncarnation, controlType, rawControl, controlPttl, suspectType, totalType] = await Promise.all([
    client.get(RESERVATION_FENCE_KEY),
    client.hget(MUTATION_HISTORY_KEY, 'incarnation'),
    client.type(productControlKey(productId)),
    client.get(productControlKey(productId)).catch(() => '__WRONGTYPE__'),
    client.pttl(productControlKey(productId)),
    client.type(productSuspectKey(productId)),
    client.type(productTotalKey(productId)),
  ]);

  if (!rawFence) return { ok: false, code: 'REDIS_FENCE_MISSING', message: 'Redis reservation fence missing' };
  try {
    const parsedFence: unknown = JSON.parse(rawFence);
    if (
      !isRecord(parsedFence) ||
      parsedFence.incarnation !== fence.incarnation ||
      parsedFence.epoch !== fence.epoch ||
      parsedFence.revision !== fence.revision ||
      parsedFence.phase !== fence.phase ||
      parsedFence.transitionId !== fence.transitionId
    ) {
      return { ok: false, code: 'REDIS_FENCE_MISMATCH', message: 'Redis fence disagrees with durable fence' };
    }
  } catch {
    return { ok: false, code: 'REDIS_FENCE_MALFORMED', message: 'Redis reservation fence malformed' };
  }
  if (histIncarnation !== fence.incarnation) {
    return { ok: false, code: 'MISSING_INITIALIZATION_HISTORY', message: 'Initialization history incarnation mismatch' };
  }
  if (controlType !== 'string' || rawControl === '__WRONGTYPE__') {
    return { ok: false, code: 'CONTROL_STATE_MISMATCH', message: 'Redis product control must be installed as RESTRICTED' };
  }
  const controlError = verifyControlKeyRestricted(rawControl, controlPttl, productId, restriction, fence);
  if (controlError) return { ok: false, code: controlError, message: `Redis control rejected (${controlError})` };

  if (suspectType !== 'none' && suspectType !== 'string') {
    return { ok: false, code: 'CORRUPT_SUSPECT_FLAG', message: 'Redis product suspect flag has unexpected type' };
  }
  const priorSuspectPresent = suspectType === 'string';

  if (totalType !== 'none' && totalType !== 'string') {
    return { ok: false, code: 'CORRUPT_PRODUCT_TOTAL', message: 'Redis product total has unexpected type' };
  }
  let priorStoredTotal: number | null = null;
  if (totalType === 'string') {
    const rawTotal = await client.get(productTotalKey(productId));
    priorStoredTotal = rawTotal !== null ? parseNonNegIntString(rawTotal) : null;
    if (priorStoredTotal === null) {
      return { ok: false, code: 'CORRUPT_PRODUCT_TOTAL', message: 'Redis product total must be a valid non-negative integer' };
    }
  }

  const [cartItems, syncStates, compensations] = await Promise.all([
    tx.cartItem.findMany({ where: { productId }, include: { cart: { select: { id: true, customerId: true } } } }),
    tx.cartReservationSyncState.findMany({ where: { productId }, orderBy: { id: 'asc' } }),
    tx.cartReservationCompensation.findMany({ where: { productId }, orderBy: { id: 'asc' } }),
  ]);

  if (syncStates.some((s) => s.status === 'PROCESSING')) {
    return { ok: false, code: 'SYNC_IN_PROGRESS', message: 'Active PROCESSING sync state prevents product clearance' };
  }
  if (compensations.some((c) => c.status === 'PROCESSING')) {
    return { ok: false, code: 'COMPENSATION_IN_PROGRESS', message: 'Active PROCESSING compensation prevents product clearance' };
  }

  const markerIds = syncStates.map((s) => s.id).sort();
  for (const markerId of markerIds) {
    if ((await client.exists(checkoutPinKey(markerId))) !== 0) {
      return { ok: false, code: 'CHECKOUT_IN_PROGRESS', message: `Active checkout pin found on marker ${markerId}` };
    }
  }

  const idxType = await client.type(productIndexKey(productId));
  if (idxType !== 'none' && idxType !== 'set') {
    return { ok: false, code: 'CORRUPT_PRODUCT_INDEX', message: 'Redis product index has unexpected type' };
  }
  const indexedCartIds = idxType === 'set' ? (await client.smembers(productIndexKey(productId))).sort() : [];
  const scanned = await scanProductReservationKeys(redis, productId);
  if (!scanned.ok) return scanned;

  const allCartIds = [...new Set([
    ...cartItems.map((i) => i.cartId),
    ...syncStates.map((s) => s.cartId),
    ...compensations.map((c) => c.cartId),
    ...indexedCartIds,
    ...scanned.cartIds,
  ])].sort();

  const existingCartIds = new Set(
    (await tx.cart.findMany({ where: { id: { in: allCartIds } }, select: { id: true } })).map((c) => c.id),
  );
  const cartItemByCart = new Map(cartItems.map((item) => [item.cartId, item]));
  const syncByCart = new Map(syncStates.map((s) => [s.cartId, s]));
  const unresolvedCompsByCart = new Map<string, number>();
  for (const c of compensations) {
    if (c.status === 'PENDING' || c.status === 'BLOCKED') {
      unresolvedCompsByCart.set(c.cartId, (unresolvedCompsByCart.get(c.cartId) ?? 0) + 1);
    }
  }

  const nowMs = params.nowMs ?? Date.now();
  const activeReservations: ClearanceActiveCartSnapshot[] = [];
  const indexedSet = new Set(indexedCartIds);

  for (const cartId of allCartIds) {
    const key = reservationKey(cartId, productId);
    const keyType = await client.type(key);
    if (keyType === 'none') continue;
    if (keyType !== 'string') {
      return { ok: false, code: 'CORRUPT_RESERVATION_ENTRY', message: `Unexpected Redis type at ${cartId}` };
    }
    const rawEntry = await client.get(key);
    const parsedRaw = (() => { try { return rawEntry ? JSON.parse(rawEntry) as Record<string, unknown> : null; } catch { return null; } })();
    if (parsedRaw && parsedRaw.status === 'CHECKOUT_PENDING') {
      return { ok: false, code: 'CHECKOUT_IN_PROGRESS', message: `Cart ${cartId} has pending checkout entry` };
    }
    if (parsedRaw && typeof parsedRaw.markerId === 'string') {
      if ((await client.exists(checkoutPinKey(parsedRaw.markerId))) !== 0) {
        return { ok: false, code: 'CHECKOUT_IN_PROGRESS', message: `Active checkout pin found on entry marker` };
      }
    }
    const obs = observeReservation(rawEntry, cartId, nowMs);
    if (obs.status === 'MALFORMED' || obs.status === 'UNTRUSTED') {
      return { ok: false, code: 'CORRUPT_RESERVATION_ENTRY', message: `Corrupt reservation entry for cart ${cartId}` };
    }
    if (obs.status !== 'ACTIVE') continue;

    if (!indexedSet.has(cartId) || (await client.sismember(cartIndexKey(cartId), productId)) !== 1) {
      return { ok: false, code: 'INDEX_MEMBERSHIP_DRIFT', message: `Active reservation for cart ${cartId} is unindexed` };
    }
    if (!existingCartIds.has(cartId)) {
      return { ok: false, code: 'ORPHAN_ACTIVE_RESERVATION', message: `Active reservation for missing cart ${cartId}` };
    }

    const itemQty = cartItemByCart.get(cartId)?.quantity ?? 0;
    const sync = syncByCart.get(cartId) ?? null;
    const hasUnresolvedExplanation = (sync !== null && sync.resolvedAt === null) || (unresolvedCompsByCart.get(cartId) ?? 0) > 0;
    if (obs.entry.quantity !== itemQty && !hasUnresolvedExplanation) {
      return { ok: false, code: 'UNEXPLAINED_RESERVATION_DRIFT', message: `Quantity drift on cart ${cartId} has no sync or compensation attribution` };
    }

    activeReservations.push({
      cartId,
      customerId: obs.entry.customerId,
      markerId: sync?.id ?? null,
      syncStateId: sync?.id ?? null,
      expectedGeneration: sync?.generation ?? null,
      quantity: obs.entry.quantity,
      expiresAt: obs.entry.expiresAt,
      absoluteExpiresAt: obs.entry.absoluteExpiresAt,
    });
  }

  const targetReconciledTotal = activeReservations.reduce((sum, entry) => sum + entry.quantity, 0);
  if (targetReconciledTotal > product.quantityAvailable) {
    return {
      ok: false,
      code: 'OVER_ALLOCATED_INVENTORY',
      message: `Reconciled total ${targetReconciledTotal} exceeds quantityAvailable ${product.quantityAvailable}`,
    };
  }

  const unblockedTargets: ClearanceTargetManifestEntry[] = [
    ...syncStates
      .filter((s) => s.status === 'BLOCKED' && s.blockReason === 'PRODUCT_SUSPECT' && s.resolvedAt === null)
      .map((s): ClearanceTargetManifestEntry => ({
        targetKind: 'SYNC_STATE', id: s.id, cartId: s.cartId, expectedGeneration: s.generation, priorAttemptCount: s.attemptCount,
      })),
    ...compensations
      .filter((c) => c.status === 'BLOCKED' && c.blockReason === 'PRODUCT_SUSPECT')
      .map((c): ClearanceTargetManifestEntry => ({
        targetKind: 'COMPENSATION', id: c.id, cartId: c.cartId, expectedGeneration: c.generation, priorAttemptCount: c.attemptCount,
      })),
  ].sort((a, b) => `${a.targetKind}:${a.id}`.localeCompare(`${b.targetKind}:${b.id}`));

  const redisObservedCartIds = [...new Set([...indexedCartIds, ...scanned.cartIds])].sort();

  const snapshot: ClearanceReconciliationSnapshot = {
    version: 1,
    productId,
    restrictionId: restriction.id,
    targetRestrictionRevision: restriction.restrictionRevision,
    clearedControlRevision,
    quantityAvailable: product.quantityAvailable,
    priorStoredTotal,
    targetReconciledTotal,
    priorSuspectPresent,
    activeReservations,
    redisObservedCartIds,
    expectedCartIds: allCartIds,
    markerIds,
    unblockedTargets,
    driftAfter: 0,
  };

  // Cryptographic digest binds immutable physical Redis state, restriction identity, and
  // attributed target identities + priorAttemptCount while tolerating safe generation advances
  // from concurrent cart updates during the same restriction incident.
  const digestPayload = {
    version: snapshot.version,
    productId: snapshot.productId,
    restrictionId: snapshot.restrictionId,
    targetRestrictionRevision: snapshot.targetRestrictionRevision,
    clearedControlRevision: snapshot.clearedControlRevision,
    quantityAvailable: snapshot.quantityAvailable,
    priorStoredTotal: snapshot.priorStoredTotal,
    targetReconciledTotal: snapshot.targetReconciledTotal,
    priorSuspectPresent: snapshot.priorSuspectPresent,
    activeReservations: snapshot.activeReservations.map((a) => ({
      cartId: a.cartId,
      customerId: a.customerId,
      quantity: a.quantity,
      expiresAt: a.expiresAt,
      absoluteExpiresAt: a.absoluteExpiresAt,
    })),
    redisObservedCartIds: snapshot.redisObservedCartIds,
    unblockedTargets: snapshot.unblockedTargets.map((t) => ({
      targetKind: t.targetKind,
      id: t.id,
      cartId: t.cartId,
      priorAttemptCount: t.priorAttemptCount,
    })),
    driftAfter: snapshot.driftAfter,
  };

  return {
    ok: true,
    snapshot,
    reconciliationDigest: clearanceSha256Hex(canonicalClearanceJson(digestPayload)),
  };
}
