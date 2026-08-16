import { randomUUID } from 'crypto';

import { ReservationEngineMode, ReservationEngineModeConfig, Role, RoleName } from '@prisma/client';

import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartMutationBarrierConfigRepository } from '../../cart-mutation-barrier/repositories/cart-mutation-barrier-config.repository';
import { CartMutationBarrierService } from '../../cart-mutation-barrier/services/cart-mutation-barrier.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { CartReservationConvergenceService } from '../../cart/services/cart-reservation-convergence.service';
import { CartService } from '../../cart/services/cart.service';
import { CartItemAddAttemptRepository } from '../../cart/repositories/cart-item-add-attempt.repository';
import { CartItemAddIdempotencyService } from '../../cart/services/cart-item-add-idempotency.service';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { CheckoutReservationFacade } from '../../checkout-reservation/services/checkout-reservation-facade.service';
import { connectRealRedis } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CompensationService } from '../../mirror-compensation/services/compensation.service';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import {
  CreateReservationEngineModeConfigInput,
  PrismaClientOrTx,
  ReservationEngineModeConfigRepository,
} from '../../reservation-engine-mode/repositories/reservation-engine-mode-config.repository';
import { ReservationAvailabilityService } from '../../reservation-engine-mode/services/reservation-availability.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { ReservationRecoveryConvergenceService } from '../../reservation-recovery/services/reservation-recovery-convergence.service';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartScopedBackfillService } from './cart-scoped-backfill.service';
import { CartScopedOrphanReleaseService } from './cart-scoped-orphan-release.service';

// CART_SCOPED activation-boundary gate (see the gate design review's final,
// frozen implementation spec). The single full-sequence proof: MIRROR ->
// barrier active (frozen) -> backfilled/fresh -> CART_SCOPED, exercising
// the actual orchestration services setMode()/CartScopedBackfillService/
// CartScopedOrphanReleaseService the CLI orchestrator itself calls, against
// real Postgres and real Redis throughout.
//
// The one deliberate exception: ReservationEngineModeConfig - the actual
// operational MIRROR/CART_SCOPED authority record - is backed by an
// in-memory, test-local fake repository, never the real
// reservation_engine_mode_configs table. This is the frozen spec's own
// requirement ("do not invoke setMode() against the development/staging
// production-like database as an operational activation; test-local
// isolated invocations are permitted only where required to prove the
// gate"): every other precondition setMode() checks - the mutation
// barrier, the DA.1B sync backlog, the C4 compensation backlog, the
// positive-CartItem count - runs for real, inside setMode()'s own real
// Postgres transaction and real TRANSITION_LOCK_KEY advisory lock; only
// the row that would durably flip the SHARED dev database's current mode
// for every other process/test is isolated.
const ISOLATED_DB_INDEX = 9;

jest.setTimeout(30_000);

function createIsolatedModeConfigRepository(
  seedMode: ReservationEngineMode,
): ReservationEngineModeConfigRepository {
  let current: ReservationEngineModeConfig = {
    id: randomUUID(),
    revision: 0,
    mode: seedMode,
    updatedById: null,
    createdAt: new Date(),
  };
  let nextRevision = 1;

  return {
    findCurrent: (_client?: PrismaClientOrTx) => Promise.resolve(current),
    create: (input: CreateReservationEngineModeConfigInput, _client?: PrismaClientOrTx) => {
      current = {
        id: randomUUID(),
        revision: nextRevision++,
        mode: input.mode,
        updatedById: input.updatedById,
        createdAt: new Date(),
      };
      return Promise.resolve(current);
    },
  } as unknown as ReservationEngineModeConfigRepository;
}

