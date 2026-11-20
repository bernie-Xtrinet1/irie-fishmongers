import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import {
  cartIndexKey,
  productIndexKey,
  productSuspectKey,
  productTotalKey,
  reservationKey,
} from '../../inventory/constants/inventory.constants';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { OrdinaryReservationService } from '../../inventory/services/ordinary-reservation.service';
import { CompensationRepository } from '../../mirror-compensation/repositories/compensation.repository';
import { checkoutPinKey } from '../lua/checkout-settlement.lua';
import { PRODUCT_CONTROL_INSTALL } from '../lua/product-reservation-restriction.lua';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY, resourceGuardKey } from '../lua/reservation-mutation-common.lua';
import { ReservationFenceRepository, transitionTuple } from '../repositories/reservation-fence.repository';
import { ProductReservationRestrictionAdmissionService } from '../services/product-reservation-restriction-admission.service';
import { ProductReservationRestrictionService } from '../services/product-reservation-restriction.service';
import { ProductSuspectClearanceService } from '../services/product-suspect-clearance.service';
import { ProductSuspectCrashEvidenceService } from '../services/product-suspect-crash-evidence.service';
import { controlBytes, productControlKey, restrictionDigest } from '../types/product-reservation-restriction.types';
import { clearancePermitKey, clearanceReceiptKey } from '../types/product-suspect-clearance.types';
import { openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';
import { seedActiveAdminUser } from './product-suspect-recovery-test-helpers';

export interface ClearanceHarnessCtx {
  db: PrismaService;
  fresh: () => PrismaService;
  client: Redis;
  redis: RedisService;
  keys: Set<string>;
  fields: Set<string>;
  fences: ReservationFenceRepository;
  restrictionService: ProductReservationRestrictionService;
  crashEvidence: ProductSuspectCrashEvidenceService;
  clearance: ProductSuspectClearanceService;
  ordinary: OrdinaryReservationService;
  inventoryReservations: InventoryReservationsService;
  trackRequestKeys: (requestId: string) => void;
}

export async function withClearanceHarness(work: (ctx: ClearanceHarnessCtx) => Promise<void>): Promise<void> {
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
    const db = schema.db;
    const redis = new RedisService(client);
    const fences = new ReservationFenceRepository(db);
    const restrictionService = new ProductReservationRestrictionService(
      db, redis, new ProductReservationRestrictionAdmissionService(db, redis),
    );
    const crashEvidence = new ProductSuspectCrashEvidenceService();
    const clearance = new ProductSuspectClearanceService(fences, redis, crashEvidence);
    const ordinary = new OrdinaryReservationService(db, redis);
    const inventoryReservations = new InventoryReservationsService(redis);
    Object.assign(inventoryReservations, { ordinary, observationPrisma: db });

    await work({
      db,
      fresh: schema.fresh,
      client,
      redis,
      keys,
      fields,
      fences,
      restrictionService,
      crashEvidence,
      clearance,
      ordinary,
      inventoryReservations,
      trackRequestKeys: (requestId: string) => {
        keys.add(clearancePermitKey(requestId));
        keys.add(clearanceReceiptKey(requestId));
      },
    });
  } finally {
    jest.restoreAllMocks();
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
  }
}

export async function seedClearanceIncident(
  ctx: ClearanceHarnessCtx,
  opts: {
    activeQty?: number;
    corruptStoredTotal?: string | null;
    suspectPresent?: boolean;
    installInPg?: boolean;
    blockSync?: boolean;
    blockComp?: boolean;
  } = {},
) {
  const { db, client, keys, fields, ordinary, restrictionService } = ctx;
  const f = await ordinaryFixture(db);
  const tuple = transitionTuple(f.transition);
  await client.set(RESERVATION_FENCE_KEY, JSON.stringify(tuple));
  await client.hset(MUTATION_HISTORY_KEY, 'incarnation', tuple.incarnation);

  const trackKeys = [
    productControlKey(f.productId), productSuspectKey(f.productId), productTotalKey(f.productId),
    productIndexKey(f.productId), cartIndexKey(f.cartId), reservationKey(f.cartId, f.productId),
    resourceGuardKey(f.marker.id), checkoutPinKey(f.marker.id),
  ];
  trackKeys.forEach((k) => keys.add(k));
  fields.add(resourceGuardKey(f.marker.id));

  const activeQty = opts.activeQty ?? 2;
  await db.cartItem.upsert({
    where: { cartId_productId: { cartId: f.cartId, productId: f.productId } },
    create: { cartId: f.cartId, productId: f.productId, quantity: Math.max(activeQty, 2), mutationVersion: 1 },
    update: { quantity: Math.max(activeQty, 2) },
  });

  if (activeQty > 0) {
    await db.cartReservationSyncState.update({
      where: { id: f.marker.id },
      data: { expectedQuantity: activeQty },
    });
    const res = await ordinary.reserve(f.cartId, f.productId, f.customerId, activeQty);
    if (res.code !== 'ACCEPTED') throw new Error(`Expected initial hold, got ${JSON.stringify(res)}`);
  }

  if (opts.corruptStoredTotal === null) {
    await client.del(productTotalKey(f.productId));
  } else if (opts.corruptStoredTotal !== undefined) {
    await client.set(productTotalKey(f.productId), opts.corruptStoredTotal);
  }
  if (opts.suspectPresent ?? true) {
    await client.set(productSuspectKey(f.productId), '1');
  }

  const restriction = await db.productReservationRestriction.create({
    data: { productId: f.productId, reasonCategory: 'ACCOUNTING_DRIFT', observationDigest: restrictionDigest(f.productId) },
  });
  if (opts.installInPg ?? true) {
    if ((await restrictionService.install(restriction.id)) !== 'ENFORCED') {
      throw new Error('Failed to install ENFORCED restriction');
    }
  } else {
    const restrictedBytes = controlBytes({
      version: 1, productId: f.productId, state: 'RESTRICTED', restrictionId: restriction.id,
      restrictionRevision: restriction.restrictionRevision, incarnation: tuple.incarnation, epoch: tuple.epoch,
    });
    await client.eval(PRODUCT_CONTROL_INSTALL, 2, RESERVATION_FENCE_KEY, productControlKey(f.productId), JSON.stringify(tuple), restrictedBytes);
  }

  if (opts.blockSync ?? true) {
    await db.cartReservationSyncState.update({
      where: { id: f.marker.id },
      data: { status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT', nextAttemptAt: new Date(Date.now() + 60_000) },
    });
  }

  let compId: string | null = null;
  if (opts.blockComp ?? true) {
    const comp = await new CompensationRepository(db).create({
      operation: 'RESERVE_MIRROR', cartId: f.cartId, productId: f.productId, customerId: f.customerId,
      desiredQuantity: Math.max(activeQty, 2), reasonCode: 'PRODUCT_SUSPENDED', lastError: 'PRODUCT_SUSPENDED',
    });
    await db.cartReservationCompensation.update({
      where: { id: comp.id },
      data: { status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT', nextAttemptAt: new Date(Date.now() + 60_000) },
    });
    compId = comp.id;
  }

  const adminA = await seedActiveAdminUser(db, 'ACTIVE');
  const adminB = await seedActiveAdminUser(db, 'ACTIVE');
  return { ...f, tuple, restriction, compId, adminA, adminB };
}
