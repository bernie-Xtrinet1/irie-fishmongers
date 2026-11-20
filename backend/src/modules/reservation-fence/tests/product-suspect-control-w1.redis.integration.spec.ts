import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import {
  EXECUTE_FRESHNESS_RESET_LUA,
  REGISTER_FRESHNESS_RESET_LUA,
  freshnessPermitKey,
  freshnessReceiptKey,
} from '../../cart-scoped-backfill/lua/freshness-sweep-lua';
import { CutoverFreshnessResetAuditRepository } from '../../cart-scoped-backfill/repositories/cutover-freshness-reset-audit.repository';
import { CutoverFreshnessResetService } from '../../cart-scoped-backfill/services/cutover-freshness-reset.service';
import {
  cartIndexKey,
  productIndexKey,
  productSuspectKey,
  productTotalKey,
  reservationKey,
} from '../../inventory/constants/inventory.constants';
import { REGISTER_ORDINARY_RESERVATION, WRITE_ORDINARY_RESERVATION } from '../../inventory/lua/ordinary-reservation-lua';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { OrdinaryReservationService } from '../../inventory/services/ordinary-reservation.service';
import { ORDINARY_INVALIDATION_LUA, invalidationHistoryKey } from '../lua/ordinary-invalidation.lua';
import { ORDINARY_PHYSICAL_EXECUTE } from '../lua/ordinary-command-physical.lua';
import { PRODUCT_CONTROL_INSTALL } from '../lua/product-reservation-restriction.lua';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY, resourceGuardKey } from '../lua/reservation-mutation-common.lua';
import { ordinaryHoldInstanceId } from '../ordinary-hold-instance-id';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { transitionTuple } from '../repositories/reservation-fence.repository';
import { OrdinaryCommandPhysicalService } from '../services/ordinary-command-physical.service';
import { OrdinaryInvalidationPublicationService } from '../services/ordinary-invalidation-publication.service';
import { InvalidationRequest, barrierAcknowledgement, canonicalInvalidationJson, invalidationRedisKey } from '../types/ordinary-invalidation.types';
import { ordinaryPhysicalLedgerKey } from '../types/ordinary-command-physical.types';
import { controlBytes, productControlKey } from '../types/product-reservation-restriction.types';
import { claimOrdinaryMutation, openOrdinarySchema, ordinaryFixture, withOrdinaryReleaseRedis } from './ordinary-provenance-test-helpers';
import { buildRecoveryRequestData, seedActiveAdminUser, sha256Hex } from './product-suspect-recovery-test-helpers';

