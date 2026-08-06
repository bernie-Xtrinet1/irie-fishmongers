import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { cartIndexKey } from '../constants/inventory.constants';
import { CheckoutPendingReconciliationService } from './checkout-pending-reconciliation.service';
import { CheckoutLeaseStateService } from './checkout-lease-state.service';
import { CheckoutReservationRecoveryService } from './checkout-reservation-recovery.service';
import {
  buildReservationEntryJson,
  checkoutIds,
  getRawCheckoutFields,
  seedRawReservation,
  trackCheckoutKeysFor,
} from './checkout-reservation-state.redis-test-helpers';
import { cleanupKeys, connectRealRedis } from './inventory-reservations.redis-test-helpers';

// Real-Redis integration coverage for reconcileExpiredCheckoutPending's
// hard-ceiling and unsafe/incomplete-state scenarios (Unit 2.4.4). Baseline
// scenarios live in checkout-pending-reconciliation.redis.integration.spec.ts;
// concurrency scenarios live in
// checkout-pending-reconciliation-concurrency.redis.integration.spec.ts -
// split to keep every file within the repository's 400-line cap.
// MAX_CHECKOUT_PENDING_SECONDS is 600s.
const MAX_CHECKOUT_PENDING_MS = 600_000;

describe('CheckoutPendingReconciliationService.reconcileExpiredCheckoutPending (real Redis - hard ceiling and unsafe state)', () => {
  let client: Redis;
  let reconciliation: CheckoutPendingReconciliationService;
  let createdKeys: Set<string>;

  beforeAll(async () => {
    client = await connectRealRedis();
    const redisService = new RedisService(client);
    reconciliation = new CheckoutPendingReconciliationService(
      new CheckoutLeaseStateService(redisService),
      new CheckoutReservationRecoveryService(redisService),
    );
  });

  afterAll(async () => {
    await client.quit();
  });

  beforeEach(() => {
    createdKeys = new Set<string>();
  });

  afterEach(async () => {
    await cleanupKeys(client, createdKeys);
  });

  async function seedPending(
    cartId: string,
    productId: string,
    customerId: string,
    checkoutIdempotencyKey: string,
    checkoutPendingAt: number,
    checkoutPendingExpiresAt: number,
    now: number,
  ): Promise<void> {
    await seedRawReservation(
      client,
      cartId,
      productId,
      buildReservationEntryJson(now, {
        cartId,
        customerId,
        status: 'CHECKOUT_PENDING',
        checkoutIdempotencyKey,
        checkoutPendingAt,
        checkoutPendingExpiresAt,
      }),
    );
  }

  it('reverts on a corrupted stored deadline alone (hardLimitViolationProductIds), never attempting extension', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();
    // checkoutPendingAt is recent (ceiling = now + 500_000), but the stored
    // deadline already exceeds that ceiling - a corrupted value, still in
    // the future relative to now.
    await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, now - 100_000, now + 600_000, now);

    const result = await reconciliation.reconcileExpiredCheckoutPending({
      cartId,
      checkoutIdempotencyKey,
      durableAttemptState: 'PROCESSING',
      durableLastHeartbeatAt: now,
      now,
    });

    expect(result).toMatchObject({ ok: true, action: 'REVERTED', reason: 'HARD_PENDING_LIMIT_REACHED' });
    const after = await getRawCheckoutFields(client, cartId, productId);
    expect(after?.status).toBe('ACTIVE');
    // Never extended - the stored deadline is untouched by the revert.
    expect(after?.checkoutPendingExpiresAt).toBeNull();
  });

  it('reverts when the cart-wide earliestCheckoutPendingAt alone has reached the hard ceiling', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();
    const checkoutPendingAt = now - MAX_CHECKOUT_PENDING_MS;
    await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, checkoutPendingAt, now - 1, now);

    const result = await reconciliation.reconcileExpiredCheckoutPending({
      cartId,
      checkoutIdempotencyKey,
      durableAttemptState: 'PROCESSING',
      durableLastHeartbeatAt: now,
      now,
    });

    expect(result).toMatchObject({ ok: true, action: 'REVERTED', reason: 'HARD_PENDING_LIMIT_REACHED' });
  });

  it('reverts directly (no extension attempt) when the cart mixes ACTIVE and CHECKOUT_PENDING members', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const pendingId = `product-${Math.random()}`;
    const activeId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [pendingId, activeId]);
    const now = Date.now();
    await seedPending(cartId, pendingId, customerId, checkoutIdempotencyKey, now - 10_000, now - 1_000, now);
    await seedRawReservation(
      client,
      cartId,
      activeId,
      buildReservationEntryJson(now, { cartId, customerId, status: 'ACTIVE' }),
    );

    const result = await reconciliation.reconcileExpiredCheckoutPending({
      cartId,
      checkoutIdempotencyKey,
      durableAttemptState: 'PROCESSING',
      durableLastHeartbeatAt: now,
      now,
    });

    expect(result).toMatchObject({ ok: true, action: 'REVERTED', reason: 'REDIS_STATE_INCOMPLETE' });
    // Never extended: the pending member's expiry is exactly as seeded.
    expect((await getRawCheckoutFields(client, cartId, pendingId))?.checkoutPendingExpiresAt).toBeNull();
  });

  it('reverts and preserves evidence for a malformed member, reported in the revert result', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const pendingId = `product-${Math.random()}`;
    const malformedId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [pendingId, malformedId]);
    const now = Date.now();
    await seedPending(cartId, pendingId, customerId, checkoutIdempotencyKey, now - 10_000, now - 1_000, now);
    await seedRawReservation(client, cartId, malformedId, '{not valid json');

    const result = await reconciliation.reconcileExpiredCheckoutPending({
      cartId,
      checkoutIdempotencyKey,
      durableAttemptState: 'PROCESSING',
      durableLastHeartbeatAt: now,
      now,
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.action === 'REVERTED') {
      expect(result.reason).toBe('REDIS_STATE_INCOMPLETE');
      expect(result.revertResult.malformedProductIds).toEqual([malformedId]);
    }
  });

  it('reverts and preserves evidence for a version-mismatched member, reported in the revert result', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const pendingId = `product-${Math.random()}`;
    const wrongVersionId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [pendingId, wrongVersionId]);
    const now = Date.now();
    await seedPending(cartId, pendingId, customerId, checkoutIdempotencyKey, now - 10_000, now - 1_000, now);
    await seedRawReservation(
      client,
      cartId,
      wrongVersionId,
      buildReservationEntryJson(now, { cartId, customerId, version: 2, status: 'ACTIVE' }),
    );

    const result = await reconciliation.reconcileExpiredCheckoutPending({
      cartId,
      checkoutIdempotencyKey,
      durableAttemptState: 'PROCESSING',
      durableLastHeartbeatAt: now,
      now,
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.action === 'REVERTED') {
      expect(result.revertResult.versionMismatchedProductIds).toEqual([wrongVersionId]);
    }
  });

  it('reverts when a member belongs to a different checkout idempotency key', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const ownedId = `product-${Math.random()}`;
    const conflictingId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [ownedId, conflictingId]);
    const now = Date.now();
    await seedPending(cartId, ownedId, customerId, checkoutIdempotencyKey, now - 10_000, now - 1_000, now);
    await seedPending(cartId, conflictingId, customerId, `${checkoutIdempotencyKey}-other`, now, now + 50_000, now);

    const result = await reconciliation.reconcileExpiredCheckoutPending({
      cartId,
      checkoutIdempotencyKey,
      durableAttemptState: 'PROCESSING',
      durableLastHeartbeatAt: now,
      now,
    });

    expect(result).toMatchObject({ ok: true, action: 'REVERTED', reason: 'REDIS_STATE_INCOMPLETE' });
  });

  it('reverts and cleans the stale cart-index membership for a missing reservation entry', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const pendingId = `product-${Math.random()}`;
    const missingId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [pendingId, missingId]);
    const now = Date.now();
    await seedPending(cartId, pendingId, customerId, checkoutIdempotencyKey, now - 10_000, now - 1_000, now);
    await client.sadd(cartIndexKey(cartId), missingId);

    const result = await reconciliation.reconcileExpiredCheckoutPending({
      cartId,
      checkoutIdempotencyKey,
      durableAttemptState: 'PROCESSING',
      durableLastHeartbeatAt: now,
      now,
    });

    expect(result).toMatchObject({ ok: true, action: 'REVERTED', reason: 'REDIS_STATE_INCOMPLETE' });
    expect(await client.sismember(cartIndexKey(cartId), missingId)).toBe(0);
  });
});
