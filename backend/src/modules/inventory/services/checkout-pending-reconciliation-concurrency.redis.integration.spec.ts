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

// Real-Redis concurrency coverage for reconcileExpiredCheckoutPending
// (Unit 2.4.4): a race between reconciliation and another concurrent
// reconciliation/finalize/revert call must always leave a single
// consistent final Redis state - never a partial or mixed one. Baseline
// and unsafe-state scenarios live in the two sibling files - split to keep
// every file within the repository's 400-line cap.
describe('CheckoutPendingReconciliationService.reconcileExpiredCheckoutPending (real Redis - concurrency)', () => {
  let client: Redis;
  let reconciliation: CheckoutPendingReconciliationService;
  let recovery: CheckoutReservationRecoveryService;
  let createdKeys: Set<string>;

  beforeAll(async () => {
    client = await connectRealRedis();
    const redisService = new RedisService(client);
    recovery = new CheckoutReservationRecoveryService(redisService);
    reconciliation = new CheckoutPendingReconciliationService(
      new CheckoutLeaseStateService(redisService),
      recovery,
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

  it('leaves a single consistent state when a concurrent revert races an in-flight resync attempt', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();
    await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, now - 30_000, now - 1_000, now);

    const [resyncAttempt, concurrentRevert] = await Promise.all([
      reconciliation.reconcileExpiredCheckoutPending({
        cartId,
        checkoutIdempotencyKey,
        durableAttemptState: 'PROCESSING',
        durableLastHeartbeatAt: now,
        now,
      }),
      recovery.checkoutRevert(cartId, checkoutIdempotencyKey, now),
    ]);

    expect(resyncAttempt.ok).toBe(true);
    expect(concurrentRevert.ok).toBe(true);
    // The reconciliation call either won the race (RESYNC_LEASE) or lost
    // it and fell back to LEASE_EXTENSION_FAILED - both are correct,
    // deterministic outcomes of a genuine race; what must never happen is
    // a mixed/partial final state.
    if (resyncAttempt.ok && resyncAttempt.action === 'REVERTED') {
      expect(resyncAttempt.reason).toBe('LEASE_EXTENSION_FAILED');
    }
    const after = await getRawCheckoutFields(client, cartId, productId);
    if (after?.status === 'CHECKOUT_PENDING') {
      expect(after.checkoutPendingExpiresAt).toBe(now + 180_000);
    } else {
      expect(after?.status).toBe('ACTIVE');
    }
  });

  it('remains idempotent under two concurrent duplicate reconciliation calls', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();
    await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, now - 30_000, now - 1_000, now);

    const input = {
      cartId,
      checkoutIdempotencyKey,
      durableAttemptState: 'PROCESSING' as const,
      durableLastHeartbeatAt: now,
      now,
    };
    const [a, b] = await Promise.all([
      reconciliation.reconcileExpiredCheckoutPending(input),
      reconciliation.reconcileExpiredCheckoutPending(input),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const after = await getRawCheckoutFields(client, cartId, productId);
    expect(after?.status).toBe('CHECKOUT_PENDING');
    expect(after?.checkoutPendingExpiresAt).toBe(now + 180_000);
  });

  it('leaves a single consistent, fully-consumed state when reconciliation races a concurrent finalize', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();
    await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, now - 10_000, now + 50_000, now);

    const [reconcileResult, finalizeResult] = await Promise.all([
      reconciliation.reconcileExpiredCheckoutPending({
        cartId,
        checkoutIdempotencyKey,
        durableAttemptState: 'COMMITTED',
        durableLastHeartbeatAt: null,
        now,
      }),
      recovery.finalizeCheckoutConsumption(cartId, checkoutIdempotencyKey),
    ]);

    expect(reconcileResult.ok).toBe(true);
    expect(finalizeResult.ok).toBe(true);
    // Whichever call's DEL ran second is a no-op against an
    // already-deleted key - the end state is always fully consumed.
    expect(await getRawCheckoutFields(client, cartId, productId)).toBeNull();
  });

  it('leaves a single consistent, fully-reverted state when reconciliation races a concurrent revert', async () => {
    const { cartId, customerId, checkoutIdempotencyKey } = checkoutIds();
    const productId = `product-${Math.random()}`;
    trackCheckoutKeysFor(createdKeys, cartId, [productId]);
    const now = Date.now();
    await seedPending(cartId, productId, customerId, checkoutIdempotencyKey, now - 10_000, now + 50_000, now);

    const [reconcileResult, concurrentRevert] = await Promise.all([
      reconciliation.reconcileExpiredCheckoutPending({
        cartId,
        checkoutIdempotencyKey,
        durableAttemptState: 'FAILED',
        durableLastHeartbeatAt: null,
        now,
      }),
      recovery.checkoutRevert(cartId, checkoutIdempotencyKey, now),
    ]);

    expect(reconcileResult.ok).toBe(true);
    expect(concurrentRevert.ok).toBe(true);
    expect((await getRawCheckoutFields(client, cartId, productId))?.status).toBe('ACTIVE');
  });

  it('is never referenced by CartService, OrdersService, or ProductsService', () => {
    const fs = jest.requireActual<typeof import('fs')>('fs');
    const path = jest.requireActual<typeof import('path')>('path');
    const roots = ['../../cart', '../../orders', '../../products'].map((rel) =>
      path.resolve(__dirname, rel),
    );

    function collectTsFiles(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries.flatMap((entry: import('fs').Dirent) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return collectTsFiles(full);
        return entry.name.endsWith('.ts') ? [full] : [];
      });
    }

    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of collectTsFiles(root)) {
        const contents = fs.readFileSync(file, 'utf8');
        if (contents.includes('CheckoutPendingReconciliationService')) {
          offenders.push(file);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
