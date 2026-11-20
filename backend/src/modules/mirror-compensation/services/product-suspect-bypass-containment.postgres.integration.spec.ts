import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { CartMutationBarrierConfigRepository } from '../../cart-mutation-barrier/repositories/cart-mutation-barrier-config.repository';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { CartReservationSyncBlockedRecheckService } from '../../cart-reservation-sync/services/cart-reservation-sync-blocked-recheck.service';
import {
  cartIndexKey,
  productIndexKey,
  productSuspectKey,
  productTotalKey,
  reservationKey,
} from '../../inventory/constants/inventory.constants';
import { seedHistoricalActiveReservation } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { OrdinaryReservationService } from '../../inventory/services/ordinary-reservation.service';
import { ReservationEngineModeConfigRepository } from '../../reservation-engine-mode/repositories/reservation-engine-mode-config.repository';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';
import {
  openOrdinarySchema,
  ordinaryFixture,
} from '../../reservation-fence/tests/ordinary-provenance-test-helpers';
import { productControlKey } from '../../reservation-fence/types/product-reservation-restriction.types';
import { CompensationRepository } from '../repositories/compensation.repository';
import { CompensationBlockedRecheckService } from './compensation-blocked-recheck.service';
import { CompensationService } from './compensation.service';

describe('Phase 4 PRODUCT_SUSPECT bypass containment (real Postgres + real Redis)', () => {
  jest.setTimeout(120000);

  async function withFixture(work: (ctx: {
    db: PrismaService;
    client: Redis;
    redis: RedisService;
    keys: Set<string>;
    cartRepository: CartRepository;
    syncStateRepository: CartReservationSyncStateRepository;
    syncBlockedRecheck: CartReservationSyncBlockedRecheckService;
    compensationRepository: CompensationRepository;
    compensationService: CompensationService;
    compensationBlockedRecheck: CompensationBlockedRecheckService;
    inventoryReservations: InventoryReservationsService;
  }) => Promise<void>) {
    if (process.env.REDIS_URL !== 'redis://127.0.0.1:16479/11') {
      throw new Error('Exact disposable Redis required at redis://127.0.0.1:16479/11');
    }
    const client = new Redis(process.env.REDIS_URL, { lazyConnect: true, retryStrategy: null, maxRetriesPerRequest: 0 });
    const keys = new Set<string>();
    let schema: Awaited<ReturnType<typeof openOrdinarySchema>> | undefined;
    let origFence: string | null | undefined;
    let origIncarnation: string | null | undefined;

    try {
      await client.connect();
      origFence = await client.get(RESERVATION_FENCE_KEY);
      origIncarnation = await client.hget(MUTATION_HISTORY_KEY, 'incarnation');
      schema = await openOrdinarySchema(68);
      const db = schema.db;
      const redis = new RedisService(client);
      const inventoryReservations = new InventoryReservationsService(redis);
      Object.assign(inventoryReservations, {
        ordinary: new OrdinaryReservationService(db, redis),
        observationPrisma: db,
      });
      const cartRepository = new CartRepository(db);
      const syncStateRepository = new CartReservationSyncStateRepository(db);
      const compensationRepository = new CompensationRepository(db);
      const compensationService = new CompensationService(compensationRepository);
      const modeService = new ReservationEngineModeService(
        db,
        new ReservationEngineModeConfigRepository(db),
        redis,
        inventoryReservations,
        new CartMutationBarrierConfigRepository(db),
      );
      const syncBlockedRecheck = new CartReservationSyncBlockedRecheckService(
        syncStateRepository,
        cartRepository,
        inventoryReservations,
        modeService,
      );
      const compensationBlockedRecheck = new CompensationBlockedRecheckService(
        compensationRepository,
        cartRepository,
        inventoryReservations,
        modeService,
      );
      await work({
        db,
        client,
        redis,
        keys,
        cartRepository,
        syncStateRepository,
        syncBlockedRecheck,
        compensationRepository,
        compensationService,
        compensationBlockedRecheck,
        inventoryReservations,
      });
    } finally {
      if (client.status === 'ready') {
        if (keys.size > 0) await client.del(...keys);
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
    }
  }

  it('preserves BLOCKED(PRODUCT_SUSPECT) across mirror divergences, desired-state upserts, and zero-qty rechecks without clearing restrictions', async () => {
    await withFixture(async (ctx) => {
      const { db, client, keys, cartRepository, syncStateRepository, syncBlockedRecheck, compensationRepository, compensationService, compensationBlockedRecheck, inventoryReservations } = ctx;
      const f = await ordinaryFixture(db);
      keys.add(productControlKey(f.productId));
      keys.add(reservationKey(f.cartId, f.productId));
      keys.add(cartIndexKey(f.cartId));
      keys.add(productIndexKey(f.productId));
      keys.add(productTotalKey(f.productId));
      keys.add(productSuspectKey(f.productId));

      const tuple = transitionTuple(f.transition);
      await client.set(RESERVATION_FENCE_KEY, JSON.stringify(tuple));
      await client.hset(MUTATION_HISTORY_KEY, 'incarnation', tuple.incarnation);

      // Install active PREPARED restriction on f.productId + suspect flag in Redis
      const rest = await db.productReservationRestriction.create({
        data: { productId: f.productId, reasonCategory: 'ACCOUNTING_DRIFT', observationDigest: 'a'.repeat(64) },
      });
      await client.set(productSuspectKey(f.productId), '1');

      // Seed BLOCKED(PRODUCT_SUSPECT) compensation & sync-state rows
      const comp = await compensationRepository.create({
        operation: 'RESERVE_MIRROR',
        cartId: f.cartId,
        productId: f.productId,
        customerId: f.customerId,
        desiredQuantity: 3,
        reasonCode: 'PRODUCT_SUSPENDED',
        lastError: 'PRODUCT_SUSPENDED',
      });
      await db.cartReservationCompensation.update({
        where: { id: comp.id },
        data: { status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT', nextAttemptAt: new Date(Date.now() + 60_000) },
      });
      await db.cartReservationSyncState.update({
        where: { id: f.marker.id },
        data: { status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT', nextAttemptAt: new Date(Date.now() + 60_000) },
      });

      // 1. Subsequent mirror divergences (CHECKOUT_IN_PROGRESS, UNKNOWN_INFRA_FAILURE, PRODUCT_SUSPENDED) preserve BLOCKED(PRODUCT_SUSPECT)
      for (const reasonCode of ['CHECKOUT_IN_PROGRESS', 'UNKNOWN_INFRA_FAILURE', 'PRODUCT_SUSPENDED'] as const) {
        const div = await compensationService.recordMirrorDivergence({
          operation: 'RESERVE_MIRROR',
          cartId: f.cartId,
          productId: f.productId,
          customerId: f.customerId,
          desiredQuantity: 4,
          reasonCode,
          lastError: `subsequent ${reasonCode}`,
          now: new Date(),
        });
        expect(div.ok).toBe(true);
        const persistedComp = await compensationRepository.findById(comp.id);
        expect(persistedComp).toMatchObject({ status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT' });
      }

      // 2. upsertDesiredState (both positive update and null removal) increments generation while preserving BLOCKED(PRODUCT_SUSPECT)
      const g1 = await syncStateRepository.upsertDesiredState(f.cartId, f.productId, 1, 7);
      expect(g1.generation).toBe(f.marker.generation + 1);
      expect(await syncStateRepository.findById(f.marker.id)).toMatchObject({
        status: 'BLOCKED',
        blockReason: 'PRODUCT_SUSPECT',
        expectedQuantity: 7,
      });

      const g2 = await syncStateRepository.upsertDesiredState(f.cartId, f.productId, 2, null);
      expect(g2.generation).toBe(f.marker.generation + 2);
      expect(await syncStateRepository.findById(f.marker.id)).toMatchObject({
        status: 'BLOCKED',
        blockReason: 'PRODUCT_SUSPECT',
        expectedQuantity: null,
      });

      // 3. Delete Redis suspect key + ensure zero CartItem: neither blocked recheck unblocks or clears ProductReservationRestriction
      await client.del(productSuspectKey(f.productId));
      expect(await cartRepository.findItemByCartAndProduct(f.cartId, f.productId)).toBeNull();
      const compRecheck = await compensationBlockedRecheck.recheckBlocked(comp.id, new Date());
      expect(compRecheck).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', compensationId: comp.id });
      const syncRecheck = await syncBlockedRecheck.recheckBlocked(f.marker.id, new Date());
      expect(syncRecheck).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', markerId: f.marker.id });

      expect(await compensationRepository.findById(comp.id)).toMatchObject({ status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT' });
      expect(await syncStateRepository.findById(f.marker.id)).toMatchObject({ status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT' });
      expect((await db.productReservationRestriction.findUniqueOrThrow({ where: { id: rest.id } })).state).toBe('PREPARED');

      // 4. Legitimate W2 release continues to succeed without clearing durable product restriction
      await seedHistoricalActiveReservation(client, f.cartId, f.productId, f.customerId, 2);
      const release = await inventoryReservations.releaseReservation(f.cartId, f.productId);
      expect(release).toEqual({ released: true, quantity: 2, underflow: null });
      expect(await client.get(productTotalKey(f.productId))).toBe('0');
      expect((await db.productReservationRestriction.findUniqueOrThrow({ where: { id: rest.id } })).state).toBe('PREPARED');

      // 5. Contrast: MODE_NOT_ADMITTING still resets cleanly to PENDING on upsertDesiredState and zero-qty recheck
      const modeSync = await db.cartReservationSyncState.create({
        data: {
          id: randomUUID(),
          cartId: f.cartId,
          productId: (await ordinaryFixture(db)).productId,
          expectedMutationVersion: 0,
          expectedQuantity: 2,
          status: 'BLOCKED',
          blockReason: 'MODE_NOT_ADMITTING',
          nextAttemptAt: new Date(Date.now() + 60_000),
        },
      });
      await syncStateRepository.upsertDesiredState(f.cartId, modeSync.productId, 1, 5);
      expect(await syncStateRepository.findById(modeSync.id)).toMatchObject({ status: 'PENDING', blockReason: null, expectedQuantity: 5 });
    });
  });
});
