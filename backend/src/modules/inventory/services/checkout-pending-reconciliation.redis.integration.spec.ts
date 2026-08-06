import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
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
// baseline scenarios (Unit 2.4.4): active lease, expired+fresh-heartbeat
// resync, expired+stale-heartbeat revert, and every non-PROCESSING durable
// state. Unsafe/incomplete-state and hard-ceiling scenarios live in
// checkout-pending-reconciliation-corruption.redis.integration.spec.ts;
// concurrency scenarios live in
// checkout-pending-reconciliation-concurrency.redis.integration.spec.ts -
// split to keep every file within the repository's 400-line cap.
//
// Requires a reachable Redis (REDIS_URL) and fails the whole file loudly
// if one is not available - it does not skip.
describe('CheckoutPendingReconciliationService.reconcileExpiredCheckoutPending (real Redis - baseline)', () => {
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

  it('returns NONE for a complete, uniform, still-active pending cart', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();
    await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, now, now + 100_000, now);

    const result = await reconciliation.reconcileExpiredCheckoutPending({
      cartId,
      checkoutIdempotencyKey,
      durableAttemptState: 'PROCESSING',
      durableLastHeartbeatAt: now,
      now,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe('NONE');
    }
    expect((await getRawCheckoutFields(client, cartId, productId))?.status).toBe('CHECKOUT_PENDING');
  });

  it('resyncs an expired lease with a fresh heartbeat, updating every cart member to exactly 180 seconds', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productIds = [`product-${Math.random()}`, `product-${Math.random()}`];
    trackCheckoutKeysFor(createdKeys, cartId, productIds);
    const now = Date.now();
    for (const productId of productIds) {
      await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, now - 30_000, now - 1_000, now);
    }

    const result = await reconciliation.reconcileExpiredCheckoutPending({
      cartId,
      checkoutIdempotencyKey,
      durableAttemptState: 'PROCESSING',
      durableLastHeartbeatAt: now,
      now,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe('RESYNC_LEASE');
      if (result.action === 'RESYNC_LEASE') {
        expect(result.leaseExtension.newCheckoutPendingExpiresAt).toBe(now + 180_000);
        expect(result.leaseExtension.extendedProductIds).toEqual([...productIds].sort());
      }
    }
    for (const productId of productIds) {
      expect((await getRawCheckoutFields(client, cartId, productId))?.checkoutPendingExpiresAt).toBe(
        now + 180_000,
      );
    }
  });

  it('reverts an expired lease when the durable heartbeat is stale', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();
    await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, now - 30_000, now - 1_000, now);

    const result = await reconciliation.reconcileExpiredCheckoutPending({
      cartId,
      checkoutIdempotencyKey,
      durableAttemptState: 'PROCESSING',
      durableLastHeartbeatAt: now - 200_000,
      now,
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.action === 'REVERTED') {
      expect(result.reason).toBe('DURABLE_HEARTBEAT_STALE');
    }
    expect((await getRawCheckoutFields(client, cartId, productId))?.status).toBe('ACTIVE');
  });

  it('finalizes every matching entry for a durably COMMITTED attempt', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();
    await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, now - 10_000, now + 50_000, now);

    const result = await reconciliation.reconcileExpiredCheckoutPending({
      cartId,
      checkoutIdempotencyKey,
      durableAttemptState: 'COMMITTED',
      durableLastHeartbeatAt: null,
      now,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe('FINALIZED');
      if (result.action === 'FINALIZED') {
        expect(result.finalizeResult.finalizedProductIds).toEqual([productId]);
      }
    }
    expect(await getRawCheckoutFields(client, cartId, productId)).toBeNull();
  });

  it('reverts for a durably FAILED attempt without inspecting Redis lease state', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();
    await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, now - 10_000, now + 50_000, now);

    const result = await reconciliation.reconcileExpiredCheckoutPending({
      cartId,
      checkoutIdempotencyKey,
      durableAttemptState: 'FAILED',
      durableLastHeartbeatAt: null,
      now,
    });

    expect(result).toMatchObject({ ok: true, action: 'REVERTED', reason: 'DURABLE_ATTEMPT_FAILED' });
    expect((await getRawCheckoutFields(client, cartId, productId))?.status).toBe('ACTIVE');
  });

  it('reverts for a durable NOT_FOUND attempt without inspecting Redis lease state', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();
    await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, now - 10_000, now + 50_000, now);

    const result = await reconciliation.reconcileExpiredCheckoutPending({
      cartId,
      checkoutIdempotencyKey,
      durableAttemptState: 'NOT_FOUND',
      durableLastHeartbeatAt: null,
      now,
    });

    expect(result).toMatchObject({ ok: true, action: 'REVERTED', reason: 'DURABLE_ATTEMPT_NOT_FOUND' });
    expect((await getRawCheckoutFields(client, cartId, productId))?.status).toBe('ACTIVE');
  });
});
