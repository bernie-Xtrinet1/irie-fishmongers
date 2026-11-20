import { productSuspectKey, productTotalKey } from '../../inventory/constants/inventory.constants';
import { checkoutPinKey } from '../lua/checkout-settlement.lua';
import {
  EXECUTE_PRODUCT_SUSPECT_CLEARANCE_LUA,
  STAGE_PRODUCT_SUSPECT_CLEARANCE_LUA,
} from '../lua/product-suspect-clearance.lua';
import { productControlKey, restrictionDigest } from '../types/product-reservation-restriction.types';
import { clearancePermitKey, clearanceReceiptKey } from '../types/product-suspect-clearance.types';
import { seedClearanceIncident, withClearanceHarness } from './product-suspect-clearance-test-helpers';

describe('Clearance fault injection, crash recovery, concurrency & Gap 1A/1D safety', () => {
  jest.setTimeout(120_000);

  it('aborts cleanly on mid-E1 transport drop with unconsumed permit and quarantines if permit expires', () =>
    withClearanceHarness(async (ctx) => {
      const s = await seedClearanceIncident(ctx, { activeQty: 2 });
      const r1 = await ctx.clearance.requestClearance({
        productId: s.productId, requestedById: s.adminA.id, requestReason: 'E1_CRASH', permitTtlMs: 4000,
      });
      if (!r1.ok) throw new Error(r1.message);
      ctx.trackRequestKeys(r1.requestId);
      const app1 = await ctx.clearance.approveClearance({ recoveryId: r1.recoveryId, approvedById: s.adminB.id });
      if (!app1.ok) throw new Error(app1.message);

      const origEval = ctx.redis.eval.bind(ctx.redis);
      jest.spyOn(ctx.redis, 'eval').mockImplementationOnce(origEval).mockRejectedValueOnce(new Error('STAGE_LOST'));

      const crashed = await ctx.clearance.executeClearance({ recoveryId: r1.recoveryId });
      expect(crashed).toMatchObject({ ok: false, status: 'ABORTED', code: 'POSITIVELY_ESTABLISHED_NOT_APPLIED' });
      expect((await ctx.db.productReservationRestriction.findUniqueOrThrow({ where: { id: s.restriction.id } })).state).toBe('ENFORCED');
      expect((await ctx.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: s.marker.id } })).status).toBe('BLOCKED');

      // Second crash where permit disappears before recovery -> AMBIGUOUS_QUARANTINED (never assumes NOT_APPLIED)
      const r2 = await ctx.clearance.requestClearance({
        productId: s.productId, requestedById: s.adminA.id, requestReason: 'E1_EXPIRED_CRASH', permitTtlMs: 2000,
      });
      if (!r2.ok) throw new Error(r2.message);
      ctx.trackRequestKeys(r2.requestId);
      await ctx.clearance.approveClearance({ recoveryId: r2.recoveryId, approvedById: s.adminB.id });

      jest.spyOn(ctx.redis, 'eval')
        .mockImplementationOnce(origEval)
        .mockImplementationOnce(async () => {
          await ctx.client.del(clearancePermitKey(r2.requestId));
          throw new Error('STAGE_DROP_NO_PERMIT');
        });

      const qRes = await ctx.clearance.executeClearance({ recoveryId: r2.recoveryId });
      expect(qRes).toMatchObject({ ok: false, status: 'AMBIGUOUS_QUARANTINED', code: 'INSUFFICIENT_NON_EXECUTION_PROOF' });
      expect((await ctx.db.productReservationRestriction.findUniqueOrThrow({ where: { id: s.restriction.id } })).state).toBe('ENFORCED');
      expect((await ctx.db.productSuspectRecovery.findUniqueOrThrow({ where: { id: r2.recoveryId } })).status).toBe('AMBIGUOUS_QUARANTINED');
    }));

  it('post-E1 checkout pin denies E2 atomically, aborts cleanly, restores RESTRICTED, and keeps CLEARING absent', () =>
    withClearanceHarness(async (ctx) => {
      const s = await seedClearanceIncident(ctx, { activeQty: 2 });
      const req = await ctx.clearance.requestClearance({
        productId: s.productId, requestedById: s.adminA.id, requestReason: 'POST_E1_PIN',
      });
      if (!req.ok) throw new Error(req.message);
      ctx.trackRequestKeys(req.requestId);
      await ctx.clearance.approveClearance({ recoveryId: req.recoveryId, approvedById: s.adminB.id });

      const origEval = ctx.redis.eval.bind(ctx.redis);
      let stagedControlState: string | null = null;
      let pgRestrictionDuringExec: string | null = null;

      jest.spyOn(ctx.redis, 'eval').mockImplementation(async (script, keys, args) => {
        const res = await origEval(script, keys, args);
        if (script === STAGE_PRODUCT_SUSPECT_CLEARANCE_LUA) {
          stagedControlState = (JSON.parse((await ctx.client.get(productControlKey(s.productId)))!) as { state: string }).state;
          pgRestrictionDuringExec = (await ctx.db.productReservationRestriction.findUniqueOrThrow({ where: { id: s.restriction.id } })).state;
          await ctx.client.set(checkoutPinKey(s.marker.id), 'late-checkout');
        }
        return res;
      });

      const aborted = await ctx.clearance.executeClearance({ recoveryId: req.recoveryId });
      expect(stagedControlState).toBe('CLEARANCE_STAGED');
      expect(pgRestrictionDuringExec).toBe('ENFORCED'); // Gap 1A: never CLEARING
      expect(aborted).toMatchObject({ ok: false, status: 'ABORTED', code: 'POSITIVELY_ESTABLISHED_NOT_APPLIED' });

      // Suspect & total intact, control safely restored to RESTRICTED(1)
      expect(await ctx.client.exists(productSuspectKey(s.productId))).toBe(1);
      expect(await ctx.client.get(productTotalKey(s.productId))).toBe('2');
      expect(JSON.parse((await ctx.client.get(productControlKey(s.productId)))!)).toMatchObject({
        state: 'RESTRICTED', restrictionId: s.restriction.id, restrictionRevision: 1,
      });
    }));

  it('recovers post-E2 crash via ProductSuspectCrashEvidenceService without re-executing E2 and guards concurrent target change (Gap 1D)', () =>
    withClearanceHarness(async (ctx) => {
      const s = await seedClearanceIncident(ctx, { activeQty: 2, corruptStoredTotal: '7' });
      const req = await ctx.clearance.requestClearance({
        productId: s.productId, requestedById: s.adminA.id, requestReason: 'POST_E2_CRASH',
      });
      if (!req.ok) throw new Error(req.message);
      ctx.trackRequestKeys(req.requestId);
      await ctx.clearance.approveClearance({ recoveryId: req.recoveryId, approvedById: s.adminB.id });

      // Simulated crash right after E2 committed in Redis + concurrent generation bump on s.marker
      const origEval = ctx.redis.eval.bind(ctx.redis);
      let e2Calls = 0;
      jest.spyOn(ctx.redis, 'eval').mockImplementation(async (script, keys, args) => {
        if (script === EXECUTE_PRODUCT_SUSPECT_CLEARANCE_LUA) {
          e2Calls += 1;
          await origEval(script, keys, args);
          await ctx.db.cartReservationSyncState.update({
            where: { id: s.marker.id },
            data: { status: 'BLOCKED', blockReason: 'MODE_NOT_ADMITTING', generation: s.marker.generation + 1 },
          });
          throw new Error('SIMULATED_PG_CONNECTION_LOST_AFTER_E2');
        }
        return origEval(script, keys, args);
      });

      const recovered = await ctx.clearance.executeClearance({ recoveryId: req.recoveryId });
      expect(e2Calls).toBe(1);
      // recoverClearance never re-calls E2; completes COMPLETED + CLEARED + unblocks only matching comp target, skips modified marker!
      expect(recovered).toMatchObject({
        ok: true, status: 'COMPLETED', replayed: false, clearedControlRevision: 2,
        unblockedCompCount: 1, unblockedSyncCount: 0, skippedTargetCount: 1,
      });
      expect((await ctx.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: s.marker.id } })))
        .toMatchObject({ status: 'BLOCKED', blockReason: 'MODE_NOT_ADMITTING', generation: s.marker.generation + 1 });
      expect((await ctx.db.cartReservationCompensation.findUniqueOrThrow({ where: { id: s.compId! } })))
        .toMatchObject({ status: 'PENDING', blockReason: null });
      expect((await ctx.db.productReservationRestriction.findUniqueOrThrow({ where: { id: s.restriction.id } })))
        .toMatchObject({ state: 'CLEARED', clearedByRecoveryId: req.recoveryId });
    }));

  it('quarantines corrupt receipt in Redis and serializes concurrent request/approve/execute races + supports cycle 2 (rev 3->4)', () =>
    withClearanceHarness(async (ctx) => {
      const s = await seedClearanceIncident(ctx, { activeQty: 2 });

      // Concurrent request race -> exactly 1 succeeds, other gets ACTIVE_RECOVERY_EXISTS
      const [c1, c2] = await Promise.all([
        ctx.clearance.requestClearance({ productId: s.productId, requestedById: s.adminA.id, requestReason: 'RACE_1' }),
        ctx.clearance.requestClearance({ productId: s.productId, requestedById: s.adminB.id, requestReason: 'RACE_2' }),
      ]);
      const wins = [c1, c2].filter((r) => r.ok);
      const losses = [c1, c2].filter((r) => !r.ok);
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      const winner = wins[0]!;
      if (!winner.ok) throw new Error('Expected one winner');
      ctx.trackRequestKeys(winner.requestId);

      // Corrupt receipt before recovery completion -> AMBIGUOUS_QUARANTINED
      const approverId = (await ctx.db.productSuspectRecovery.findUniqueOrThrow({ where: { id: winner.recoveryId } })).requestedById === s.adminA.id
        ? s.adminB.id : s.adminA.id;
      await ctx.clearance.approveClearance({ recoveryId: winner.recoveryId, approvedById: approverId });
      await ctx.db.productSuspectRecovery.update({
        where: { id: winner.recoveryId },
        data: { status: 'EXECUTING', executingAt: new Date(), stagedControlRevision: 1 },
      });
      await ctx.client.set(clearanceReceiptKey(winner.requestId), '{corrupt');
      const obs = await ctx.clearance.observeClearance(winner.recoveryId);
      expect(obs.crashEvaluation?.nextStatus).toBe('AMBIGUOUS_QUARANTINED');

      const recResult = await ctx.clearance.recoverClearance(winner.recoveryId);
      expect(recResult).toMatchObject({ ok: false, status: 'AMBIGUOUS_QUARANTINED', code: 'CORRUPT_EXECUTION_RECEIPT' });

      // Fresh incident cycle 2 on a second product: rev 1->2 then rev 3->4 monotonic clearance
      const s2 = await seedClearanceIncident(ctx, { activeQty: 1, corruptStoredTotal: '1' });
      const cycle1Req = await ctx.clearance.requestClearance({ productId: s2.productId, requestedById: s2.adminA.id, requestReason: 'CYC1' });
      if (!cycle1Req.ok) throw new Error(cycle1Req.message);
      ctx.trackRequestKeys(cycle1Req.requestId);
      await ctx.clearance.approveClearance({ recoveryId: cycle1Req.recoveryId, approvedById: s2.adminB.id });
      expect((await ctx.clearance.executeClearance({ recoveryId: cycle1Req.recoveryId }))).toMatchObject({
        ok: true, clearedControlRevision: 2,
      });

      const rest2 = await ctx.db.productReservationRestriction.create({
        data: { productId: s2.productId, restrictionRevision: 3, reasonCategory: 'ACCOUNTING_DRIFT', observationDigest: restrictionDigest(`${s2.productId}-2`) },
      });
      expect(await ctx.restrictionService.install(rest2.id)).toBe('ENFORCED');
      const cycle2Req = await ctx.clearance.requestClearance({ productId: s2.productId, requestedById: s2.adminA.id, requestReason: 'CYC2' });
      if (!cycle2Req.ok) throw new Error(cycle2Req.message);
      ctx.trackRequestKeys(cycle2Req.requestId);
      expect(cycle2Req).toMatchObject({ ok: true, targetRestrictionRevision: 3, clearedControlRevision: 4 });
      await ctx.clearance.approveClearance({ recoveryId: cycle2Req.recoveryId, approvedById: s2.adminB.id });
      const exec2 = await ctx.clearance.executeClearance({ recoveryId: cycle2Req.recoveryId });
      expect(exec2).toMatchObject({ ok: true, status: 'COMPLETED', clearedControlRevision: 4 });
    }));
});
