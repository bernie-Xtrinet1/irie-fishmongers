import { randomUUID } from 'crypto';
import { RoleName } from '@prisma/client';

import { RedisService } from '../../../common/redis/redis.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartMutationBarrierConfigRepository } from '../../cart-mutation-barrier/repositories/cart-mutation-barrier-config.repository';
import { CartMutationBarrierService } from '../../cart-mutation-barrier/services/cart-mutation-barrier.service';
import { CartItemAddAttemptRepository } from '../../cart/repositories/cart-item-add-attempt.repository';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { CartItemAddIdempotencyService } from '../../cart/services/cart-item-add-idempotency.service';
import { CartReservationConvergenceService } from '../../cart/services/cart-reservation-convergence.service';
import { CartService } from '../../cart/services/cart.service';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { CheckoutReservationFacade } from '../../checkout-reservation/services/checkout-reservation-facade.service';
import {
  RESERVATION_TTL_SECONDS,
  productTotalKey,
  reservationKey,
} from '../../inventory/constants/inventory.constants';
import { connectRealRedis, seedHistoricalActiveReservation } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { OrdinaryReservationService } from '../../inventory/services/ordinary-reservation.service';
import { CompensationRepository } from '../../mirror-compensation/repositories/compensation.repository';
import { CompensationService } from '../../mirror-compensation/services/compensation.service';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { ReservationEngineModeConfigRepository } from '../../reservation-engine-mode/repositories/reservation-engine-mode-config.repository';
import { ReservationAvailabilityService } from '../../reservation-engine-mode/services/reservation-availability.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { ReservationModeFenceCoordinatorService } from '../../reservation-engine-mode/services/reservation-mode-fence-coordinator.service';
import { checkoutPinKey } from '../../reservation-fence/lua/checkout-settlement.lua';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { openOrdinarySchema } from '../../reservation-fence/tests/ordinary-provenance-test-helpers';
import { ReservationRecoveryConvergenceService } from '../../reservation-recovery/services/reservation-recovery-convergence.service';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CutoverFreshnessResetAuditRepository, sha256Hex } from '../repositories/cutover-freshness-reset-audit.repository';
import { CartScopedBackfillService } from './cart-scoped-backfill.service';
import { CartScopedOrphanReleaseService } from './cart-scoped-orphan-release.service';
import { CutoverFreshnessResetService } from './cutover-freshness-reset.service';

const ISOLATED_DB_INDEX = 9;
jest.setTimeout(90_000);

