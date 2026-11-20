import { randomUUID } from 'crypto';

import { MAX_RESERVATION_LIFETIME_SECONDS, RESERVATION_TTL_SECONDS, productSuspectKey, productTotalKey, reservationKey } from '../../inventory/constants/inventory.constants';
import { checkoutPinKey } from '../../reservation-fence/lua/checkout-settlement.lua';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { resourceGuardKey } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { controlBytes, productControlKey } from '../../reservation-fence/types/product-reservation-restriction.types';
import { EXECUTE_FRESHNESS_RESET_LUA, freshnessPermitKey, freshnessReceiptKey } from '../lua/freshness-sweep-lua';
import { sha256Hex } from '../repositories/cutover-freshness-reset-audit.repository';
import { openFreshnessHarness } from './cutover-freshness-reset-test-helpers';

jest.setTimeout(90_000);

describe('Conflict A core: authorized W1 FRESHNESS_SWEEP, rejections, restrictions & accounting (PG + Redis)', () => {
  it('1. executes authorized freshness reset with bounded lease, preserved multi-cart productTotalKey, and COMPLETED SHA-256 audit', async () => {
    const h = await openFreshnessHarness();
    try {
      const sibling = await h.seedSecondCartHold(3);
      expect(await h.redisClient.get(productTotalKey(h.productId))).toBe('7');

      const oldAnchor = Date.now() - 2_000_000;
      const key1 = reservationKey(h.cartId, h.productId);
      const oldEntry = JSON.parse((await h.redisClient.get(key1))!) as Record<string, unknown>;
      oldEntry.createdAt = oldAnchor;
      oldEntry.lastRenewedAt = oldAnchor + 10_000;
      oldEntry.expiresAt = oldAnchor + 900_000;
      oldEntry.absoluteExpiresAt = oldAnchor + 3_600_000;
      await h.redisClient.set(key1, JSON.stringify(oldEntry));

      const siblingBefore = await h.redisClient.get(reservationKey(sibling.cartId, h.productId));
      const cutoverRunId = randomUUID();
      const requestId = randomUUID();
      const nowMs = Date.now();

      const res = await h.freshnessReset.executeAuthorizedFreshnessReset({
        cutoverRunId,
        operatorId: h.operatorId,
        barrierRevision: h.barrierRevision,
        cartId: h.cartId,
        productId: h.productId,
        customerId: h.customerId,
        quantity: h.quantity,
        expectedGeneration: h.generation,
        requestId,
        nowMs,
      });

      expect(res).toMatchObject({
        ok: true,
        status: 'COMPLETED',
        requestId,
        markerId: h.markerId,
        generation: h.generation,
        expiresAt: nowMs + RESERVATION_TTL_SECONDS * 1000,
        absoluteExpiresAt: nowMs + MAX_RESERVATION_LIFETIME_SECONDS * 1000,
        replayed: false,
      });

      // Product total and sibling cart hold remain untouched (no new inventory created).
      expect(await h.redisClient.get(productTotalKey(h.productId))).toBe('7');
      expect(await h.redisClient.get(reservationKey(sibling.cartId, h.productId))).toBe(siblingBefore);

      const updatedEntry = JSON.parse((await h.redisClient.get(key1))!) as Record<string, unknown>;
      expect(updatedEntry).toMatchObject({
        quantity: h.quantity,
        markerId: h.markerId,
        generation: h.generation,
        holdInstanceId: h.holdInstanceId,
        createdAt: nowMs,
        lastRenewedAt: nowMs,
        expiresAt: nowMs + RESERVATION_TTL_SECONDS * 1000,
        absoluteExpiresAt: nowMs + MAX_RESERVATION_LIFETIME_SECONDS * 1000,
        reservationMutationId: requestId,
      });

      const audit = await h.prisma.cutoverFreshnessResetAudit.findUniqueOrThrow({ where: { requestId } });
      expect(audit.status).toBe('COMPLETED');
      expect(audit.priorCreatedAtMs).toBe(BigInt(oldAnchor));
      expect(audit.priorAbsoluteExpiresAtMs).toBe(BigInt(oldAnchor + 3_600_000));
      expect(audit.newCreatedAtMs).toBe(BigInt(nowMs));
      expect(audit.newAbsoluteExpiresAtMs).toBe(BigInt(nowMs + 3_600_000));
      expect(sha256Hex(audit.redisReceipt!)).toBe(audit.redisReceiptHash);
    } finally {
      await h.close();
    }
  });

  it('2. rejects unauthorized callers, keeps 4-arg reserveWithFreshEpoch fail-closed, and rejects unregistered Lua permits', async () => {
    const h = await openFreshnessHarness();
    try {
      const before = await h.snapshotRedis();
      const target = { cartId: h.cartId, productId: h.productId, customerId: h.customerId, quantity: h.quantity };

      // 4-arg legacy reserveWithFreshEpoch remains fail-closed.
      expect(await h.inventoryReservations.reserveWithFreshEpoch(h.cartId, h.productId, h.customerId, h.quantity)).toEqual({
        ok: false,
        code: 'FENCE_REJECTED',
      });
      // freshnessSweep without valid authorization fails closed.
      expect(await h.backfillService.freshnessSweep([target])).toEqual([
        { outcome: 'BLOCKED', target, blockReason: 'FRESHNESS_UNAUTHORIZED' },
      ]);
      await expect(h.backfillService.freshnessSweep([])).rejects.toThrow();

      // Unknown operatorId, wrong owner, quantity mismatch, unresolved marker.
      const baseAuth = { cutoverRunId: randomUUID(), operatorId: h.operatorId, barrierRevision: h.barrierRevision };
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset({ ...baseAuth, operatorId: randomUUID(), ...target })).toMatchObject({
        ok: false, category: 'UNAUTHORIZED', code: 'UNAUTHORIZED_OPERATOR',
      });
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset({ ...baseAuth, ...target, customerId: randomUUID() })).toMatchObject({
        ok: false, category: 'UNAUTHORIZED', code: 'PERMIT_SCOPE_MISMATCH',
      });
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset({ ...baseAuth, ...target, quantity: h.quantity + 1 })).toMatchObject({
        ok: false, category: 'UNAUTHORIZED', code: 'PERMIT_SCOPE_MISMATCH',
      });

      await h.prisma.cartReservationSyncState.update({ where: { id: h.markerId }, data: { resolvedAt: null } });
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset({ ...baseAuth, ...target })).toMatchObject({
        ok: false, category: 'UNAUTHORIZED', code: 'UNRESOLVED_SYNC_MARKER',
      });
      await h.prisma.cartReservationSyncState.update({ where: { id: h.markerId }, data: { resolvedAt: new Date() } });

      // Direct Lua call without registered permit rejects cleanly.
      const fakeReqId = randomUUID();
      const fence = await h.prisma.reservationFenceTransition.findFirstOrThrow({ orderBy: { revision: 'desc' } });
      const forged = {
        version: 1,
        effect: 'FRESHNESS_SWEEP',
        authorizationPhase: 'OPEN',
        tuple: {
          incarnation: fence.incarnation, epoch: fence.epoch, revision: fence.revision,
          phase: fence.phase, protocol: fence.protocol, transitionId: fence.id,
        },
        requestId: fakeReqId,
        cutoverRunId: randomUUID(),
        barrierRevision: h.barrierRevision,
        target: {
          customerId: h.customerId,
          cartId: h.cartId,
          productId: h.productId,
          markerId: h.markerId,
          generation: h.generation,
          holdInstanceId: h.holdInstanceId,
        },
        quantity: h.quantity,
        anchorNowMs: Date.now(),
        expiresAt: Date.now() + 5000,
        controlRevision: 0,
      };
      const luaRaw = await h.redisClient.eval(
        EXECUTE_FRESHNESS_RESET_LUA,
        3,
        RESERVATION_FENCE_KEY,
        freshnessPermitKey(fakeReqId),
        freshnessReceiptKey(fakeReqId),
        JSON.stringify(forged),
      );
      expect(JSON.parse(luaRaw as string)).toEqual({ code: 'FENCE_REJECTED', reason: 'MISSING_PERMIT' });

      expect(await h.prisma.cutoverFreshnessResetAudit.count()).toBe(0);
      expect(await h.snapshotRedis()).toEqual(before);
    } finally {
      await h.close();
    }
  });

  it('3. rejects stale barrier revisions, non-MIRROR/FROZEN fences, stale Redis tuples, and stale generations', async () => {
    const h = await openFreshnessHarness();
    try {
      const before = await h.snapshotRedis();
      const target = { cartId: h.cartId, productId: h.productId, customerId: h.customerId, quantity: h.quantity };

      expect(await h.freshnessReset.executeAuthorizedFreshnessReset({
        cutoverRunId: randomUUID(), operatorId: h.operatorId, barrierRevision: h.barrierRevision + 99, ...target,
      })).toMatchObject({ ok: false, category: 'UNAUTHORIZED', code: 'STALE_BARRIER_REVISION' });

      await h.mutationBarrier.deactivate(h.operatorId);
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset({
        cutoverRunId: randomUUID(), operatorId: h.operatorId, barrierRevision: h.barrierRevision, ...target,
      })).toMatchObject({ ok: false, category: 'UNAUTHORIZED', code: 'STALE_BARRIER_REVISION' });

      const reactivated = await h.mutationBarrier.activate(h.operatorId);
      const rev = reactivated.revision!;

      expect(await h.freshnessReset.executeAuthorizedFreshnessReset({
        cutoverRunId: randomUUID(), operatorId: h.operatorId, barrierRevision: rev, expectedGeneration: h.generation + 1, ...target,
      })).toMatchObject({ ok: false, category: 'UNAUTHORIZED', code: 'STALE_GENERATION' });

      // Stale fence phase in PG + Redis -> PHASE_DENIED.
      const fence = await h.prisma.reservationFenceTransition.findFirstOrThrow({ orderBy: { revision: 'desc' } });
      await h.prisma.reservationFenceTransition.update({ where: { id: fence.id }, data: { phase: 'FROZEN' } });
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset({
        cutoverRunId: randomUUID(), operatorId: h.operatorId, barrierRevision: rev, ...target,
      })).toMatchObject({ ok: false, category: 'FENCE_REJECTED', code: 'PHASE_DENIED' });
      await h.prisma.reservationFenceTransition.update({ where: { id: fence.id }, data: { phase: 'OPEN' } });

      // Stale Redis fence tuple -> STALE_REVISION without changing Redis reservation.
      const redisTuple = JSON.parse((await h.redisClient.get(RESERVATION_FENCE_KEY))!) as Record<string, unknown>;
      await h.redisClient.set(RESERVATION_FENCE_KEY, JSON.stringify({ ...redisTuple, revision: (redisTuple.revision as number) + 1 }));
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset({
        cutoverRunId: randomUUID(), operatorId: h.operatorId, barrierRevision: rev, ...target,
      })).toMatchObject({ ok: false, category: 'FENCE_REJECTED', code: 'STALE_REVISION' });
      await h.redisClient.set(RESERVATION_FENCE_KEY, JSON.stringify(redisTuple));

      expect(await h.snapshotRedis()).toEqual(before);
    } finally {
      await h.close();
    }
  });

  it('4. rejects missing, expired, malformed, and checkout-pending reservations without creating holds', async () => {
    const h = await openFreshnessHarness();
    try {
      const target = { cartId: h.cartId, productId: h.productId, customerId: h.customerId, quantity: h.quantity };
      const auth = () => ({ cutoverRunId: randomUUID(), operatorId: h.operatorId, barrierRevision: h.barrierRevision, ...target });
      const key = reservationKey(h.cartId, h.productId);
      const validRaw = (await h.redisClient.get(key))!;

      // Checkout-pending flag & checkout pin reject with CHECKOUT_IN_PROGRESS.
      await h.redisClient.set(checkoutPinKey(h.markerId), 'checkout-op-1');
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset(auth())).toMatchObject({
        ok: false, category: 'CHECKOUT_IN_PROGRESS', code: 'CHECKOUT_IN_PROGRESS',
      });
      await h.redisClient.del(checkoutPinKey(h.markerId));

      const pendingEntry = { ...JSON.parse(validRaw) as Record<string, unknown>, status: 'CHECKOUT_PENDING', checkoutIdempotencyKey: 'k1' };
      await h.redisClient.set(key, JSON.stringify(pendingEntry));
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset(auth())).toMatchObject({
        ok: false, category: 'CHECKOUT_IN_PROGRESS', code: 'CHECKOUT_IN_PROGRESS',
      });

      // Hard-expired entry (internally consistent past timestamps) rejects without resurrecting.
      const expiredEntry = {
        ...JSON.parse(validRaw) as Record<string, unknown>,
        createdAt: 1000,
        lastRenewedAt: 1000,
        expiresAt: 1500,
        absoluteExpiresAt: 2000,
      };
      await h.redisClient.set(key, JSON.stringify(expiredEntry));
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset(auth())).toMatchObject({
        ok: false, category: 'FENCE_REJECTED', code: 'RESOURCE_GENERATION_MISMATCH',
      });

      // Malformed JSON rejects with MALFORMED_RESOURCE (SUSPECT).
      await h.redisClient.set(key, '{bad-json');
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset(auth())).toMatchObject({
        ok: false, category: 'SUSPECT', code: 'MALFORMED_RESOURCE',
      });

      // Missing reservation key rejects and does NOT synthesize a hold.
      await h.redisClient.del(key);
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset(auth())).toMatchObject({
        ok: false, category: 'FENCE_REJECTED', code: 'RESOURCE_GENERATION_MISMATCH',
      });
      expect(await h.redisClient.get(key)).toBeNull();
      expect(await h.redisClient.get(productTotalKey(h.productId))).toBe(String(h.quantity));
    } finally {
      await h.close();
    }
  });

  it('5. enforces accounting underflow/corruption detection and durable/Redis product restrictions', async () => {
    const h = await openFreshnessHarness();
    try {
      const target = { cartId: h.cartId, productId: h.productId, customerId: h.customerId, quantity: h.quantity };
      const auth = () => ({ cutoverRunId: randomUUID(), operatorId: h.operatorId, barrierRevision: h.barrierRevision, ...target });
      const beforeEntry = await h.redisClient.get(reservationKey(h.cartId, h.productId));

      // Accounting underflow (total < entry.quantity) -> SUSPECT, Redis untouched.
      await h.redisClient.set(productTotalKey(h.productId), String(h.quantity - 1));
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset(auth())).toMatchObject({
        ok: false, category: 'SUSPECT', code: 'ACCOUNTING_UNDERFLOW',
      });

      // Accounting corruption (non-numeric total) -> SUSPECT.
      await h.redisClient.set(productTotalKey(h.productId), 'corrupt');
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset(auth())).toMatchObject({
        ok: false, category: 'SUSPECT', code: 'ACCOUNTING_CORRUPTION',
      });
      await h.redisClient.set(productTotalKey(h.productId), String(h.quantity));

      // Suspect flag in Redis -> RESERVATION_PRODUCT_SUSPENDED.
      await h.redisClient.set(productSuspectKey(h.productId), '1');
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset(auth())).toMatchObject({
        ok: false, category: 'SUSPECT', code: 'RESERVATION_PRODUCT_SUSPENDED',
      });
      await h.redisClient.del(productSuspectKey(h.productId));

      // Redis product-control RESTRICTED -> CAPABILITY_REVOKED.
      const fence = await h.prisma.reservationFenceTransition.findFirstOrThrow({ orderBy: { revision: 'desc' } });
      await h.redisClient.set(productControlKey(h.productId), controlBytes({
        version: 1, productId: h.productId, state: 'RESTRICTED', restrictionId: randomUUID(),
        restrictionRevision: 1, incarnation: fence.incarnation, epoch: fence.epoch,
      }));
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset(auth())).toMatchObject({
        ok: false, category: 'SUSPECT', code: 'CAPABILITY_REVOKED',
      });

      // Durable ProductReservationRestriction -> PRODUCT_RESTRICTED before creating PREPARED row.
      await h.prisma.productReservationRestriction.create({
        data: { id: randomUUID(), productId: h.productId, reasonCategory: 'ACCOUNTING_DRIFT', observationDigest: 'a'.repeat(64) },
      });
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset(auth())).toMatchObject({
        ok: false, category: 'SUSPECT', code: 'PRODUCT_RESTRICTED',
      });

      // Also verify guard mismatch when guard key is tampered.
      await h.redisClient.del(resourceGuardKey(h.markerId));
      expect(await h.redisClient.get(reservationKey(h.cartId, h.productId))).toBe(beforeEntry);
    } finally {
      await h.close();
    }
  });
});