describe('CART_SCOPED cutover, full sequence, real Postgres + Redis (isolated mode-authority row)', () => {
  let prisma: PrismaService;
  let redisClient: Awaited<ReturnType<typeof connectRealRedis>>;
  let cartRepository: CartRepository;
  let syncStateRepository: CartReservationSyncStateRepository;
  let mutationBarrierRepository: CartMutationBarrierConfigRepository;
  let mutationBarrier: CartMutationBarrierService;
  let inventoryReservations: InventoryReservationsService;
  let cartService: CartService;
  let modeService: ReservationEngineModeService;
  let backfillService: CartScopedBackfillService;
  let orphanService: CartScopedOrphanReleaseService;
  let customerId: string;
  let vendorUserId: string;
  let adminUserId: string;
  let productId: string;
  let orphanCartId: string;
  let categoryId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    redisClient = await connectRealRedis();
    await redisClient.select(ISOLATED_DB_INDEX);
    await redisClient.flushdb();

    cartRepository = new CartRepository(prisma);
    syncStateRepository = new CartReservationSyncStateRepository(prisma);
    mutationBarrierRepository = new CartMutationBarrierConfigRepository(prisma);
    mutationBarrier = new CartMutationBarrierService(prisma, mutationBarrierRepository);
    const redisService = new RedisService(redisClient);
    inventoryReservations = new InventoryReservationsService(redisService);

    // modeService is real and LIVE - its getCurrentMode() reflects the
    // isolated in-memory fake's current row at whatever point in the test
    // it is read, so cartService's own gateway genuinely re-routes from
    // MIRROR to CART_SCOPED across step 6's setMode() call below, rather
    // than being pinned to one mode for the whole test (see
    // buildLegacyReservationGateway's own doc comment for why that helper
    // is unsuitable here - it hardcodes LEGACY forever, which would make
    // the post-cutover routing proof in step 7 vacuous).
    modeService = new ReservationEngineModeService(
      prisma,
      createIsolatedModeConfigRepository('MIRROR'),
      redisService,
      inventoryReservations,
      mutationBarrierRepository,
    );
    const availability = new ReservationAvailabilityService(modeService, inventoryReservations);
    const gateway = new CheckoutReservationFacade(
      modeService,
      inventoryReservations,
      availability,
      {} as CompensationService,
    );
    const convergence = new CartReservationConvergenceService(prisma, cartRepository, gateway, syncStateRepository);
    const idempotency = new CartItemAddIdempotencyService(new CartItemAddAttemptRepository(prisma));

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);

    cartService = new CartService(
      prisma,
      cartRepository,
      productsRepository,
      vendorsRepository,
      gateway,
      syncStateRepository,
      convergence,
      idempotency,
      mutationBarrier,
    );

    const recoveryConvergence = new ReservationRecoveryConvergenceService(modeService, inventoryReservations);
    backfillService = new CartScopedBackfillService(cartRepository, syncStateRepository, recoveryConvergence, inventoryReservations);
    orphanService = new CartScopedOrphanReleaseService(redisService, cartRepository, inventoryReservations);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });
    const adminRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.ADMINISTRATOR } });

    const customer = await usersRepository.create({
      email: `cutover-e2e-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Ezra',
      lastName: 'Endtoend',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;
    const vendorUser = await usersRepository.create({
      email: `cutover-e2e-vendor-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vera',
      lastName: 'Vendor',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    vendorUserId = vendorUser.id;
    const adminUser = await usersRepository.create({
      email: `cutover-e2e-admin-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Ann',
      lastName: 'Admin',
      roleId: adminRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    adminUserId = adminUser.id;
    const vendor = await vendorsRepository.create({
      userId: vendorUserId,
      businessName: "Ezra's Catch",
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });
    await prisma.vendor.update({ where: { id: vendor.id }, data: { status: 'APPROVED' } });
    const category = await categoriesRepository.create({
      name: `Cutover E2E Category ${randomUUID()}`,
      slug: `cutover-e2e-category-${randomUUID()}`,
    });
    categoryId = category.id;
    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId,
      name: 'Cutover E2E Snapper',
      description: 'Used only for the full cutover-sequence end-to-end test.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    productId = product.id;
    orphanCartId = randomUUID();
  });

  afterAll(async () => {
    await mutationBarrier.deactivate(adminUserId);
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    await prisma.cartItemAddAttempt.deleteMany({ where: { cartId: cart.id } });
    await prisma.cartReservationSyncState.deleteMany({ where: { cartId: cart.id } });
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    await prisma.cartMutationBarrierConfig.deleteMany({ where: { activatedById: adminUserId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.user.delete({ where: { id: adminUserId } });
    await prisma.category.delete({ where: { id: categoryId } });
    await prisma.onModuleDestroy();
    await redisClient.flushdb();
    await redisClient.quit();
  });

  it('runs the complete MIRROR -> frozen -> backfilled -> CART_SCOPED sequence and post-cutover routing reflects it', async () => {
    // 1. Customer admission while mode is still MIRROR - the real
    // CartService.addItem entry point, producing a durable CartItem and a
    // resolved DA.1A marker exactly as production traffic would.
    await cartService.addItem(customerId, { productId, quantity: 5 }, randomUUID());
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    // An orphaned cart-scoped hold with no corresponding CartItem at all -
    // proving the orphan-release step is load-bearing in this same
    // sequence, not just in isolation.
    await inventoryReservations.reserveOrRenew(orphanCartId, productId, customerId, 3);

    expect(await modeService.getCurrentMode()).toBe('MIRROR');

    // 2. Freeze: activate the mutation barrier. New admission is rejected.
    const barrierSnapshot = await mutationBarrier.activate(adminUserId);
    expect(barrierSnapshot.active).toBe(true);
    await expect(cartService.addItem(customerId, { productId, quantity: 1 }, randomUUID())).rejects.toThrow();

    // 3. Backfill: enumerate every durable positive target and converge it
    // directly to the cart-scoped engine (mode is still MIRROR throughout).
    const targets = await backfillService.enumeratePositiveTargets();
    expect(targets).toEqual([{ cartId: cart.id, productId, customerId, quantity: 5 }]);
    const backfillOutcomes = await backfillService.backfillTargets(targets);
    expect(backfillOutcomes).toEqual([{ outcome: 'CONVERGED', target: targets[0] }]);

    // 4. Orphan discovery/release - the stale orphanCartId hold is released,
    // the genuine target is untouched.
    const orphanOutcomes = await orphanService.discoverAndReleaseOrphans();
    expect(orphanOutcomes.find((o) => o.cartId === orphanCartId && o.productId === productId)).toEqual({
      cartId: orphanCartId,
      productId,
      released: true,
    });
    expect(await inventoryReservations.getActiveReservation(orphanCartId, productId)).toBeNull();
    expect((await inventoryReservations.getActiveReservation(cart.id, productId))?.quantity).toBe(5);

    // 5. Freshness sweep + attestation.
    const freshnessOutcomes = await backfillService.freshnessSweep(targets);
    expect(freshnessOutcomes).toHaveLength(1);
    const [freshnessOutcome] = freshnessOutcomes;
    expect(freshnessOutcome!.outcome).toBe('CONVERGED');
    expect(freshnessOutcome!.target).toEqual(targets[0]);
    if (freshnessOutcome!.outcome !== 'CONVERGED') {
      throw new Error('test setup invariant: freshness sweep must converge');
    }
    expect(typeof freshnessOutcome!.expiresAt).toBe('number');
    const barrierRevision = barrierSnapshot.revision;
    if (barrierRevision === null) {
      throw new Error('test setup invariant: barrier revision must be non-null once active');
    }
    const attestation = backfillService.buildAttestation(targets, freshnessOutcomes, barrierRevision);
    expect(attestation.targetCount).toBe(1);
    expect(attestation.barrierRevision).toBe(barrierRevision);

    // 6. Transition: the real setMode() gate, checking real Postgres
    // backlog counts and the real barrier row, writing only to the
    // isolated in-memory mode-authority fake.
    const result = await modeService.setMode({
      targetMode: 'CART_SCOPED',
      updatedById: adminUserId,
      cutoverAttestation: attestation,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('test setup invariant: cutover transition must succeed');
    }
    expect(typeof result.id).toBe('string');
    expect(result.mode).toBe('CART_SCOPED');
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(await modeService.getCurrentMode()).toBe('CART_SCOPED');

    // 7. Post-cutover: lift the barrier and prove routing now genuinely
    // uses CART_SCOPED authority - a NEW admission via the real
    // CartService.addItem entry point succeeds, and the resulting Redis
    // entry reflects the CART_SCOPED-only reserveOrRenew primitive, not a
    // legacy write.
    await mutationBarrier.deactivate(adminUserId);
    await cartService.addItem(customerId, { productId, quantity: 2 }, randomUUID());
    const postCutover = await inventoryReservations.getActiveReservation(cart.id, productId);
    expect(postCutover?.quantity).toBe(7);
  });
});