async function buildCutoverHarness() {
  const schema = await openOrdinarySchema();
  const prisma = schema.db;
  const redisClient = await connectRealRedis();
  await redisClient.select(ISOLATED_DB_INDEX);
  await redisClient.flushdb();
  const redisService = new RedisService(redisClient);

  const cartRepository = new CartRepository(prisma);
  const syncStateRepository = new CartReservationSyncStateRepository(prisma);
  const barrierRepository = new CartMutationBarrierConfigRepository(prisma);
  const mutationBarrier = new CartMutationBarrierService(prisma, barrierRepository);
  const modeRepository = new ReservationEngineModeConfigRepository(prisma);
  const inventoryReservations = new InventoryReservationsService(redisService);
  Object.assign(inventoryReservations, {
    ordinary: new OrdinaryReservationService(prisma, redisService),
    observationPrisma: prisma,
  });
  const fenceCoordinator = new ReservationModeFenceCoordinatorService(prisma, redisService);
  const modeService = new ReservationEngineModeService(
    prisma, modeRepository, redisService, inventoryReservations, barrierRepository, fenceCoordinator,
  );
  const availability = new ReservationAvailabilityService(modeService, inventoryReservations);
  const compensationService = new CompensationService(new CompensationRepository(prisma));
  const gateway = new CheckoutReservationFacade(modeService, inventoryReservations, availability, compensationService);
  const convergence = new CartReservationConvergenceService(prisma, cartRepository, gateway, syncStateRepository);
  const idempotency = new CartItemAddIdempotencyService(new CartItemAddAttemptRepository(prisma));
  const usersRepository = new UsersRepository(prisma);
  const vendorsRepository = new VendorsRepository(prisma);
  const categoriesRepository = new CategoriesRepository(prisma);
  const productsRepository = new ProductsRepository(prisma);
  const cartService = new CartService(
    prisma, cartRepository, productsRepository, vendorsRepository, gateway, syncStateRepository, convergence, idempotency, mutationBarrier,
  );
  const recoveryConvergence = new ReservationRecoveryConvergenceService(modeService, inventoryReservations);
  const auditRepository = new CutoverFreshnessResetAuditRepository(prisma);
  const freshnessReset = new CutoverFreshnessResetService(prisma, redisService, auditRepository);
  const backfillService = new CartScopedBackfillService(
    cartRepository, syncStateRepository, recoveryConvergence, inventoryReservations, freshnessReset,
  );
  const orphanService = new CartScopedOrphanReleaseService(redisService, cartRepository, inventoryReservations);

  const [customerRole, vendorRole, adminRole] = await Promise.all([
    prisma.role.upsert({ where: { name: RoleName.CUSTOMER }, update: {}, create: { name: RoleName.CUSTOMER } }),
    prisma.role.upsert({ where: { name: RoleName.VENDOR }, update: {}, create: { name: RoleName.VENDOR } }),
    prisma.role.upsert({ where: { name: RoleName.ADMINISTRATOR }, update: {}, create: { name: RoleName.ADMINISTRATOR } }),
  ]);
  const [customer, vendorUser, adminUser] = await Promise.all([
    usersRepository.create({
      email: `e2e-cust-${randomUUID()}@example.com`, passwordHash: 'hashed', firstName: 'Ezra', lastName: 'Buyer',
      roleId: customerRole.id, emailVerificationTokenHash: 'h', emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    }),
    usersRepository.create({
      email: `e2e-vend-${randomUUID()}@example.com`, passwordHash: 'hashed', firstName: 'Vera', lastName: 'Vendor',
      roleId: vendorRole.id, emailVerificationTokenHash: 'h', emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    }),
    usersRepository.create({
      email: `e2e-adm-${randomUUID()}@example.com`, passwordHash: 'hashed', firstName: 'Ann', lastName: 'Admin',
      roleId: adminRole.id, emailVerificationTokenHash: 'h', emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    }),
  ]);
  const vendor = await vendorsRepository.create({
    userId: vendorUser.id, businessName: "Ezra's Catch", parish: 'KINGSTON', termsAcceptedAt: new Date(),
  });
  await prisma.vendor.update({ where: { id: vendor.id }, data: { status: 'APPROVED' } });
  const category = await categoriesRepository.create({ name: `Cat-${randomUUID()}`, slug: `cat-${randomUUID()}` });
  const product = await productsRepository.create({
    vendorId: vendor.id, categoryId: category.id, name: 'Cutover E2E Snapper', description: 'Disposable cutover test SKU.',
    unit: 'PER_POUND', price: 500, quantityAvailable: 50, imageUrl: 'https://cdn.example.com/snapper.jpg',
  });

  return {
    schema, prisma, redisClient, cartRepository, mutationBarrier, inventoryReservations, cartService, modeService,
    backfillService, orphanService, customerId: customer.id, adminUserId: adminUser.id, productId: product.id,
    close: async () => {
      try { await redisClient.flushdb(); } finally {
        try { await redisClient.quit(); } finally { await schema.close(); }
      }
    },
  };
}

