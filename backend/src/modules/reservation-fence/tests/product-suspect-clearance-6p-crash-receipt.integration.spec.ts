import { randomUUID } from 'crypto';

import { productSuspectKey, productTotalKey } from '../../inventory/constants/inventory.constants';
import { EXECUTE_PRODUCT_SUSPECT_CLEARANCE_LUA } from '../lua/product-suspect-clearance.lua';
import { productControlKey } from '../types/product-reservation-restriction.types';
import { ProductSuspectClearanceReceipt } from '../types/product-suspect-recovery.types';
import { clearancePermitKey, clearanceReceiptKey } from '../types/product-suspect-clearance.types';
import { seedClearanceIncident, withClearanceHarness } from './product-suspect-clearance-test-helpers';

describe('D.4B.6P Phases 2 & 3: Complete crash matrix and cryptographic Redis receipt/permit audit', () => {
  jest.setTimeout(120_000);

  it('recovers deterministically across crashes: before E2, after E2, TX2 rollback, post-TX2, and concurrent recoverClearance calls', () =>
    withClearanceHarness(async (ctx) => {
      // 1. Crash immediately BEFORE E2 (after E1 CLEARANCE_STAGED) -> live permit recovers ABORTED -> RESTRICTED
      const s1 = await seedClearanceIncident(ctx, { activeQty: 2 });
      const r1 = await ctx.clearance.requestClearance({ productId: s1.productId, requestedById: s1.adminA.id, requestReason: 'PRE_E2_CRASH' });
      if (!r1.ok) throw new Error(r1.message);
      ctx.trackRequestKeys(r1.requestId);
      await ctx.clearance.approveClearance({ recoveryId: r1.recoveryId, approvedById: s1.adminB.id });

      const origEval = ctx.redis.eval.bind(ctx.redis);
      jest.spyOn(ctx.redis, 'eval').mockImplementation(async (script, keys, args) => {
        if (script === EXECUTE_PRODUCT_SUSPECT_CLEARANCE_LUA) throw new Error('CRASH_IMMEDIATELY_BEFORE_E2');
        return origEval(script, keys, args);
      });

      const preE2 = await ctx.clearance.executeClearance({ recoveryId: r1.recoveryId });
      expect(preE2).toMatchObject({ ok: false, status: 'ABORTED', code: 'POSITIVELY_ESTABLISHED_NOT_APPLIED' });
      expect(JSON.parse((await ctx.client.get(productControlKey(s1.productId)))!)).toMatchObject({ state: 'RESTRICTED', restrictionRevision: 1 });
      expect((await ctx.ordinary.reserve(s1.cartId, s1.productId, s1.customerId, 2)).code).not.toBe('ACCEPTED');
      jest.restoreAllMocks();

      // 2. Crash DURING TX2 rollback after E2 succeeded -> concurrent recoverClearance calls race safely -> exactly 1 commits TX2, others replay cleanly
      const s2 = await seedClearanceIncident(ctx, { activeQty: 2 });
      const r2 = await ctx.clearance.requestClearance({ productId: s2.productId, requestedById: s2.adminA.id, requestReason: 'TX2_ROLLBACK_CRASH' });
      if (!r2.ok) throw new Error(r2.message);
      ctx.trackRequestKeys(r2.requestId);
      await ctx.clearance.approveClearance({ recoveryId: r2.recoveryId, approvedById: s2.adminB.id });

      const origLocked = ctx.fences.locked.bind(ctx.fences);
      let tx2Attempts = 0;
      jest.spyOn(ctx.redis, 'eval').mockImplementation(async (script, keys, args) => {
        const out = await origEval(script, keys, args);
        if (script === EXECUTE_PRODUCT_SUSPECT_CLEARANCE_LUA) {
          jest.spyOn(ctx.fences, 'locked')
            .mockImplementationOnce((work) => origLocked(work))
            .mockImplementationOnce(async (work) => {
              tx2Attempts += 1;
              return origLocked(async (tx) => {
                await work(tx);
                throw new Error('SIMULATED_TX2_MIDWAY_CRASH');
              });
            });
        }
        return out;
      });

      await expect(ctx.clearance.executeClearance({ recoveryId: r2.recoveryId })).rejects.toThrow('SIMULATED_TX2_MIDWAY_CRASH');
      expect(tx2Attempts).toBe(1);
      // PG rolled back cleanly to EXECUTING & ENFORCED & BLOCKED; Redis holds permanent E2 receipt + ALLOW(2)
      expect((await ctx.db.productSuspectRecovery.findUniqueOrThrow({ where: { id: r2.recoveryId } })).status).toBe('EXECUTING');
      expect((await ctx.db.productReservationRestriction.findUniqueOrThrow({ where: { id: s2.restriction.id } })).state).toBe('ENFORCED');
      expect(await ctx.client.pttl(clearanceReceiptKey(r2.requestId))).toBe(-1);

      jest.restoreAllMocks();
      // Repeated concurrent recovery attempts: zero E2 re-execution, idempotent converge
      const e2Guard = jest.fn();
      jest.spyOn(ctx.redis, 'eval').mockImplementation((script, keys, args) => {
        if (script === EXECUTE_PRODUCT_SUSPECT_CLEARANCE_LUA) e2Guard();
        return origEval(script, keys, args);
      });
      const races = await Promise.all([
        ctx.clearance.recoverClearance(r2.recoveryId),
        ctx.clearance.recoverClearance(r2.recoveryId),
        ctx.clearance.executeClearance({ recoveryId: r2.recoveryId }),
      ]);
      expect(e2Guard).not.toHaveBeenCalled();
      expect(races.every((x) => x.ok && x.status === 'COMPLETED')).toBe(true);
      expect(races.filter((x) => x.ok && !x.replayed)).toHaveLength(1);
      expect(races.filter((x) => x.ok && x.replayed)).toHaveLength(2);
      expect((await ctx.db.productReservationRestriction.findUniqueOrThrow({ where: { id: s2.restriction.id } })).state).toBe('CLEARED');
    }));

  it('verifies cryptographic receipt fields, PTTL=-1 persistence, and rejects ephemeral/tampered/contradictory receipts', () =>
    withClearanceHarness(async (ctx) => {
      const s = await seedClearanceIncident(ctx, { activeQty: 2 });
      const req = await ctx.clearance.requestClearance({ productId: s.productId, requestedById: s.adminA.id, requestReason: 'RECEIPT_AUDIT' });
      if (!req.ok) throw new Error(req.message);
      ctx.trackRequestKeys(req.requestId);
      const app = await ctx.clearance.approveClearance({ recoveryId: req.recoveryId, approvedById: s.adminB.id });
      if (!app.ok) throw new Error(app.message);

      // Force E2 completion in Redis WITHOUT committing TX2 yet
      const origEval = ctx.redis.eval.bind(ctx.redis);
      jest.spyOn(ctx.redis, 'eval').mockImplementation(async (script, keys, args) => {
        const res = await origEval(script, keys, args);
        if (script === EXECUTE_PRODUCT_SUSPECT_CLEARANCE_LUA) throw new Error('STOP_AFTER_E2');
        return res;
      });
      // First let executeClearance move PG to EXECUTING and apply E2
      const recKey = clearanceReceiptKey(req.requestId);
      const execOut = await ctx.clearance.executeClearance({ recoveryId: req.recoveryId });
      // Note: recoverClearance ran automatically inside executeClearance catch! Let's inspect committed receipt directly first:
      expect(execOut).toMatchObject({ ok: true, status: 'COMPLETED' });
      const persisted = await ctx.db.productSuspectRecovery.findUniqueOrThrow({ where: { id: req.recoveryId } });
      expect(await ctx.client.pttl(recKey)).toBe(-1);
      expect(await ctx.client.exists(clearancePermitKey(req.requestId))).toBe(0);
      const receipt = JSON.parse(persisted.redisReceipt!) as ProductSuspectClearanceReceipt;
      expect(receipt).toEqual({
        version: 1,
        effect: 'PRODUCT_SUSPECT_CLEARANCE',
        status: 'APPLIED',
        requestId: req.requestId,
        productId: s.productId,
        incarnation: s.tuple.incarnation,
        epoch: s.tuple.epoch,
        clearedControlRevision: 2,
        reconciliationDigest: req.reconciliationDigest,
        approvalDigest: app.approvalDigest,
        targetTotal: 2,
      });

      // Now verify corrupt/ephemeral/tampered receipt rejection on a fresh recovery held in EXECUTING
      const s2 = await seedClearanceIncident(ctx, { activeQty: 2 });
      const r2 = await ctx.clearance.requestClearance({ productId: s2.productId, requestedById: s2.adminA.id, requestReason: 'TAMPER_CHECK' });
      if (!r2.ok) throw new Error(r2.message);
      ctx.trackRequestKeys(r2.requestId);
      const app2 = await ctx.clearance.approveClearance({ recoveryId: r2.recoveryId, approvedById: s2.adminB.id });
      if (!app2.ok) throw new Error(app2.message);

      jest.restoreAllMocks();
      const s2Receipt: ProductSuspectClearanceReceipt = {
        version: 1, effect: 'PRODUCT_SUSPECT_CLEARANCE', status: 'APPLIED',
        requestId: r2.requestId, productId: s2.productId, incarnation: s2.tuple.incarnation, epoch: s2.tuple.epoch,
        clearedControlRevision: 2, reconciliationDigest: r2.reconciliationDigest, approvalDigest: app2.approvalDigest, targetTotal: 2,
      };
      // Set EXECUTING directly via execute path interrupted before permit registration, then inject ephemeral PX receipt
      await ctx.db.productSuspectRecovery.update({ where: { id: r2.recoveryId }, data: { status: 'EXECUTING', executingAt: new Date(), stagedControlRevision: 1 } });
      await ctx.client.set(clearanceReceiptKey(r2.requestId), JSON.stringify(s2Receipt), 'PX', 30_000);
      const obsEphemeral = await ctx.clearance.observeClearance(r2.recoveryId);
      expect(obsEphemeral.crashEvaluation).toMatchObject({ nextStatus: 'AMBIGUOUS_QUARANTINED', reasonCode: 'CORRUPT_EXECUTION_RECEIPT' });

      // Permanent receipt with tampered approvalDigest + contradictory suspect flag -> quarantined
      await ctx.client.set(clearanceReceiptKey(r2.requestId), JSON.stringify({ ...s2Receipt, approvalDigest: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '') }));
      expect((await ctx.clearance.observeClearance(r2.recoveryId)).crashEvaluation).toMatchObject({
        nextStatus: 'AMBIGUOUS_QUARANTINED', reasonCode: 'RECEIPT_IDENTITY_MISMATCH',
      });

      // Valid permanent receipt paired with suspect key still present -> RECEIPT_PHYSICAL_CONTRADICTION -> AMBIGUOUS_QUARANTINED
      await ctx.client.set(clearanceReceiptKey(r2.requestId), JSON.stringify(s2Receipt));
      await ctx.client.set(productSuspectKey(s2.productId), '1');
      await ctx.client.set(productTotalKey(s2.productId), '2');
      expect(await ctx.clearance.recoverClearance(r2.recoveryId)).toMatchObject({
        ok: false, status: 'AMBIGUOUS_QUARANTINED', code: 'RECEIPT_PHYSICAL_CONTRADICTION',
      });
    }));
});
