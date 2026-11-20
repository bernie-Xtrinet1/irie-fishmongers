import { randomUUID } from 'crypto';

import {
  EXECUTE_FRESHNESS_RESET_LUA,
  REGISTER_FRESHNESS_RESET_LUA,
  freshnessPermitKey,
  freshnessReceiptKey,
} from '../../cart-scoped-backfill/lua/freshness-sweep-lua';
import { productSuspectKey } from '../../inventory/constants/inventory.constants';
import {
  REGISTER_ORDINARY_RESERVATION,
  WRITE_ORDINARY_RESERVATION,
} from '../../inventory/lua/ordinary-reservation-lua';
import { ReservationAvailabilityService } from '../../reservation-engine-mode/services/reservation-availability.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { ORDINARY_PHYSICAL_EXECUTE, ORDINARY_PHYSICAL_REGISTER } from '../lua/ordinary-command-physical.lua';
import { EXECUTE_PRODUCT_SUSPECT_CLEARANCE_LUA } from '../lua/product-suspect-clearance.lua';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { ordinaryHoldInstanceId } from '../ordinary-hold-instance-id';
import { ordinaryPhysicalLedgerKey, OrdinaryPhysicalIdentity } from '../types/ordinary-command-physical.types';
import { controlBytes, productControlKey } from '../types/product-reservation-restriction.types';
import { clearancePermitKey, clearanceReceiptKey } from '../types/product-suspect-clearance.types';
import { seedClearanceIncident, withClearanceHarness } from './product-suspect-clearance-test-helpers';