describe('Phase 2 & 3 W1 product-control safety & CLEARANCE_STAGED denial (real PG + Redis)', () => {
  jest.setTimeout(120000);

  async function withIsolatedRedis(work: (ctx: {
    db: PrismaService;
    client: Redis;
    redis: RedisService;
    keys: Set<string>;
    fields: Set<string>;
  }) => Promise<void>) {
    if (process.env.REDIS_URL !== 'redis://127.0.0.1:16479/11') {
      throw new Error('Exact disposable Redis required at redis://127.0.0.1:16479/11');
    }
    const client = new Redis(process.env.REDIS_URL, { lazyConnect: true, retryStrategy: null, maxRetriesPerRequest: 0 });
    const keys = new Set<string>();
    const fields = new Set<string>();
    let schema: Awaited<ReturnType<typeof openOrdinarySchema>> | undefined;
    let origFence: string | null | undefined;
    let origIncarnation: string | null | undefined;

    try {
      await client.connect();
      origFence = await client.get(RESERVATION_FENCE_KEY);
      origIncarnation = await client.hget(MUTATION_HISTORY_KEY, 'incarnation');
      schema = await openOrdinarySchema(68);
      await work({ db: schema.db, client, redis: new RedisService(client), keys, fields });
    } finally {
      if (client.status === 'ready') {
        if (keys.size > 0) await client.del(...keys);
        if (fields.size > 0) await client.hdel(MUTATION_HISTORY_KEY, ...fields);
        if (origFence !== undefined) {
          if (origFence === null) await client.del(RESERVATION_FENCE_KEY);
          else await client.set(RESERVATION_FENCE_KEY, origFence);
        }
        if (origIncarnation !== undefined) {
          if (origIncarnation === null) await client.hdel(MUTATION_HISTORY_KEY, 'incarnation');
          else await client.hset(MUTATION_HISTORY_KEY, 'incarnation', origIncarnation);
        }
        await client.quit();
      } else {
        client.disconnect();
      }
      if (schema) await schema.close();
      jest.restoreAllMocks();
    }
  }

  function trackProductKeys(keys: Set<string>, fields: Set<string>, cartId: string, productId: string, markerId: string) {
    keys.add(productControlKey(productId));
    keys.add(reservationKey(cartId, productId));
    keys.add(cartIndexKey(cartId));
    keys.add(productIndexKey(productId));
    keys.add(productTotalKey(productId));
    keys.add(productSuspectKey(productId));
    keys.add(resourceGuardKey(markerId));
    keys.add(ordinaryPhysicalLedgerKey(markerId));
    fields.add(resourceGuardKey(markerId));
    fields.add(ordinaryPhysicalLedgerKey(markerId));
  }

  it('recognizes CLEARANCE_STAGED, denies W1 / Freshness / Physical / Install, and marks observation UNPROVEN', async () => {
    await withIsolatedRedis(async ({ db, client, redis, keys, fields }) => {
      const f = await ordinaryFixture(db);
      trackProductKeys(keys, fields, f.cartId, f.productId, f.marker.id);
      const tuple = transitionTuple(f.transition);
      await client.set(RESERVATION_FENCE_KEY, JSON.stringify(tuple));
      await client.hset(MUTATION_HISTORY_KEY, 'incarnation', tuple.incarnation);

      const stagedBytes = controlBytes({
        version: 1, productId: f.productId, state: 'CLEARANCE_STAGED',
        restrictionId: randomUUID(), restrictionRevision: 1, incarnation: tuple.incarnation, epoch: tuple.epoch,
      });
      await client.set(productControlKey(f.productId), stagedBytes);

      const allowAttempt = controlBytes({
        version: 1, productId: f.productId, state: 'ALLOW', restrictionId: null, restrictionRevision: 0,
        incarnation: tuple.incarnation, epoch: tuple.epoch,
      });
      expect(JSON.parse(String(await redis.eval(PRODUCT_CONTROL_INSTALL,
        [RESERVATION_FENCE_KEY, productControlKey(f.productId)], [JSON.stringify(tuple), allowAttempt]))))
        .toEqual({ code: 'FENCE_REJECTED', reason: 'CAPABILITY_REVOKED' });
      expect(JSON.parse(String(await redis.eval(PRODUCT_CONTROL_INSTALL,
        [RESERVATION_FENCE_KEY, productControlKey(f.productId)], [JSON.stringify(tuple), stagedBytes]))))
        .toEqual({ code: 'FENCE_REJECTED', reason: 'CAPABILITY_REVOKED' });

      const ordinary = new OrdinaryReservationService(db, redis);
      expect(await ordinary.reserve(f.cartId, f.productId, f.customerId, 2)).toEqual({
        code: 'FENCE_REJECTED', reason: 'CAPABILITY_REVOKED',
      });

      const inv = new InventoryReservationsService(redis);
      Object.assign(inv, { ordinary, observationPrisma: db });
      const obs = await inv.observeProductReservations(f.productId, [f.cartId]);
      expect(obs.restriction.physicalState).toBe('CLEARANCE_STAGED');
      expect(obs.restriction.crossStoreConsistency).toBe('UNPROVEN');
      expect(obs.findings).toContain('MEMBERSHIP_UNCERTAIN');

      const reqId = randomUUID();
      keys.add(freshnessPermitKey(reqId));
      const regFresh: unknown = JSON.parse(String(await redis.eval(
        REGISTER_FRESHNESS_RESET_LUA,
        [RESERVATION_FENCE_KEY, freshnessPermitKey(reqId)],
        [JSON.stringify({
          version: 1, effect: 'FRESHNESS_SWEEP', authorizationPhase: 'OPEN', tuple, requestId: reqId,
          cutoverRunId: randomUUID(), barrierRevision: 1,
          target: { customerId: f.customerId, cartId: f.cartId, productId: f.productId, markerId: f.marker.id, generation: 0, holdInstanceId: ordinaryHoldInstanceId(f.marker.id, 0) },
          quantity: 2, anchorNowMs: Date.now(), expiresAt: 1, controlRevision: 0,
        })],
      )));
      expect(regFresh).toEqual({ code: 'FENCE_REJECTED', reason: 'CAPABILITY_REVOKED' });
    });
  });

  it('rejects obsolete pre-loaded W1 physical command, W1 permit, and freshness permit after control revision changes (0 -> 2)', async () => {
    await withIsolatedRedis(async ({ db, client, redis, keys, fields }) => {
      const f = await ordinaryFixture(db);
      const adminA = await seedActiveAdminUser(db);
      const adminB = await seedActiveAdminUser(db);
      trackProductKeys(keys, fields, f.cartId, f.productId, f.marker.id);

      const repo = new OrdinaryInvalidationRepository(db);
      const publication = new OrdinaryInvalidationPublicationService(repo);
      const tuple = transitionTuple(f.transition);
      const modeRevision = f.transition.modeRevision ?? 1;
      await client.set(RESERVATION_FENCE_KEY, JSON.stringify(tuple));
      await client.hset(MUTATION_HISTORY_KEY, 'incarnation', tuple.incarnation);
      const globalKey = invalidationRedisKey('GLOBAL');
      const markerBarrierKey = invalidationRedisKey(`MARKER:${f.marker.id}`);
      [globalKey, invalidationHistoryKey(globalKey), markerBarrierKey, invalidationHistoryKey(markerBarrierKey)].forEach((k) => keys.add(k));

      await db.ordinaryInvalidationHead.createMany({
        data: ['GLOBAL', `MARKER:${f.marker.id}`].map((scope) => ({ scope, incarnation: tuple.incarnation, epoch: tuple.epoch })),
      });
      const initial: InvalidationRequest = {
        version: 1, intentId: randomUUID(), operationId: randomUUID(), kind: 'CART',
        incarnation: tuple.incarnation, epoch: tuple.epoch,
        scopes: [
          { kind: 'GLOBAL', revision: 0, before: tuple, after: tuple, modeBefore: { mode: 'CART_SCOPED', revision: modeRevision }, modeAfter: null },
          { kind: 'MARKER', revision: 0, markerId: f.marker.id, cartId: f.cartId, productId: f.productId, customerId: f.customerId,
            before: { generation: 0, mutationVersion: 0, quantity: 2 }, after: { generation: 0, mutationVersion: 0, quantity: 2 },
            cartBefore: null, cartAfter: null, ownersBefore: [], ownersAfter: [] },
        ],
      };
      await repo.prepare(initial);
      await repo.confirm(initial, barrierAcknowledgement(initial));
      await publication.publish(initial.intentId, () => Promise.resolve({ bootstrap: true }));
      await db.ordinaryInvalidationHead.updateMany({ data: { ready: true } });
      const ack = barrierAcknowledgement(initial);
      for (const cmd of ['INSTALL', 'READY'] as const) {
        await redis.eval(ORDINARY_INVALIDATION_LUA, [RESERVATION_FENCE_KEY, ...ack.scopes.map((s) => invalidationRedisKey(s.scope))],
          [canonicalInvalidationJson(ack), cmd]);
      }

      const issued = await f.commands.issue(f.issuance, f.payload);
      const pending = await f.commands.promote(f.marker.id);
      const admission = await claimOrdinaryMutation(db, pending!.id, 'GENESIS_THEN_EXECUTE');
      const physical = new OrdinaryCommandPhysicalService(db, redis);
      const initialized = await physical.initialize(admission.capability, admission.issuer);
      if (initialized.code !== 'INITIALIZED') throw new Error('Expected INITIALIZED');

      const origEval = redis.eval.bind(redis);
      let injectedAdvance = false;
      jest.spyOn(redis, 'eval').mockImplementation(async (script, ks, args) => {
        if (ks[3]?.startsWith('reservation:fence:ordinary-command-grant:')) keys.add(ks[3]);
        if (script === ORDINARY_PHYSICAL_EXECUTE && !injectedAdvance) {
          injectedAdvance = true;
          const rec = await db.productSuspectRecovery.create({
            data: buildRecoveryRequestData({
              productId: f.productId, restrictionId: null, targetRestrictionRevision: 0, clearedControlRevision: 2,
              modeRevision, fenceTransitionId: f.transition.id, incarnation: tuple.incarnation, fenceEpoch: tuple.epoch,
              fenceRevision: tuple.revision, requestedById: adminA.id, requestReason: 'CONTROL_ADVANCE_DURING_PRELOAD',
              priorStoredTotal: 0, targetReconciledTotal: 0, priorSuspectPresent: false,
            }),
          });
          const now = new Date();
          const later = new Date(now.getTime() + 600_000);
          await db.productSuspectRecovery.update({
            where: { id: rec.id },
            data: { status: 'APPROVED', approvedById: adminB.id, approvedAt: now, approvalExpiresAt: later, approvalDigest: 'c'.repeat(64) },
          });
          await db.productSuspectRecovery.update({
            where: { id: rec.id },
            data: { status: 'EXECUTING', executingAt: now, stagedControlRevision: 1 },
          });
          const receipt = JSON.stringify({ requestId: rec.requestId, productId: f.productId, status: 'APPLIED', targetTotal: 0 });
          await db.productSuspectRecovery.update({
            where: { id: rec.id },
            data: { status: 'COMPLETED', executionEvidence: 'APPLIED', evidenceEvaluatedAt: now, redisReceipt: receipt, redisReceiptHash: sha256Hex(receipt), completedAt: now },
          });
          await client.set(productControlKey(f.productId), controlBytes({
            version: 1, productId: f.productId, state: 'ALLOW', restrictionId: null, restrictionRevision: 2,
            incarnation: tuple.incarnation, epoch: tuple.epoch,
          }));
        }
        return origEval(script, ks, args);
      });

      expect(await physical.execute(initialized.continuation, admission.issuer)).toEqual({ code: 'REJECTED' });
      jest.restoreAllMocks();

      const staleW1Req = randomUUID();
      const stalePermKey = `reservation:fence:w1:${staleW1Req}`;
      keys.add(stalePermKey);
      const stalePermit = {
        version: 1, tuple,
        target: { customerId: f.customerId, cartId: f.cartId, productId: f.productId, markerId: f.marker.id, generation: 0, holdInstanceId: ordinaryHoldInstanceId(f.marker.id, 0) },
        from: null, quantity: 2, requestId: staleW1Req, expiresAt: 1, controlRevision: 0,
      };
      expect(JSON.parse(String(await origEval(REGISTER_ORDINARY_RESERVATION, [RESERVATION_FENCE_KEY, stalePermKey], [JSON.stringify(stalePermit)]))))
        .toEqual({ code: 'FENCE_REJECTED', reason: 'CAPABILITY_REVOKED' });
      expect(JSON.parse(String(await origEval(WRITE_ORDINARY_RESERVATION, [RESERVATION_FENCE_KEY, stalePermKey], [JSON.stringify(stalePermit)]))))
        .toEqual({ code: 'FENCE_REJECTED', reason: 'CAPABILITY_REVOKED' });

      const staleAllow0 = controlBytes({
        version: 1, productId: f.productId, state: 'ALLOW', restrictionId: null, restrictionRevision: 0,
        incarnation: tuple.incarnation, epoch: tuple.epoch,
      });
      expect(JSON.parse(String(await origEval(PRODUCT_CONTROL_INSTALL, [RESERVATION_FENCE_KEY, productControlKey(f.productId)],
        [JSON.stringify(tuple), staleAllow0])))).toEqual({ code: 'FENCE_REJECTED', reason: 'CAPABILITY_REVOKED' });

      const ordinary = new OrdinaryReservationService(db, redis);
      expect((await ordinary.reserve(f.cartId, f.productId, f.customerId, 2)).code).toBe('ACCEPTED');
      const liveControl = JSON.parse((await client.get(productControlKey(f.productId)))!) as { restrictionRevision: number };
      expect(liveControl.restrictionRevision).toBe(2);
      expect(issued.owner.id).toBeDefined();
    });

    // Separate schema for MIRROR-mode freshness sweep at cleared revision 2 (no enrolled GLOBAL barrier)
    await withIsolatedRedis(async ({ db, client, redis, keys, fields }) => {
      const fM = await ordinaryFixture(db);
      const adminA = await seedActiveAdminUser(db);
      const adminB = await seedActiveAdminUser(db);
      trackProductKeys(keys, fields, fM.cartId, fM.productId, fM.marker.id);

      const mirrorMode = await db.reservationEngineModeConfig.create({ data: { mode: 'MIRROR', updatedById: adminA.id } });
      const mirrorFence = await db.reservationFenceTransition.create({
        data: {
          incarnation: fM.transition.incarnation, epoch: fM.transition.epoch, revision: fM.transition.revision + 1,
          phase: 'OPEN', protocol: 1, mode: 'MIRROR', modeRevision: mirrorMode.revision,
          status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), reason: 'OPEN', actorId: adminA.id,
        },
      });
      const mirrorTuple = transitionTuple(mirrorFence);
      await client.set(RESERVATION_FENCE_KEY, JSON.stringify(mirrorTuple));
      await client.hset(MUTATION_HISTORY_KEY, 'incarnation', mirrorTuple.incarnation);

      const rec = await db.productSuspectRecovery.create({
        data: buildRecoveryRequestData({
          productId: fM.productId, restrictionId: null, targetRestrictionRevision: 0, clearedControlRevision: 2,
          modeRevision: mirrorMode.revision, fenceTransitionId: mirrorFence.id, incarnation: mirrorTuple.incarnation,
          fenceEpoch: mirrorTuple.epoch, fenceRevision: mirrorTuple.revision, requestedById: adminA.id,
          requestReason: 'FRESHNESS_REV2_CHECK', priorStoredTotal: 0, targetReconciledTotal: 0, priorSuspectPresent: false,
        }),
      });
      const now = new Date();
      const later = new Date(now.getTime() + 600_000);
      await db.productSuspectRecovery.update({
        where: { id: rec.id },
        data: { status: 'APPROVED', approvedById: adminB.id, approvedAt: now, approvalExpiresAt: later, approvalDigest: 'c'.repeat(64) },
      });
      await db.productSuspectRecovery.update({ where: { id: rec.id }, data: { status: 'EXECUTING', executingAt: now, stagedControlRevision: 1 } });
      const receipt = JSON.stringify({ requestId: rec.requestId, productId: fM.productId, status: 'APPLIED', targetTotal: 0 });
      await db.productSuspectRecovery.update({
        where: { id: rec.id },
        data: { status: 'COMPLETED', executionEvidence: 'APPLIED', evidenceEvaluatedAt: now, redisReceipt: receipt, redisReceiptHash: sha256Hex(receipt), completedAt: now },
      });
      await client.set(productControlKey(fM.productId), controlBytes({
        version: 1, productId: fM.productId, state: 'ALLOW', restrictionId: null, restrictionRevision: 2,
        incarnation: mirrorTuple.incarnation, epoch: mirrorTuple.epoch,
      }));

      await db.cartItem.upsert({
        where: { cartId_productId: { cartId: fM.cartId, productId: fM.productId } },
        create: { cartId: fM.cartId, productId: fM.productId, quantity: 2, mutationVersion: 0 },
        update: { quantity: 2 },
      });
      await db.cartReservationSyncState.update({ where: { id: fM.marker.id }, data: { expectedQuantity: 2, resolvedAt: new Date() } });
      await db.cartMutationBarrierConfig.create({ data: { revision: 1, active: true, activatedById: adminA.id } });

      expect((await new OrdinaryReservationService(db, redis).reserve(fM.cartId, fM.productId, fM.customerId, 2)).code).toBe('ACCEPTED');
      const freshSvc = new CutoverFreshnessResetService(db, redis, new CutoverFreshnessResetAuditRepository(db));
      const fReqId = randomUUID();
      keys.add(freshnessPermitKey(fReqId));
      keys.add(freshnessReceiptKey(fReqId));
      const freshOk = await freshSvc.executeAuthorizedFreshnessReset({
        requestId: fReqId, cutoverRunId: randomUUID(), barrierRevision: 1,
        customerId: fM.customerId, cartId: fM.cartId, productId: fM.productId, quantity: 2, operatorId: adminA.id,
      });
      expect(freshOk.ok).toBe(true);

      const staleFreshReq = randomUUID();
      keys.add(freshnessPermitKey(staleFreshReq));
      expect(JSON.parse(String(await redis.eval(EXECUTE_FRESHNESS_RESET_LUA,
        [RESERVATION_FENCE_KEY, freshnessPermitKey(staleFreshReq), freshnessReceiptKey(staleFreshReq)],
        [JSON.stringify({
          version: 1, effect: 'FRESHNESS_SWEEP', authorizationPhase: 'OPEN', tuple: mirrorTuple,
          requestId: staleFreshReq, cutoverRunId: randomUUID(), barrierRevision: 1,
          target: { customerId: fM.customerId, cartId: fM.cartId, productId: fM.productId, markerId: fM.marker.id, generation: 0, holdInstanceId: ordinaryHoldInstanceId(fM.marker.id, 0) },
          quantity: 2, anchorNowMs: Date.now(), expiresAt: Date.now() + 4000, controlRevision: 0,
        })])))).toEqual({ code: 'FENCE_REJECTED', reason: 'CAPABILITY_REVOKED' });
    });
  });

  it('preserves real Redis W2 exact RELEASE under active ENFORCED restriction', async () => {
    await withOrdinaryReleaseRedis(async (f) => {
      const rest = await f.db.productReservationRestriction.create({
        data: { productId: f.productId, reasonCategory: 'ACCOUNTING_DRIFT', observationDigest: 'd'.repeat(64) },
      });
      const ack = controlBytes({
        version: 1, productId: f.productId, state: 'RESTRICTED', restrictionId: rest.id, restrictionRevision: 1,
        incarnation: f.tuple.incarnation, epoch: f.tuple.epoch,
      });
      await f.client.set(productControlKey(f.productId), ack);
      await f.db.productReservationRestrictionInstallation.create({
        data: {
          restrictionId: rest.id, incarnation: f.tuple.incarnation, epoch: f.tuple.epoch, protocolVersion: 1,
          acknowledgement: ack, acknowledgementHash: sha256Hex(ack),
        },
      });
      await f.db.productReservationRestriction.update({
        where: { id: rest.id },
        data: { state: 'ENFORCED', firstEnforcedAt: new Date() },
      });

      expect((await f.physical.executeRelease(f.claim, f.claims)).code).toBe('COMPLETED');
      await f.client.del(productControlKey(f.productId));
      expect((await f.db.productReservationRestriction.findUniqueOrThrow({ where: { id: rest.id } })).state).toBe('ENFORCED');
    });
  });
});
