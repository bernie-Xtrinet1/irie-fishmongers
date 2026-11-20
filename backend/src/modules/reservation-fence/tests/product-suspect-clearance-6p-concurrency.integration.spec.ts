import { randomUUID } from 'crypto';

import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { CompensationRepository } from '../../mirror-compensation/repositories/compensation.repository';
import { CompensationService } from '../../mirror-compensation/services/compensation.service';
import { seedCartAndProduct, setUpCompensationFixture } from '../../mirror-compensation/repositories/compensation-repository-test-helpers';
import { EXECUTE_PRODUCT_SUSPECT_CLEARANCE_LUA } from '../lua/product-suspect-clearance.lua';
import { clearanceReceiptKey } from '../types/product-suspect-clearance.types';
import { seedClearanceIncident, withClearanceHarness } from './product-suspect-clearance-test-helpers';

describe('D.4B.6P Phase 1: Target unblocking, incident safety & concurrent cart updates', () => {
  jest.setTimeout(120_000);

  it('unblocks unchanged AND generation-advanced same-incident targets across pre-approve and post-E2 cart updates without clobbering state', () =>
    withClearanceHarness(async (ctx) => {
      const s = await seedClearanceIncident(ctx, { activeQty: 2, corruptStoredTotal: '8' });
      const syncRepo = new CartReservationSyncStateRepository(ctx.db);
      const compRepo = new CompensationRepository(ctx.db);
      const compSvc = new CompensationService(compRepo);

      // Seed a second cart C2 (unchanged generation) blocked on the same PRODUCT_SUSPECT incident
      const extraSeed = await setUpCompensationFixture(ctx.db);
      const c2CustomerRole = await ctx.db.role.upsert({ where: { name: 'CUSTOMER' }, update: {}, create: { name: 'CUSTOMER' } });
      const c2User = await ctx.db.user.create({
        data: { email: `c2-${randomUUID()}@ex.com`, passwordHash: 'x', firstName: 'C', lastName: 'Two', status: 'ACTIVE', roles: { create: { roleId: c2CustomerRole.id } } },
      });
      const c2Cart = await ctx.db.cart.create({ data: { customerId: c2User.id } });
      await ctx.db.cartItem.create({ data: { cartId: c2Cart.id, productId: s.productId, quantity: 1, mutationVersion: 1 } });
      const c2Marker = await ctx.db.cartReservationSyncState.create({
        data: { cartId: c2Cart.id, productId: s.productId, expectedQuantity: 1, expectedMutationVersion: 1, status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT', nextAttemptAt: new Date(Date.now() + 60_000) },
      });
      const c2Comp = await compRepo.create({
        operation: 'RESERVE_MIRROR', cartId: c2Cart.id, productId: s.productId, customerId: c2User.id,
        desiredQuantity: 1, reasonCode: 'PRODUCT_SUSPENDED', lastError: 'PRODUCT_SUSPENDED',
      });
      await ctx.db.cartReservationCompensation.update({
        where: { id: c2Comp.id }, data: { status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT', nextAttemptAt: new Date(Date.now() + 60_000) },
      });
      void extraSeed;

      const req = await ctx.clearance.requestClearance({
        productId: s.productId, requestedById: s.adminA.id, requestReason: 'CONCURRENT_CART_UNBLOCK',
      });
      expect(req).toMatchObject({ ok: true, affectedMarkerCount: 2, affectedCompensationCount: 2 });
      if (!req.ok) throw new Error(req.message);
      ctx.trackRequestKeys(req.requestId);

      // Test Case 2a: Cart C1 updates 2 -> 4 BEFORE approval (generation increments 0 -> 1, stays BLOCKED(PRODUCT_SUSPECT))
      await ctx.db.cartItem.update({
        where: { cartId_productId: { cartId: s.cartId, productId: s.productId } },
        data: { quantity: 4, mutationVersion: 2 },
      });
      await syncRepo.upsertDesiredState(s.cartId, s.productId, 2, 4);
      await compSvc.recordMirrorDivergence({
        operation: 'RESERVE_MIRROR', cartId: s.cartId, productId: s.productId, customerId: s.customerId,
        desiredQuantity: 4, reasonCode: 'CHECKOUT_IN_PROGRESS', lastError: 'retry under restriction', now: new Date(),
      });

      const app = await ctx.clearance.approveClearance({ recoveryId: req.recoveryId, approvedById: s.adminB.id });
      expect(app).toMatchObject({ ok: true, status: 'APPROVED' });

      // Test Case 5: Cart C1 updates 4 -> 6 IMMEDIATELY AFTER E2 in Redis and BEFORE PG TX2 commits
      const origEval = ctx.redis.eval.bind(ctx.redis);
      jest.spyOn(ctx.redis, 'eval').mockImplementation(async (script, keys, args) => {
        const res = await origEval(script, keys, args);
        if (script === EXECUTE_PRODUCT_SUSPECT_CLEARANCE_LUA) {
          await ctx.db.cartItem.update({
            where: { cartId_productId: { cartId: s.cartId, productId: s.productId } },
            data: { quantity: 6, mutationVersion: 3 },
          });
          await syncRepo.upsertDesiredState(s.cartId, s.productId, 3, 6);
          await compSvc.recordMirrorDivergence({
            operation: 'RESERVE_MIRROR', cartId: s.cartId, productId: s.productId, customerId: s.customerId,
            desiredQuantity: 6, reasonCode: 'UNKNOWN_INFRA_FAILURE', lastError: 'late update pre-tx2', now: new Date(),
          });
        }
        return res;
      });

      const exec = await ctx.clearance.executeClearance({ recoveryId: req.recoveryId });
      expect(exec).toMatchObject({
        ok: true, status: 'COMPLETED', clearedControlRevision: 2,
        unblockedSyncCount: 2, unblockedCompCount: 2, skippedTargetCount: 0,
      });

      // Verify C1 (generation advanced 0->2, expectedQuantity=6, desiredQuantity=6) AND C2 (unchanged gen=0) are both PENDING without clobbering
      expect(await ctx.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: s.marker.id } })).toMatchObject({
        status: 'PENDING', blockReason: null, expectedQuantity: 6, generation: 2, expectedMutationVersion: 3,
      });
      expect(await ctx.db.cartReservationCompensation.findUniqueOrThrow({ where: { id: s.compId! } })).toMatchObject({
        status: 'PENDING', blockReason: null, desiredQuantity: 6, generation: 2,
      });
      expect(await ctx.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: c2Marker.id } })).toMatchObject({
        status: 'PENDING', blockReason: null, expectedQuantity: 1, generation: 0,
      });
      expect(await ctx.db.cartReservationCompensation.findUniqueOrThrow({ where: { id: c2Comp.id } })).toMatchObject({
        status: 'PENDING', blockReason: null, desiredQuantity: 1, generation: 0,
      });
    }));

  it('excludes changed blockReason, re-claimed attemptCount, and new incident targets without overwriting concurrent state', () =>
    withClearanceHarness(async (ctx) => {
      const s = await seedClearanceIncident(ctx, { activeQty: 2 });
      const compRepo = new CompensationRepository(ctx.db);

      // Second cart C2 attributed as well
      const base = await setUpCompensationFixture(ctx.db);
      const ids2 = await seedCartAndProduct(base);
      const sync2 = await ctx.db.cartReservationSyncState.create({
        data: { cartId: ids2.cartId, productId: s.productId, expectedQuantity: 1, expectedMutationVersion: 1, status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT', nextAttemptAt: new Date(Date.now() + 60_000) },
      });

      const req = await ctx.clearance.requestClearance({
        productId: s.productId, requestedById: s.adminA.id, requestReason: 'EXCLUSION_TESTS',
      });
      if (!req.ok) throw new Error(req.message);
      ctx.trackRequestKeys(req.requestId);
      await ctx.clearance.approveClearance({ recoveryId: req.recoveryId, approvedById: s.adminB.id });

      // Simulate concurrent transitions immediately post-E2 before TX2:
      // 1) s.marker had attemptCount incremented (exited & re-entered cycle -> must NOT be unblocked blindly)
      // 2) s.comp had blockReason changed to MODE_NOT_ADMITTING
      // 3) sync2 stayed same incident (should unblock)
      const origEval = ctx.redis.eval.bind(ctx.redis);
      jest.spyOn(ctx.redis, 'eval').mockImplementation(async (script, keys, args) => {
        const res = await origEval(script, keys, args);
        if (script === EXECUTE_PRODUCT_SUSPECT_CLEARANCE_LUA) {
          await ctx.db.cartReservationSyncState.update({
            where: { id: s.marker.id },
            data: { attemptCount: s.marker.attemptCount + 1, generation: s.marker.generation + 1 },
          });
          await ctx.db.cartReservationCompensation.update({
            where: { id: s.compId! },
            data: { blockReason: 'MODE_NOT_ADMITTING', generation: 1 },
          });
        }
        return res;
      });

      const exec = await ctx.clearance.executeClearance({ recoveryId: req.recoveryId });
      expect(exec).toMatchObject({
        ok: true, status: 'COMPLETED', unblockedSyncCount: 1, unblockedCompCount: 0, skippedTargetCount: 2,
      });
      expect(await ctx.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: s.marker.id } })).toMatchObject({
        status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT', attemptCount: 1,
      });
      expect(await ctx.db.cartReservationCompensation.findUniqueOrThrow({ where: { id: s.compId! } })).toMatchObject({
        status: 'BLOCKED', blockReason: 'MODE_NOT_ADMITTING',
      });
      expect(await ctx.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: sync2.id } })).toMatchObject({
        status: 'PENDING', blockReason: null,
      });

      // Test Case 4: New incident rev=3 + new compensation row cannot be unblocked by replaying completed recovery 1
      const compNew = await compRepo.create({
        operation: 'RESERVE_MIRROR', cartId: ids2.cartId, productId: s.productId, customerId: ids2.customerId,
        desiredQuantity: 2, reasonCode: 'PRODUCT_SUSPENDED', lastError: 'new incident',
      });
      await ctx.db.cartReservationCompensation.update({
        where: { id: compNew.id }, data: { status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT' },
      });
      expect(await ctx.clearance.recoverClearance(req.recoveryId)).toMatchObject({
        ok: true, status: 'COMPLETED', replayed: true,
      });
      expect(await ctx.db.cartReservationCompensation.findUniqueOrThrow({ where: { id: compNew.id } })).toMatchObject({
        status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT',
      });
      expect(await ctx.client.pttl(clearanceReceiptKey(req.requestId))).toBe(-1);
    }));
});
