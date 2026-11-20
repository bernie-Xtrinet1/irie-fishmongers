import { randomUUID } from 'crypto';

import { productSuspectKey, productTotalKey, reservationKey } from '../../inventory/constants/inventory.constants';
import { checkoutPinKey } from '../lua/checkout-settlement.lua';
import { productControlKey } from '../types/product-reservation-restriction.types';
import { clearanceReceiptKey } from '../types/product-suspect-clearance.types';
import { seedClearanceIncident, withClearanceHarness } from './product-suspect-clearance-test-helpers';
import { seedActiveAdminUser } from './product-suspect-recovery-test-helpers';

describe('Dual-control PRODUCT_SUSPECT clearance workflow (real PG + Redis)', () => {
  jest.setTimeout(120_000);

  it('enforces active admin dual-control, reject, approval expiry, and blocks invalid requests', () =>
    withClearanceHarness(async (ctx) => {
      const s = await seedClearanceIncident(ctx, { activeQty: 2 });
      const suspendedAdmin = await seedActiveAdminUser(ctx.db, 'SUSPENDED');
      const reqId = randomUUID();
      ctx.trackRequestKeys(reqId);

      // Non-admin / suspended requester rejected
      expect(await ctx.clearance.requestClearance({
        requestId: reqId, productId: s.productId, requestedById: s.customerId, requestReason: 'NO_ADMIN',
      })).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
      expect(await ctx.clearance.requestClearance({
        requestId: reqId, productId: s.productId, requestedById: suspendedAdmin.id, requestReason: 'SUSPENDED',
      })).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });

      // Null-restriction product rejected (Gap 1B)
      const noRest = await ctx.clearance.requestClearance({
        requestId: randomUUID(), productId: randomUUID(), requestedById: s.adminA.id, requestReason: 'NO_RESTRICTION',
      });
      expect(noRest).toMatchObject({ ok: false, code: 'NO_ACTIVE_RESTRICTION' });

      // Valid REQUESTED
      const r1 = await ctx.clearance.requestClearance({
        requestId: reqId, productId: s.productId, requestedById: s.adminA.id, requestReason: 'INCIDENT_AUDIT',
      });
      expect(r1).toMatchObject({
        ok: true, requestId: reqId, status: 'REQUESTED', targetRestrictionRevision: 1, clearedControlRevision: 2,
        targetReconciledTotal: 2, affectedMarkerCount: 1, affectedCompensationCount: 1,
      });
      if (!r1.ok) throw new Error(r1.message);

      // Restriction stays ENFORCED and targets stay BLOCKED
      expect((await ctx.db.productReservationRestriction.findUniqueOrThrow({ where: { id: s.restriction.id } })).state).toBe('ENFORCED');

      // Duplicate active recovery & conflicting requestId fail cleanly
      expect(await ctx.clearance.requestClearance({
        productId: s.productId, requestedById: s.adminB.id, requestReason: 'DUPLICATE',
      })).toMatchObject({ ok: false, code: 'ACTIVE_RECOVERY_EXISTS', recoveryId: r1.recoveryId });

      // Self-approval & suspended approver denied
      expect(await ctx.clearance.approveClearance({ recoveryId: r1.recoveryId, approvedById: s.adminA.id }))
        .toMatchObject({ ok: false, code: 'DUAL_CONTROL_VIOLATION' });
      expect(await ctx.clearance.approveClearance({ recoveryId: r1.recoveryId, approvedById: suspendedAdmin.id }))
        .toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
      expect(await ctx.clearance.executeClearance({ recoveryId: r1.recoveryId }))
        .toMatchObject({ ok: false, code: 'INVALID_STATE' });

      // REJECTED transition preserves ENFORCED restriction & BLOCKED rows
      const rej = await ctx.clearance.rejectClearance({
        recoveryId: r1.recoveryId, rejectedById: s.adminB.id, rejectionReason: 'NEED_MORE_EVIDENCE',
      });
      expect(rej).toMatchObject({ ok: true, status: 'REJECTED' });
      expect((await ctx.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: s.marker.id } })).status).toBe('BLOCKED');

      // Request ID reuse rejected
      expect(await ctx.clearance.requestClearance({
        requestId: reqId, productId: s.productId, requestedById: s.adminA.id, requestReason: 'REUSE_REQ',
      })).toMatchObject({ ok: false, code: 'REQUEST_ID_CONFLICT' });

      // Approval expiry before execute -> EXPIRED
      const r2 = await ctx.clearance.requestClearance({
        productId: s.productId, requestedById: s.adminA.id, requestReason: 'RETRY_AUDIT',
      });
      if (!r2.ok) throw new Error(r2.message);
      ctx.trackRequestKeys(r2.requestId);
      const app2 = await ctx.clearance.approveClearance({
        recoveryId: r2.recoveryId, approvedById: s.adminB.id, approvalTtlMs: 60_000,
      });
      expect(app2).toMatchObject({ ok: true, status: 'APPROVED' });
      if (!app2.ok) throw new Error(app2.message);

      const expiredExec = await ctx.clearance.executeClearance({
        recoveryId: r2.recoveryId, nowMs: app2.approvalExpiresAt.getTime() + 1_000,
      });
      expect(expiredExec).toMatchObject({ ok: false, code: 'APPROVAL_EXPIRED', status: 'EXPIRED' });
      expect((await ctx.db.productReservationRestriction.findUniqueOrThrow({ where: { id: s.restriction.id } })).state).toBe('ENFORCED');
    }));

  it('rejects checkout-pin, CHECKOUT_PENDING, corrupt entries, and over-allocated inventory', () =>
    withClearanceHarness(async (ctx) => {
      const s = await seedClearanceIncident(ctx, { activeQty: 2 });

      // 1. Checkout pin blocks request
      await ctx.client.set(checkoutPinKey(s.marker.id), 'active-checkout');
      expect(await ctx.clearance.requestClearance({
        productId: s.productId, requestedById: s.adminA.id, requestReason: 'PIN_TEST',
      })).toMatchObject({ ok: false, code: 'CHECKOUT_IN_PROGRESS' });
      await ctx.client.del(checkoutPinKey(s.marker.id));

      // 2. Over-allocated inventory blocks request
      await ctx.db.product.update({ where: { id: s.productId }, data: { quantityAvailable: 1 } });
      expect(await ctx.clearance.requestClearance({
        productId: s.productId, requestedById: s.adminA.id, requestReason: 'OVERALLOC',
      })).toMatchObject({ ok: false, code: 'OVER_ALLOCATED_INVENTORY' });
      await ctx.db.product.update({ where: { id: s.productId }, data: { quantityAvailable: 10 } });

      // 3. Corrupt reservation entry blocks request
      const origEntry = (await ctx.client.get(reservationKey(s.cartId, s.productId)))!;
      await ctx.client.set(reservationKey(s.cartId, s.productId), '{"broken"');
      expect(await ctx.clearance.requestClearance({
        productId: s.productId, requestedById: s.adminA.id, requestReason: 'CORRUPT',
      })).toMatchObject({ ok: false, code: 'CORRUPT_RESERVATION_ENTRY' });

      // 4. CHECKOUT_PENDING entry blocks request
      const parsedEntry = JSON.parse(origEntry) as Record<string, unknown>;
      await ctx.client.set(reservationKey(s.cartId, s.productId), JSON.stringify({
        ...parsedEntry, status: 'CHECKOUT_PENDING', checkoutIdempotencyKey: 'chk-1',
        checkoutPendingAt: Date.now(), checkoutPendingExpiresAt: Date.now() + 30_000,
      }));
      expect(await ctx.clearance.requestClearance({
        productId: s.productId, requestedById: s.adminA.id, requestReason: 'CHECKOUT_PENDING',
      })).toMatchObject({ ok: false, code: 'CHECKOUT_IN_PROGRESS' });
    }));

  it.each([
    { label: 'ENFORCED with active qty=3 and drifted total=9', activeQty: 3, corruptStoredTotal: '9', installInPg: true },
    { label: 'PREPARED with zero active qty and absent total', activeQty: 0, corruptStoredTotal: null, installInPg: false },
  ])('clears $label end-to-end, blocks stale rev=1 reinstall, and replays idempotently', ({ activeQty, corruptStoredTotal, installInPg }) =>
    withClearanceHarness(async (ctx) => {
      const s = await seedClearanceIncident(ctx, { activeQty, corruptStoredTotal, installInPg });
      const req = await ctx.clearance.requestClearance({
        productId: s.productId, requestedById: s.adminA.id, requestReason: 'FULL_CLEARANCE',
      });
      expect(req).toMatchObject({ ok: true, targetReconciledTotal: activeQty, clearedControlRevision: 2 });
      if (!req.ok) throw new Error(req.message);
      ctx.trackRequestKeys(req.requestId);

      // Assert CLEARING was never used; state stays PREPARED / ENFORCED before and during approval
      const preApproveRest = await ctx.db.productReservationRestriction.findUniqueOrThrow({ where: { id: s.restriction.id } });
      expect(preApproveRest.state).toBe(installInPg ? 'ENFORCED' : 'PREPARED');

      const app = await ctx.clearance.approveClearance({ recoveryId: req.recoveryId, approvedById: s.adminB.id });
      if (!app.ok) throw new Error(app.message);

      const exec = await ctx.clearance.executeClearance({ recoveryId: req.recoveryId, executorAdminId: s.adminB.id });
      expect(exec).toMatchObject({
        ok: true, status: 'COMPLETED', replayed: false, clearedControlRevision: 2,
        targetReconciledTotal: activeQty, unblockedSyncCount: 1, unblockedCompCount: 1, skippedTargetCount: 0,
      });

      // Redis physical state verified: repaired total, deleted suspect, ALLOW(2), permanent receipt PTTL=-1
      expect(await ctx.client.get(productTotalKey(s.productId))).toBe(String(activeQty));
      expect(await ctx.client.exists(productSuspectKey(s.productId))).toBe(0);
      expect(JSON.parse((await ctx.client.get(productControlKey(s.productId)))!)).toMatchObject({
        state: 'ALLOW', restrictionId: null, restrictionRevision: 2, incarnation: s.tuple.incarnation, epoch: s.tuple.epoch,
      });
      expect(await ctx.client.pttl(productControlKey(s.productId))).toBe(-1);
      expect(await ctx.client.pttl(clearanceReceiptKey(req.requestId))).toBe(-1);

      // PG direct PREPARED|ENFORCED -> CLEARED & targets unblocked
      const postRest = await ctx.db.productReservationRestriction.findUniqueOrThrow({ where: { id: s.restriction.id } });
      expect(postRest).toMatchObject({ state: 'CLEARED', clearedByRecoveryId: req.recoveryId });
      expect(await ctx.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: s.marker.id } }))
        .toMatchObject({ status: 'PENDING', blockReason: null });
      expect(await ctx.db.cartReservationCompensation.findUniqueOrThrow({ where: { id: s.compId! } }))
        .toMatchObject({ status: 'PENDING', blockReason: null });

      // Gap 1B: Legacy restrictionRevision=1 cannot reinstall over ALLOW(2)
      expect(await ctx.restrictionService.install(s.restriction.id)).toBe('UNRESOLVED');

      // Idempotent replay performs zero Redis mutations
      const snapControl = await ctx.client.get(productControlKey(s.productId));
      const replay = await ctx.clearance.executeClearance({ recoveryId: req.recoveryId });
      expect(replay).toMatchObject({ ok: true, status: 'COMPLETED', replayed: true, clearedControlRevision: 2 });
      expect(await ctx.client.get(productControlKey(s.productId))).toBe(snapControl);

      // Next ordinary W1 reservation works cleanly at revision 2
      if (activeQty > 0) {
        await ctx.db.cartReservationSyncState.update({ where: { id: s.marker.id }, data: { expectedQuantity: activeQty + 1 } });
        expect((await ctx.ordinary.reserve(s.cartId, s.productId, s.customerId, activeQty + 1)).code).toBe('ACCEPTED');
      } else {
        expect((await ctx.ordinary.reserve(s.cartId, s.productId, s.customerId, 2)).code).toBe('ACCEPTED');
      }
    }));
});