describe('CART_SCOPED cutover, full sequence, disposable 68-migration Postgres + W1 + coordinated fence', () => {
  it('runs complete LEGACY -> MIRROR -> frozen -> backfilled -> authorized freshnessSweep -> CART_SCOPED sequence', async () => {
    const h = await buildCutoverHarness();
    try {
      const mirrorRes = await h.modeService.setMode({ targetMode: 'MIRROR', updatedById: h.adminUserId });
      expect(mirrorRes).toMatchObject({ ok: true, mode: 'MIRROR' });
      expect(await h.modeService.checkModeFenceConsistency()).toBe(true);

      await h.cartService.addItem(h.customerId, { productId: h.productId, quantity: 5 }, randomUUID());
      const cart = await h.cartRepository.findOrCreateByCustomerId(h.customerId);
      const beforeSweepRaw = JSON.parse((await h.redisClient.get(reservationKey(cart.id, h.productId)))!) as {
        createdAt: number; absoluteExpiresAt: number; quantity: number;
      };
      expect(beforeSweepRaw.quantity).toBe(5);

      const orphanCartId = randomUUID();
      await seedHistoricalActiveReservation(h.redisClient, orphanCartId, h.productId, h.customerId, 3);
      expect(await h.redisClient.get(productTotalKey(h.productId))).toBe('8');

      const barrier = await h.mutationBarrier.activate(h.adminUserId);
      expect(barrier.active).toBe(true);
      await expect(h.cartService.addItem(h.customerId, { productId: h.productId, quantity: 1 }, randomUUID())).rejects.toThrow();

      const targets = await h.backfillService.enumeratePositiveTargets();
      expect(targets).toEqual([{ cartId: cart.id, productId: h.productId, customerId: h.customerId, quantity: 5 }]);
      expect(await h.backfillService.backfillTargets(targets)).toEqual([{ outcome: 'CONVERGED', target: targets[0] }]);

      const orphanOutcomes = await h.orphanService.discoverAndReleaseOrphans();
      expect(orphanOutcomes.find((o) => o.cartId === orphanCartId && o.productId === h.productId)).toEqual({
        cartId: orphanCartId, productId: h.productId, released: true,
      });
      expect(await h.redisClient.get(productTotalKey(h.productId))).toBe('5');

      // Unauthorized freshnessSweep (no cutover authorization) fails closed and leaves Redis untouched.
      const unauthOutcomes = await h.backfillService.freshnessSweep(targets);
      expect(unauthOutcomes).toEqual([{ outcome: 'BLOCKED', target: targets[0], blockReason: 'FRESHNESS_UNAUTHORIZED' }]);
      expect(() => h.backfillService.buildAttestation(targets, unauthOutcomes, barrier.revision!)).toThrow();

      const cutoverRunId = randomUUID();
      const freshnessOutcomes = await h.backfillService.freshnessSweep(targets, {
        cutoverRunId,
        operatorId: h.adminUserId,
        barrierRevision: barrier.revision!,
      });
      expect(freshnessOutcomes).toHaveLength(1);
      const [f0] = freshnessOutcomes;
      expect(f0).toMatchObject({ outcome: 'CONVERGED', target: targets[0] });
      if (f0!.outcome !== 'CONVERGED') throw new Error('Expected CONVERGED freshness outcome');

      const marker = await h.prisma.cartReservationSyncState.findUniqueOrThrow({
        where: { cartId_productId: { cartId: cart.id, productId: h.productId } },
      });
      const audit = await h.prisma.cutoverFreshnessResetAudit.findUniqueOrThrow({
        where: {
          cutoverRunId_barrierRevision_markerId_generation: {
            cutoverRunId,
            barrierRevision: barrier.revision!,
            markerId: marker.id,
            generation: marker.generation,
          },
        },
      });
      expect(audit.status).toBe('COMPLETED');
      expect(sha256Hex(audit.redisReceipt!)).toBe(audit.redisReceiptHash);
      expect(audit.newExpiresAtMs).toBe(BigInt(f0!.expiresAt));
      expect(Number(audit.newAbsoluteExpiresAtMs! - audit.newCreatedAtMs!)).toBe(3_600_000);
      expect(f0!.expiresAt).toBe(Number(audit.newCreatedAtMs!) + RESERVATION_TTL_SECONDS * 1000);
      expect(await h.redisClient.get(productTotalKey(h.productId))).toBe('5');

      const attestation = h.backfillService.buildAttestation(targets, freshnessOutcomes, barrier.revision!);
      const cutoverResult = await h.modeService.setMode({
        targetMode: 'CART_SCOPED',
        updatedById: h.adminUserId,
        cutoverAttestation: attestation,
      });
      expect(cutoverResult).toMatchObject({ ok: true, mode: 'CART_SCOPED' });
      expect(await h.modeService.checkModeFenceConsistency()).toBe(true);
      expect(JSON.parse((await h.redisClient.get(RESERVATION_FENCE_KEY))!)).toMatchObject({ phase: 'OPEN' });

      await h.mutationBarrier.deactivate(h.adminUserId);
      await h.cartService.addItem(h.customerId, { productId: h.productId, quantity: 2 }, randomUUID());
      expect(await h.inventoryReservations.getActiveReservation(cart.id, h.productId)).toMatchObject({
        status: 'ACTIVE', entry: { quantity: 7 },
      });
      expect(await h.redisClient.get(productTotalKey(h.productId))).toBe('7');
    } finally {
      await h.close();
    }
  });

  it('blocks cutover when any freshness target fails to converge (e.g. active checkout pin)', async () => {
    const h = await buildCutoverHarness();
    try {
      await h.modeService.setMode({ targetMode: 'MIRROR', updatedById: h.adminUserId });
      await h.cartService.addItem(h.customerId, { productId: h.productId, quantity: 4 }, randomUUID());
      const cart = await h.cartRepository.findOrCreateByCustomerId(h.customerId);
      const marker = await h.prisma.cartReservationSyncState.findUniqueOrThrow({
        where: { cartId_productId: { cartId: cart.id, productId: h.productId } },
      });
      const barrier = await h.mutationBarrier.activate(h.adminUserId);
      const targets = await h.backfillService.enumeratePositiveTargets();

      await h.redisClient.set(checkoutPinKey(marker.id), 'checkout-in-flight');
      const outcomes = await h.backfillService.freshnessSweep(targets, {
        cutoverRunId: randomUUID(),
        operatorId: h.adminUserId,
        barrierRevision: barrier.revision!,
      });
      expect(outcomes).toEqual([
        { outcome: 'RETRY', target: targets[0], reasonCode: 'CHECKOUT_IN_PROGRESS', lastError: expect.any(String) as string },
      ]);
      expect(() => h.backfillService.buildAttestation(targets, outcomes, barrier.revision!)).toThrow();
      expect(await h.modeService.getCurrentMode()).toBe('MIRROR');
      expect((await h.prisma.cartMutationBarrierConfig.findFirst({ orderBy: { revision: 'desc' } }))?.active).toBe(true);
    } finally {
      await h.close();
    }
  });
});