describe('Gap 1C CART_SCOPED availability fail-closed & Phase 2 mandatory controlRevision Lua pinning', () => {
  jest.setTimeout(120_000);

  it('fails closed on every CART_SCOPED availability hazard and opens exact availability only after verified clearance', () =>
    withClearanceHarness(async (ctx) => {
      const s = await seedClearanceIncident(ctx, { activeQty: 3 });
      const modeService = { getCurrentMode: jest.fn().mockResolvedValue('CART_SCOPED') } as unknown as ReservationEngineModeService;
      const availability = new ReservationAvailabilityService(modeService, ctx.inventoryReservations);

      // 1. RESTRICTED + suspect -> fails closed
      expect(await availability.getGeneralAvailability(s.productId, 10)).toEqual({ ok: false, code: 'RESERVATION_STRUCTURE_DRIFT' });

      // 2. CLEARANCE_STAGED -> fails closed
      const origCtrl = (await ctx.client.get(productControlKey(s.productId)))!;
      await ctx.client.set(productControlKey(s.productId), controlBytes({
        version: 1, productId: s.productId, state: 'CLEARANCE_STAGED', restrictionId: s.restriction.id,
        restrictionRevision: 1, incarnation: s.tuple.incarnation, epoch: s.tuple.epoch,
      }));
      await ctx.client.del(productSuspectKey(s.productId));
      expect(await availability.getGeneralAvailability(s.productId, 10)).toEqual({ ok: false, code: 'RESERVATION_STRUCTURE_DRIFT' });

      // 3. Missing Redis control while PG restriction active -> MUST NOT authorize (fails closed)
      await ctx.client.del(productControlKey(s.productId));
      expect(await availability.getGeneralAvailability(s.productId, 10)).toEqual({ ok: false, code: 'RESERVATION_STRUCTURE_DRIFT' });

      // 4. PG says RESTRICTED while Redis illegally forged ALLOW(0) -> PG/Redis disagreement fails closed
      await ctx.client.set(productControlKey(s.productId), controlBytes({
        version: 1, productId: s.productId, state: 'ALLOW', restrictionId: null,
        restrictionRevision: 0, incarnation: s.tuple.incarnation, epoch: s.tuple.epoch,
      }));
      expect(await availability.getGeneralAvailability(s.productId, 10)).toEqual({ ok: false, code: 'RESERVATION_STRUCTURE_DRIFT' });

      // 5. Restore RESTRICTED + suspect and run real dual-control clearance
      await ctx.client.set(productControlKey(s.productId), origCtrl);
      await ctx.client.set(productSuspectKey(s.productId), '1');
      const req = await ctx.clearance.requestClearance({ productId: s.productId, requestedById: s.adminA.id, requestReason: 'AVAIL_TEST' });
      if (!req.ok) throw new Error(req.message);
      ctx.trackRequestKeys(req.requestId);
      await ctx.clearance.approveClearance({ recoveryId: req.recoveryId, approvedById: s.adminB.id });

      // Blocking recovery status (APPROVED / EXECUTING) fails closed even if Redis had stale ALLOW
      await ctx.client.del(productSuspectKey(s.productId));
      await ctx.client.set(productControlKey(s.productId), controlBytes({
        version: 1, productId: s.productId, state: 'ALLOW', restrictionId: null, restrictionRevision: 2,
        incarnation: s.tuple.incarnation, epoch: s.tuple.epoch,
      }));
      expect(await availability.getGeneralAvailability(s.productId, 10)).toEqual({ ok: false, code: 'RESERVATION_STRUCTURE_DRIFT' });

      await ctx.client.set(productControlKey(s.productId), origCtrl);
      await ctx.client.set(productSuspectKey(s.productId), '1');
      expect((await ctx.clearance.executeClearance({ recoveryId: req.recoveryId })).ok).toBe(true);

      // Cleanly cleared -> returns exact 10 - 3 = 7 and own-cart 10
      expect(await availability.getGeneralAvailability(s.productId, 10)).toEqual({
        ok: true, mode: 'CART_SCOPED', source: 'CART_SCOPED', available: 7,
      });
      expect(await availability.getCartAdmissionAvailability(s.productId, 10, s.cartId)).toEqual({
        ok: true, mode: 'CART_SCOPED', source: 'CART_SCOPED', available: 10,
      });

      // 6. Malformed, finite-TTL, wrong-incarnation, wrong-revision, and missing-control after prior clearance ALL fail closed
      const validAllow2 = (await ctx.client.get(productControlKey(s.productId)))!;
      await ctx.client.set(productControlKey(s.productId), '{malformed');
      expect(await availability.getGeneralAvailability(s.productId, 10)).toEqual({ ok: false, code: 'RESERVATION_STRUCTURE_DRIFT' });

      await ctx.client.set(productControlKey(s.productId), validAllow2, 'PX', 10_000);
      expect(await availability.getGeneralAvailability(s.productId, 10)).toEqual({ ok: false, code: 'RESERVATION_STRUCTURE_DRIFT' });

      await ctx.client.set(productControlKey(s.productId), controlBytes({
        version: 1, productId: s.productId, state: 'ALLOW', restrictionId: null, restrictionRevision: 2,
        incarnation: randomUUID(), epoch: s.tuple.epoch,
      }));
      expect(await availability.getGeneralAvailability(s.productId, 10)).toEqual({ ok: false, code: 'RESERVATION_STRUCTURE_DRIFT' });

      await ctx.client.set(productControlKey(s.productId), controlBytes({
        version: 1, productId: s.productId, state: 'ALLOW', restrictionId: null, restrictionRevision: 4,
        incarnation: s.tuple.incarnation, epoch: s.tuple.epoch,
      }));
      expect(await availability.getGeneralAvailability(s.productId, 10)).toEqual({ ok: false, code: 'RESERVATION_STRUCTURE_DRIFT' });

      await ctx.client.del(productControlKey(s.productId));
      expect(await availability.getGeneralAvailability(s.productId, 10)).toEqual({ ok: false, code: 'RESERVATION_STRUCTURE_DRIFT' });
    }));

  it('enforces mandatory controlRevision in W1, physical W1, and Freshness Lua while preserving CANCEL_W1 without controlRevision', () =>
    withClearanceHarness(async (ctx) => {
      const s = await seedClearanceIncident(ctx, { activeQty: 2 });
      const req = await ctx.clearance.requestClearance({ productId: s.productId, requestedById: s.adminA.id, requestReason: 'LUA_PIN' });
      if (!req.ok) throw new Error(req.message);
      ctx.trackRequestKeys(req.requestId);
      await ctx.clearance.approveClearance({ recoveryId: req.recoveryId, approvedById: s.adminB.id });
      await ctx.clearance.executeClearance({ recoveryId: req.recoveryId });

      // 1. Older W1 permit without controlRevision -> MALFORMED_PERMIT
      const w1NoRevReq = randomUUID();
      const w1NoRevKey = `reservation:fence:w1:${w1NoRevReq}`;
      ctx.keys.add(w1NoRevKey);
      const resource = {
        markerId: s.marker.id, productId: s.productId, cartId: s.cartId, customerId: s.customerId,
        generation: 0, holdInstanceId: ordinaryHoldInstanceId(s.marker.id, 0),
      };
      expect(JSON.parse(String(await ctx.redis.eval(REGISTER_ORDINARY_RESERVATION, [RESERVATION_FENCE_KEY, w1NoRevKey], [JSON.stringify({
        version: 1, tuple: s.tuple, target: resource, from: null, quantity: 2, requestId: w1NoRevReq, expiresAt: 1,
      })])))).toEqual({ code: 'FENCE_REJECTED', reason: 'MALFORMED_PERMIT' });

      // Even if forged in Redis directly without controlRevision -> WRITE rejects MALFORMED_PERMIT
      expect(JSON.parse(String(await ctx.redis.eval(WRITE_ORDINARY_RESERVATION, [RESERVATION_FENCE_KEY, w1NoRevKey], [JSON.stringify({
        version: 1, tuple: s.tuple, target: resource, from: null, quantity: 2, requestId: w1NoRevReq, expiresAt: 1,
      })])))).toEqual({ code: 'FENCE_REJECTED', reason: 'MALFORMED_PERMIT' });

      // 2. Physical W1 grant without controlRevision -> REJECTED; CANCEL_W1 without controlRevision -> ACCEPTED (not W1)
      const ledger = ordinaryPhysicalLedgerKey(s.marker.id);
      ctx.keys.add(ledger);
      ctx.fields.add(ledger);
      const w1Identity: OrdinaryPhysicalIdentity = {
        version: 1, commandId: randomUUID(), replayId: randomUUID(), action: 'W1', sequence: 1, expectedSequence: 0,
        mutationVersion: 0, incarnation: s.tuple.incarnation, epoch: 1, ownerId: randomUUID(), sourceOwnerId: null,
        target: resource, source: null, transition: 'INITIAL', quantity: 2, parent: null,
      };
      const w1GrantId = randomUUID();
      ctx.keys.add(`reservation:fence:ordinary-command-grant:${w1GrantId}`);
      expect(JSON.parse(String(await ctx.redis.eval(
        ORDINARY_PHYSICAL_REGISTER,
        [RESERVATION_FENCE_KEY, 'reservation:fence:initialization-history', ledger, `reservation:fence:ordinary-command-grant:${w1GrantId}`],
        [JSON.stringify({ version: 1, grantId: w1GrantId, tuple: s.tuple, identity: JSON.stringify(w1Identity), purpose: 'EXECUTE', expiresAt: 0 })],
      )))).toEqual({ code: 'REJECTED' });

      // 3. Freshness permit without controlRevision -> MALFORMED_PERMIT
      const freshReq = randomUUID();
      ctx.keys.add(freshnessPermitKey(freshReq));
      ctx.keys.add(freshnessReceiptKey(freshReq));
      const freshPermit = {
        version: 1, effect: 'FRESHNESS_SWEEP', authorizationPhase: 'OPEN', tuple: s.tuple, requestId: freshReq,
        cutoverRunId: randomUUID(), barrierRevision: 1, target: resource, quantity: 2, anchorNowMs: Date.now(), expiresAt: 1,
      };
      expect(JSON.parse(String(await ctx.redis.eval(
        REGISTER_FRESHNESS_RESET_LUA, [RESERVATION_FENCE_KEY, freshnessPermitKey(freshReq)], [JSON.stringify(freshPermit)],
      )))).toEqual({ code: 'FENCE_REJECTED', reason: 'MALFORMED_PERMIT' });
      expect(JSON.parse(String(await ctx.redis.eval(
        EXECUTE_FRESHNESS_RESET_LUA, [RESERVATION_FENCE_KEY, freshnessPermitKey(freshReq), freshnessReceiptKey(freshReq)], [JSON.stringify(freshPermit)],
      )))).toEqual({ code: 'FENCE_REJECTED', reason: 'MALFORMED_PERMIT' });

      // 4. Direct E2 execution without registered permit -> MISSING_PERMIT (forged E2 denied)
      const forgedReq = randomUUID();
      ctx.trackRequestKeys(forgedReq);
      expect(JSON.parse(String(await ctx.redis.eval(
        EXECUTE_PRODUCT_SUSPECT_CLEARANCE_LUA,
        [
          RESERVATION_FENCE_KEY, clearancePermitKey(forgedReq), clearanceReceiptKey(forgedReq),
          productControlKey(s.productId), productSuspectKey(s.productId), `inv:reserved:product-total:{${s.productId}}`,
          `inv:reserved:product-index:{${s.productId}}`,
        ],
        [JSON.stringify({
          version: 1, effect: 'PRODUCT_SUSPECT_CLEARANCE', authorizationPhase: 'OPEN', tuple: s.tuple,
          requestId: forgedReq, productId: s.productId, restrictionId: s.restriction.id, targetRestrictionRevision: 1,
          stagedControlRevision: 1, clearedControlRevision: 2, reconciliationDigest: 'a'.repeat(64), approvalDigest: 'b'.repeat(64),
          priorStoredTotal: 2, targetReconciledTotal: 2, priorSuspectPresent: false, permitTtlMs: 5000,
          activeReservations: [], expectedCartIds: [], markerIds: [], expiresAt: Date.now() + 5000,
        })],
      )))).toEqual({ code: 'FENCE_REJECTED', reason: 'MISSING_PERMIT' });

      // Stale ORDINARY_PHYSICAL_EXECUTE with wrong controlRevision=0 on ALLOW(2) also denied
      const w1StaleGrant = randomUUID();
      ctx.keys.add(`reservation:fence:ordinary-command-grant:${w1StaleGrant}`);
      expect(JSON.parse(String(await ctx.redis.eval(
        ORDINARY_PHYSICAL_EXECUTE,
        [RESERVATION_FENCE_KEY, 'reservation:fence:initialization-history', ledger, `reservation:fence:ordinary-command-grant:${w1StaleGrant}`],
        [JSON.stringify({ version: 1, grantId: w1StaleGrant, tuple: s.tuple, identity: JSON.stringify(w1Identity), purpose: 'EXECUTE', expiresAt: 0, controlRevision: 0 })],
      )))).toEqual({ code: 'REJECTED' });
    }));
});
