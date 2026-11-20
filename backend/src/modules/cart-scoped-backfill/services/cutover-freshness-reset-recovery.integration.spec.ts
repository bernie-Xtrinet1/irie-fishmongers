import { randomUUID } from 'crypto';

import { MAX_RESERVATION_LIFETIME_SECONDS, RESERVATION_TTL_SECONDS, productTotalKey, reservationKey } from '../../inventory/constants/inventory.constants';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import {
  EXECUTE_FRESHNESS_RESET_LUA,
  REGISTER_FRESHNESS_RESET_LUA,
  freshnessPermitKey,
  freshnessReceiptKey,
} from '../lua/freshness-sweep-lua';
import { deriveFreshnessRequestId, sha256Hex } from '../repositories/cutover-freshness-reset-audit.repository';
import { openFreshnessHarness } from './cutover-freshness-reset-test-helpers';

jest.setTimeout(90_000);

describe('Conflict A recovery: replay, post-Redis crash, pre-Redis crash, ambiguous evidence & concurrency', () => {
  it('1. handles duplicate request replay and conflicting requestId fail-closed without double-extending', async () => {
    const h = await openFreshnessHarness();
    try {
      const cutoverRunId = randomUUID();
      const requestId = randomUUID();
      const nowMs = Date.now();
      const input = {
        cutoverRunId,
        operatorId: h.operatorId,
        barrierRevision: h.barrierRevision,
        cartId: h.cartId,
        productId: h.productId,
        customerId: h.customerId,
        quantity: h.quantity,
        requestId,
        nowMs,
      };

      const first = await h.freshnessReset.executeAuthorizedFreshnessReset(input);
      expect(first).toMatchObject({ ok: true, status: 'COMPLETED', requestId, replayed: false });
      const snapAfterFirst = await h.snapshotRedis();

      // Exact replay with same requestId returns identical expiresAt & leaves Redis byte-identical.
      const replay1 = await h.freshnessReset.executeAuthorizedFreshnessReset({ ...input, nowMs: nowMs + 60_000 });
      expect(replay1).toEqual({ ...first, replayed: true });
      expect(await h.snapshotRedis()).toEqual(snapAfterFirst);

      // Same tuple replay omitting requestId also replays cleanly without inserting a second row.
      const replay2 = await h.freshnessReset.executeAuthorizedFreshnessReset({
        cutoverRunId,
        operatorId: h.operatorId,
        barrierRevision: h.barrierRevision,
        cartId: h.cartId,
        productId: h.productId,
        customerId: h.customerId,
        quantity: h.quantity,
        nowMs: nowMs + 120_000,
      });
      expect(replay2).toEqual({ ...first, replayed: true });
      expect(await h.prisma.cutoverFreshnessResetAudit.count({ where: { cutoverRunId } })).toBe(1);

      // Reusing same requestId for a different cutoverRunId rejects fail-closed.
      expect(await h.freshnessReset.executeAuthorizedFreshnessReset({
        ...input,
        cutoverRunId: randomUUID(),
      })).toMatchObject({ ok: false, category: 'UNAUTHORIZED', code: 'REQUEST_ID_CONFLICT' });

      // Direct Redis Lua replay with matching permit and existing receipt also stays idempotent.
      const fence = await h.prisma.reservationFenceTransition.findFirstOrThrow({ orderBy: { revision: 'desc' } });
      const directReq = {
        version: 1,
        effect: 'FRESHNESS_SWEEP',
        authorizationPhase: 'OPEN',
        tuple: {
          incarnation: fence.incarnation, epoch: fence.epoch, revision: fence.revision,
          phase: fence.phase, protocol: fence.protocol, transitionId: fence.id,
        },
        requestId,
        cutoverRunId,
        barrierRevision: h.barrierRevision,
        target: {
          customerId: h.customerId, cartId: h.cartId, productId: h.productId,
          markerId: h.markerId, generation: h.generation, holdInstanceId: h.holdInstanceId,
        },
        quantity: h.quantity,
        anchorNowMs: nowMs,
        expiresAt: 1,
        controlRevision: 0,
      };
      // Live permit cannot be re-registered (REPLAY_MISMATCH); after expiry/DEL, re-register + EXECUTE replays idempotently.
      const dupRegRaw = await h.redisClient.eval(
        REGISTER_FRESHNESS_RESET_LUA,
        2,
        RESERVATION_FENCE_KEY,
        freshnessPermitKey(requestId),
        JSON.stringify(directReq),
      );
      expect(JSON.parse(dupRegRaw as string)).toEqual({ code: 'FENCE_REJECTED', reason: 'REPLAY_MISMATCH' });

      await h.redisClient.del(freshnessPermitKey(requestId));
      const regRaw = await h.redisClient.eval(
        REGISTER_FRESHNESS_RESET_LUA,
        2,
        RESERVATION_FENCE_KEY,
        freshnessPermitKey(requestId),
        JSON.stringify(directReq),
      );
      const registered = JSON.parse(regRaw as string) as { code: string; value: unknown };
      expect(registered.code).toBe('ACCEPTED');
      const execRaw = await h.redisClient.eval(
        EXECUTE_FRESHNESS_RESET_LUA,
        3,
        RESERVATION_FENCE_KEY,
        freshnessPermitKey(requestId),
        freshnessReceiptKey(requestId),
        JSON.stringify(registered.value),
      );
      expect(JSON.parse(execRaw as string)).toMatchObject({ code: 'ACCEPTED', value: { replayed: true } });
      expect(await h.snapshotRedis()).toEqual(snapAfterFirst);
    } finally {
      await h.close();
    }
  });

  it('2. reconciles Redis mutation without PostgreSQL completion via verified receipt without re-extending', async () => {
    const h = await openFreshnessHarness();
    try {
      const cutoverRunId = randomUUID();
      const nowMs = Date.now() - 500;
      const markSpy = jest.spyOn(h.auditRepo, 'markCompleted').mockRejectedValueOnce(new Error('Simulated PG crash after Redis EXECUTE'));

      const interrupted = await h.freshnessReset.executeAuthorizedFreshnessReset({
        cutoverRunId,
        operatorId: h.operatorId,
        barrierRevision: h.barrierRevision,
        cartId: h.cartId,
        productId: h.productId,
        customerId: h.customerId,
        quantity: h.quantity,
        nowMs,
      });
      markSpy.mockRestore();

      expect(interrupted).toMatchObject({
        ok: false,
        category: 'ESCALATED',
        code: 'POST_REDIS_AUDIT_COMPLETION_FAILED',
        escalated: true,
      });
      const expectedRequestId = deriveFreshnessRequestId(cutoverRunId, h.barrierRevision, h.markerId, h.generation);
      const pending = await h.prisma.cutoverFreshnessResetAudit.findUniqueOrThrow({ where: { requestId: expectedRequestId } });
      expect(pending.status).toBe('PREPARED');

      const redisSnapAfterWrite = await h.snapshotRedis();
      const parsedEntry = JSON.parse(redisSnapAfterWrite.entry!) as { createdAt: number; absoluteExpiresAt: number };
      expect(parsedEntry.createdAt).toBe(nowMs);

      // Recovery observes verified Redis receipt, reconciles PREPARED -> COMPLETED, and never re-extends Redis.
      const recovered = await h.freshnessReset.recoverPreparedReset(pending.id);
      expect(recovered).toMatchObject({
        ok: true,
        status: 'COMPLETED',
        auditId: pending.id,
        requestId: expectedRequestId,
        expiresAt: nowMs + RESERVATION_TTL_SECONDS * 1000,
        absoluteExpiresAt: nowMs + MAX_RESERVATION_LIFETIME_SECONDS * 1000,
        replayed: true,
      });
      expect(await h.snapshotRedis()).toEqual(redisSnapAfterWrite);

      const completed = await h.prisma.cutoverFreshnessResetAudit.findUniqueOrThrow({ where: { id: pending.id } });
      expect(completed.status).toBe('COMPLETED');
      expect(sha256Hex(completed.redisReceipt!)).toBe(completed.redisReceiptHash);

      // Repeated recovery attempt remains idempotent and leaves Redis/DB unchanged.
      const secondRecovery = await h.freshnessReset.recoverPreparedReset(pending.id);
      expect(secondRecovery).toEqual(recovered);
      expect(await h.snapshotRedis()).toEqual(redisSnapAfterWrite);
    } finally {
      await h.close();
    }
  });

  it('3. fails closed and escalates when crashed before Redis mutation (missing execution evidence), never extending again', async () => {
    const h = await openFreshnessHarness();
    try {
      const beforeRedis = await h.snapshotRedis();
      const cutoverRunId = randomUUID();
      const requestId = randomUUID();
      const nowMs = Date.now();
      const fence = await h.prisma.reservationFenceTransition.findFirstOrThrow({ orderBy: { revision: 'desc' } });

      // Simulate crash right after COMMIT of PREPARED before Redis execution ever ran.
      const prepared = await h.prisma.cutoverFreshnessResetAudit.create({
        data: {
          requestId,
          cutoverRunId,
          barrierRevision: h.barrierRevision,
          fenceTransitionId: fence.id,
          incarnation: fence.incarnation,
          fenceEpoch: fence.epoch,
          fenceRevision: fence.revision,
          modeRevision: fence.modeRevision!,
          markerId: h.markerId,
          generation: h.generation,
          holdInstanceId: h.holdInstanceId,
          customerId: h.customerId,
          cartId: h.cartId,
          productId: h.productId,
          quantity: h.quantity,
          operatorId: h.operatorId,
          anchorNowMs: BigInt(nowMs),
        },
      });

      const recovered = await h.freshnessReset.recoverPreparedReset(prepared.id);
      expect(recovered).toMatchObject({
        ok: false,
        category: 'ESCALATED',
        code: 'MISSING_EXECUTION_EVIDENCE',
        escalated: true,
      });
      expect(await h.snapshotRedis()).toEqual(beforeRedis);

      const aborted = await h.prisma.cutoverFreshnessResetAudit.findUniqueOrThrow({ where: { id: prepared.id } });
      expect(aborted.status).toBe('ABORTED');
      expect(aborted.failureCode).toBe('MISSING_EXECUTION_EVIDENCE');

      // Re-running the same cutoverRunId or recovery keeps ABORTED and never extends Redis.
      const retrySameRun = await h.freshnessReset.executeAuthorizedFreshnessReset({
        cutoverRunId,
        operatorId: h.operatorId,
        barrierRevision: h.barrierRevision,
        cartId: h.cartId,
        productId: h.productId,
        customerId: h.customerId,
        quantity: h.quantity,
      });
      expect(retrySameRun).toMatchObject({ ok: false, category: 'ESCALATED', code: 'MISSING_EXECUTION_EVIDENCE' });
      expect(await h.snapshotRedis()).toEqual(beforeRedis);

      // Fresh operator cutover run succeeds cleanly after investigation.
      const freshRun = await h.freshnessReset.executeAuthorizedFreshnessReset({
        cutoverRunId: randomUUID(),
        operatorId: h.operatorId,
        barrierRevision: h.barrierRevision,
        cartId: h.cartId,
        productId: h.productId,
        customerId: h.customerId,
        quantity: h.quantity,
      });
      expect(freshRun).toMatchObject({ ok: true, status: 'COMPLETED', replayed: false });
    } finally {
      await h.close();
    }
  });

  it('4. fails closed and escalates when Redis execution evidence is ambiguous (entry mutated without receipt)', async () => {
    const h = await openFreshnessHarness();
    try {
      const cutoverRunId = randomUUID();
      const requestId = randomUUID();
      const nowMs = Date.now();
      const markSpy = jest.spyOn(h.auditRepo, 'markCompleted').mockRejectedValueOnce(new Error('Simulated DB crash'));

      await h.freshnessReset.executeAuthorizedFreshnessReset({
        cutoverRunId,
        operatorId: h.operatorId,
        barrierRevision: h.barrierRevision,
        cartId: h.cartId,
        productId: h.productId,
        customerId: h.customerId,
        quantity: h.quantity,
        requestId,
        nowMs,
      });
      markSpy.mockRestore();

      // Remove receipt key to simulate lost/ambiguous Redis receipt while entry bears requestId.
      await h.redisClient.del(freshnessReceiptKey(requestId));
      const snapBeforeRecovery = await h.snapshotRedis();

      const recovered = await h.freshnessReset.recoverPreparedReset(requestId);
      expect(recovered).toMatchObject({
        ok: false,
        category: 'ESCALATED',
        code: 'AMBIGUOUS_EXECUTION_EVIDENCE',
        escalated: true,
      });
      expect(await h.snapshotRedis()).toEqual(snapBeforeRecovery);
      expect((await h.prisma.cutoverFreshnessResetAudit.findUniqueOrThrow({ where: { requestId } })).status).toBe('ABORTED');
      expect((await h.prisma.cutoverFreshnessResetAudit.findUniqueOrThrow({ where: { requestId } })).failureCode).toBe(
        'AMBIGUOUS_EXECUTION_EVIDENCE',
      );
    } finally {
      await h.close();
    }
  });

  it('5. serializes concurrent requests for the same run and blocks concurrent overlapping second run when PREPARED', async () => {
    const h = await openFreshnessHarness();
    try {
      const cutoverRunId = randomUUID();
      const nowMs = Date.now();
      const req = {
        cutoverRunId,
        operatorId: h.operatorId,
        barrierRevision: h.barrierRevision,
        cartId: h.cartId,
        productId: h.productId,
        customerId: h.customerId,
        quantity: h.quantity,
        nowMs,
      };

      const [r1, r2] = await Promise.all([
        h.freshnessReset.executeAuthorizedFreshnessReset({ ...req }),
        h.freshnessReset.executeAuthorizedFreshnessReset({ ...req }),
      ]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.expiresAt).toBe(r2.expiresAt);
        expect([r1.replayed, r2.replayed].sort()).toEqual([false, true]);
      }
      expect(await h.prisma.cutoverFreshnessResetAudit.count({ where: { cutoverRunId } })).toBe(1);
      expect(await h.redisClient.get(productTotalKey(h.productId))).toBe(String(h.quantity));

      // Concurrent distinct cutoverRunId blocked when another run has an unresolved PREPARED record for the same marker/generation.
      const fence = await h.prisma.reservationFenceTransition.findFirstOrThrow({ orderBy: { revision: 'desc' } });
      await h.prisma.cutoverFreshnessResetAudit.create({
        data: {
          requestId: randomUUID(),
          cutoverRunId: randomUUID(),
          barrierRevision: h.barrierRevision,
          fenceTransitionId: fence.id,
          incarnation: fence.incarnation,
          fenceEpoch: fence.epoch,
          fenceRevision: fence.revision,
          modeRevision: fence.modeRevision!,
          markerId: h.markerId,
          generation: h.generation,
          holdInstanceId: h.holdInstanceId,
          customerId: h.customerId,
          cartId: h.cartId,
          productId: h.productId,
          quantity: h.quantity,
          operatorId: h.operatorId,
          anchorNowMs: BigInt(Date.now()),
        },
      });
      const overlapping = await h.freshnessReset.executeAuthorizedFreshnessReset({
        ...req,
        cutoverRunId: randomUUID(),
      });
      expect(overlapping).toMatchObject({
        ok: false,
        category: 'ESCALATED',
        code: 'CONCURRENT_FRESHNESS_IN_FLIGHT',
        escalated: true,
      });
      expect(await h.redisClient.get(reservationKey(h.cartId, h.productId))).toContain(`"quantity":${h.quantity}`);
    } finally {
      await h.close();
    }
  });
});
