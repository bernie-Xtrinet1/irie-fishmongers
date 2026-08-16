import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { CartReservationConvergenceService } from '../../cart/services/cart-reservation-convergence.service';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { buildLegacyReservationGateway } from '../../checkout-reservation/services/checkout-reservation-facade-test-helpers';
import { connectRealRedis } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartMutationBarrierConfigRepository } from '../repositories/cart-mutation-barrier-config.repository';
import { CartMutationBarrierService } from './cart-mutation-barrier.service';

// CART_SCOPED activation-boundary gate (see the gate design review's
// coverage audit). Real-Postgres+Redis proof of the one deliberate
// exemption from the barrier: DA.1A compensation
// (CartReservationConvergenceService.applyCompensation, reached only from
// convergeReservation) never checks CartMutationBarrierConfig - it is the
// tail-end settlement of an already-admitted primary mutation, not a new
// admission decision, and its own marker is transitively covered by the
// DA.1B unresolved-backlog hard blocker (CUTOVER_SYNC_BACKLOG, proven
// generically in reservation-engine-mode-cutover.service.spec.ts
// regardless of what left a marker unresolved).
const ISOLATED_DB_INDEX = 9;

jest.setTimeout(20_000);

describe('DA.1A compensation is exempt from the cart mutation barrier (real Postgres + Redis)', () => {
  let prisma: PrismaService;
  let cartRepository: CartRepository;
  let syncStateRepository: CartReservationSyncStateRepository;
  let convergence: CartReservationConvergenceService;
  let mutationBarrier: CartMutationBarrierService;
  let inventoryReservations: InventoryReservationsService;
  let customerId: string;
  let vendorUserId: string;
  let adminUserId: string;
  let productId: string;
  let category: Category;

  let redisClient: Awaited<ReturnType<typeof connectRealRedis>>;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const client = await connectRealRedis();
    await client.select(ISOLATED_DB_INDEX);
    redisClient = client;

    cartRepository = new CartRepository(prisma);
    syncStateRepository = new CartReservationSyncStateRepository(prisma);
    inventoryReservations = new InventoryReservationsService(new RedisService(client));
    const gateway = buildLegacyReservationGateway(inventoryReservations);
    convergence = new CartReservationConvergenceService(prisma, cartRepository, gateway, syncStateRepository);
    mutationBarrier = new CartMutationBarrierService(prisma, new CartMutationBarrierConfigRepository(prisma));

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);
    const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });
    const adminRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.ADMINISTRATOR } });

    const customer = await usersRepository.create({
      email: `barrier-comp-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Compensate',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;
    const vendorUser = await usersRepository.create({
      email: `barrier-comp-vendor-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vera',
      lastName: 'Vendor',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    vendorUserId = vendorUser.id;
    const adminUser = await usersRepository.create({
      email: `barrier-comp-admin-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Ann',
      lastName: 'Admin',
      roleId: adminRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    adminUserId = adminUser.id;
    const vendor: Vendor = await vendorsRepository.create({
      userId: vendorUserId,
      businessName: "Cara's Catch",
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });
    await prisma.vendor.update({ where: { id: vendor.id }, data: { status: 'APPROVED' } });
    category = await categoriesRepository.create({
      name: `Barrier Compensation Test Category ${randomUUID()}`,
      slug: `barrier-comp-test-category-${randomUUID()}`,
    });
    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Barrier Compensation Test Snapper',
      description: 'Used only for the compensation-exemption test.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    productId = product.id;
  });

  afterAll(async () => {
    await mutationBarrier.deactivate(adminUserId);
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    await prisma.cartReservationSyncState.deleteMany({ where: { cartId: cart.id } });
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    await prisma.cartMutationBarrierConfig.deleteMany({ where: { activatedById: adminUserId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.user.delete({ where: { id: adminUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
    await redisClient.quit();
  });

  it(
    "a compensating write proceeds and succeeds even while the barrier is active - it is never rejected the way a new admission is",
    async () => {
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);
      const item = await cartRepository.addOrIncrementItem(cart.id, productId, 5);
      const marker = await syncStateRepository.upsertDesiredState(cart.id, productId, item.mutationVersion, item.quantity);

      // Now activate the barrier - simulating compensation for an
      // already-admitted mutation that needs to settle WHILE the barrier
      // is active (the exact scenario the coverage audit's exemption
      // argument depends on).
      await mutationBarrier.activate(adminUserId);

      // Force the primary write to be treated as failed/ambiguous, driving
      // convergeReservation into applyCompensation's own CartItem-revert +
      // marker-advance transaction - which must succeed despite the
      // barrier being active.
      const reserveSpy = jest.spyOn(inventoryReservations, 'reserve').mockRejectedValueOnce(new Error('simulated Redis failure'));

      await convergence.convergeReservation(cart.id, productId, customerId, marker.generation, item.quantity, {
        kind: 'DELETE_IF_UNCHANGED',
        mutationVersion: item.mutationVersion,
      });

      // The compensation write was NOT blocked by the barrier: the
      // CartItem was reverted (deleted, since this was a fresh insert)
      // exactly as applyCompensation's own DELETE_IF_UNCHANGED plan
      // dictates - proving the write reached Postgres at all, which could
      // never happen if CartMutationBarrierActiveError had been thrown.
      const afterCompensation = await cartRepository.findItemByCartAndProduct(cart.id, productId);
      expect(afterCompensation).toBeNull();

      reserveSpy.mockRestore();
    },
    15_000,
  );
});
