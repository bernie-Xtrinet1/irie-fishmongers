import { randomUUID } from 'crypto';
import { RoleName } from '@prisma/client';
import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartMutationBarrierConfigRepository } from '../../cart-mutation-barrier/repositories/cart-mutation-barrier-config.repository';
import { CartMutationBarrierService } from '../../cart-mutation-barrier/services/cart-mutation-barrier.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import {
  cartIndexKey,
  productIndexKey,
  productSuspectKey,
  productTotalKey,
  reservationKey,
} from '../../inventory/constants/inventory.constants';
import { connectRealRedis } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { OrdinaryReservationService } from '../../inventory/services/ordinary-reservation.service';
import { setUpCompensationFixture } from '../../mirror-compensation/repositories/compensation-repository-test-helpers';
import { ReservationEngineModeConfigRepository } from '../../reservation-engine-mode/repositories/reservation-engine-mode-config.repository';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { ReservationModeFenceCoordinatorService } from '../../reservation-engine-mode/services/reservation-mode-fence-coordinator.service';
import { ordinaryHoldInstanceId } from '../../reservation-fence/ordinary-hold-instance-id';
import { openOrdinarySchema, seedCartAndProductForSchema } from '../../reservation-fence/tests/ordinary-provenance-test-helpers';
import { ReservationRecoveryConvergenceService } from '../../reservation-recovery/services/reservation-recovery-convergence.service';
import { CutoverFreshnessResetAuditRepository } from '../repositories/cutover-freshness-reset-audit.repository';
import { CartScopedBackfillService } from './cart-scoped-backfill.service';
import { CutoverFreshnessResetService } from './cutover-freshness-reset.service';

export const FRESHNESS_ISOLATED_DB_INDEX = 9;

export async function openFreshnessHarness() {
  const schema = await openOrdinarySchema();
  const prisma = schema.db;
  const redisClient: Redis = await connectRealRedis();
  await redisClient.select(FRESHNESS_ISOLATED_DB_INDEX);
  await redisClient.flushdb();
  const redisService = new RedisService(redisClient);

  const compFixture = await setUpCompensationFixture(prisma);
  const operatorId = compFixture.userIds[0]!;
  const seeded = await seedCartAndProductForSchema(compFixture);
  const generation = 1;
  const quantity = 4;

  await prisma.cartItem.create({
    data: { cartId: seeded.cartId, productId: seeded.productId, quantity, mutationVersion: 1 },
  });
  const marker = await prisma.cartReservationSyncState.create({
    data: {
      cartId: seeded.cartId,
      productId: seeded.productId,
      expectedQuantity: quantity,
      expectedMutationVersion: 1,
      generation,
      resolvedAt: new Date(),
    },
  });

  const cartRepository = new CartRepository(prisma);
  const syncStateRepository = new CartReservationSyncStateRepository(prisma);
  const barrierRepository = new CartMutationBarrierConfigRepository(prisma);
  const mutationBarrier = new CartMutationBarrierService(prisma, barrierRepository);
  const modeRepository = new ReservationEngineModeConfigRepository(prisma);
  const ordinary = new OrdinaryReservationService(prisma, redisService);
  const inventoryReservations = new InventoryReservationsService(redisService);
  Object.assign(inventoryReservations, { ordinary, observationPrisma: prisma });

  const fenceCoordinator = new ReservationModeFenceCoordinatorService(prisma, redisService);
  const modeService = new ReservationEngineModeService(
    prisma,
    modeRepository,
    redisService,
    inventoryReservations,
    barrierRepository,
    fenceCoordinator,
  );
  const mirrorRes = await modeService.setMode({ targetMode: 'MIRROR', updatedById: operatorId });
  if (!mirrorRes.ok) throw new Error(`Failed to enter coordinated MIRROR mode: ${JSON.stringify(mirrorRes)}`);

  const barrier = await mutationBarrier.activate(operatorId);
  if (!barrier.active || barrier.revision === null) throw new Error('Barrier failed to activate');

  const reserveOutcome = await ordinary.reserve(seeded.cartId, seeded.productId, seeded.customerId, quantity);
  if (reserveOutcome.code !== 'ACCEPTED') {
    throw new Error(`Ordinary reserve setup failed: ${JSON.stringify(reserveOutcome)}`);
  }

  const auditRepo = new CutoverFreshnessResetAuditRepository(prisma);
  const freshnessReset = new CutoverFreshnessResetService(prisma, redisService, auditRepo);
  const recoveryConvergence = new ReservationRecoveryConvergenceService(modeService, inventoryReservations);
  const backfillService = new CartScopedBackfillService(
    cartRepository,
    syncStateRepository,
    recoveryConvergence,
    inventoryReservations,
    freshnessReset,
  );

  return {
    schema,
    prisma,
    redisClient,
    redisService,
    ordinary,
    inventoryReservations,
    modeService,
    mutationBarrier,
    auditRepo,
    freshnessReset,
    backfillService,
    operatorId,
    customerId: seeded.customerId,
    cartId: seeded.cartId,
    productId: seeded.productId,
    markerId: marker.id,
    generation,
    holdInstanceId: ordinaryHoldInstanceId(marker.id, generation),
    quantity,
    barrierRevision: barrier.revision,
    seedSecondCartHold: async (secondQty = 3) => {
      const custRole = await prisma.role.upsert({
        where: { name: RoleName.CUSTOMER },
        update: {},
        create: { name: RoleName.CUSTOMER },
      });
      const secondCustomer = await new UsersRepository(prisma).create({
        email: `fresh-cust2-${randomUUID()}@example.com`,
        passwordHash: 'hashed',
        firstName: 'Second',
        lastName: 'Buyer',
        roleId: custRole.id,
        emailVerificationTokenHash: 'h',
        emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
      });
      const secondCart = await cartRepository.findOrCreateByCustomerId(secondCustomer.id);
      await prisma.cartItem.create({
        data: { cartId: secondCart.id, productId: seeded.productId, quantity: secondQty, mutationVersion: 1 },
      });
      await prisma.cartReservationSyncState.create({
        data: {
          cartId: secondCart.id,
          productId: seeded.productId,
          expectedQuantity: secondQty,
          expectedMutationVersion: 1,
          generation: 1,
          resolvedAt: new Date(),
        },
      });
      const r = await ordinary.reserve(secondCart.id, seeded.productId, secondCustomer.id, secondQty);
      if (r.code !== 'ACCEPTED') throw new Error(`Second reserve failed: ${JSON.stringify(r)}`);
      return { cartId: secondCart.id, customerId: secondCustomer.id, quantity: secondQty };
    },
    snapshotRedis: async () => {
      const [entry, total, suspect, cIdx, pIdx] = await Promise.all([
        redisClient.get(reservationKey(seeded.cartId, seeded.productId)),
        redisClient.get(productTotalKey(seeded.productId)),
        redisClient.get(productSuspectKey(seeded.productId)),
        redisClient.smembers(cartIndexKey(seeded.cartId)),
        redisClient.smembers(productIndexKey(seeded.productId)),
      ]);
      return { entry, total, suspect, cIdx: cIdx.sort(), pIdx: pIdx.sort() };
    },
    close: async () => {
      try {
        await redisClient.flushdb();
      } finally {
        try {
          await redisClient.quit();
        } finally {
          await schema.close();
        }
      }
    },
  };
}
