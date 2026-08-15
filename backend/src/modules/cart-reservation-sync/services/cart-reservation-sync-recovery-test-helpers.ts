import { randomUUID } from 'crypto';

import { Category, Product, Role, RoleName, Vendor } from '@prisma/client';
import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { CartItemAddAttemptRepository } from '../../cart/repositories/cart-item-add-attempt.repository';
import { CartItemAddIdempotencyService } from '../../cart/services/cart-item-add-idempotency.service';
import { CartReservationConvergenceService } from '../../cart/services/cart-reservation-convergence.service';
import { CartService } from '../../cart/services/cart.service';
import { buildLegacyReservationGateway } from '../../checkout-reservation/services/checkout-reservation-facade-test-helpers';
import { connectRealRedis } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { ReservationEngineModeConfigRepository } from '../../reservation-engine-mode/repositories/reservation-engine-mode-config.repository';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { ReservationRecoveryConvergenceService } from '../../reservation-recovery/services/reservation-recovery-convergence.service';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartReservationSyncStateRepository } from '../repositories/cart-reservation-sync-state.repository';
import { CartReservationSyncBlockedRecheckService } from './cart-reservation-sync-blocked-recheck.service';
import { CartReservationSyncRecoveryService } from './cart-reservation-sync-recovery.service';

// Shared plumbing for the real-Postgres + real-Redis DA.1B recovery specs
// (Phase 16A.0-DA, Unit DA.1B, see the DA.1B claim-fencing review).
// InventoryReservationsService is never mocked away here - reconcileOne's
// whole job is converging real Redis state, so only a real client proves
// what it actually did. Dedicated Redis index - see the sibling DA.1A
// concurrency specs' own comments for why 1-7 are already claimed.
export const RECOVERY_ISOLATED_DB_INDEX = 8;

export interface RecoveryFixture {
  redisClient: Redis;
  prisma: PrismaService;
  cartRepository: CartRepository;
  syncStateRepository: CartReservationSyncStateRepository;
  inventoryReservations: InventoryReservationsService;
  cartService: CartService;
  recoveryService: CartReservationSyncRecoveryService;
  // Phase 16A.0-DA, Unit DA.4B additions - exposed so mode-race integration
  // specs can drive real setMode() transitions and directly exercise the
  // blocked-recheck entry point without reconstructing the whole fixture.
  modeService: ReservationEngineModeService;
  modeConfigRepository: ReservationEngineModeConfigRepository;
  recoveryTarget: ReservationRecoveryConvergenceService;
  blockedRecheckService: CartReservationSyncBlockedRecheckService;
  productsRepository: ProductsRepository;
  vendorId: string;
  categoryId: string;
  customerId: string;
  vendorUserId: string;
  category: Category;
  adminUserId: string;
}

export async function setUpRecoveryFixture(namePrefix: string): Promise<RecoveryFixture> {
  const redisClient = await connectRealRedis();
  await redisClient.select(RECOVERY_ISOLATED_DB_INDEX);
  await redisClient.flushdb();

  const prisma = new PrismaService();
  await prisma.onModuleInit();
  const cartRepository = new CartRepository(prisma);
  const syncStateRepository = new CartReservationSyncStateRepository(prisma);
  const redisService = new RedisService(redisClient);
  const inventoryReservations = new InventoryReservationsService(redisService);

  const usersRepository = new UsersRepository(prisma);
  const vendorsRepository = new VendorsRepository(prisma);
  const categoriesRepository = new CategoriesRepository(prisma);
  const productsRepository = new ProductsRepository(prisma);

  const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
  const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });

  const customer = await usersRepository.create({
    email: `${namePrefix}-customer-${randomUUID()}@example.com`,
    passwordHash: 'hashed',
    firstName: 'Rae',
    lastName: 'Recovery',
    roleId: customerRole.id,
    emailVerificationTokenHash: 'token-hash',
    emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
  });

  const vendorUser = await usersRepository.create({
    email: `${namePrefix}-vendor-${randomUUID()}@example.com`,
    passwordHash: 'hashed',
    firstName: 'Vera',
    lastName: 'Vendor',
    roleId: vendorRole.id,
    emailVerificationTokenHash: 'token-hash',
    emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
  });

  const vendor: Vendor = await vendorsRepository.create({
    userId: vendorUser.id,
    businessName: "Vera's Catch",
    parish: 'KINGSTON',
    termsAcceptedAt: new Date(),
  });
  await prisma.vendor.update({ where: { id: vendor.id }, data: { status: 'APPROVED' } });

  const category = await categoriesRepository.create({
    name: `${namePrefix} Category ${randomUUID()}`,
    slug: `${namePrefix}-category-${randomUUID()}`,
  });

  const admin = await usersRepository.create({
    email: `${namePrefix}-admin-${randomUUID()}@example.com`,
    passwordHash: 'hashed',
    firstName: 'Ada',
    lastName: 'Admin',
    roleId: vendorRole.id,
    emailVerificationTokenHash: 'token-hash',
    emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
  });

  const gateway = buildLegacyReservationGateway(inventoryReservations);
  const convergence = new CartReservationConvergenceService(prisma, cartRepository, gateway, syncStateRepository);
  const idempotency = new CartItemAddIdempotencyService(new CartItemAddAttemptRepository(prisma));
  const cartService = new CartService(
    prisma,
    cartRepository,
    productsRepository,
    vendorsRepository,
    gateway,
    syncStateRepository,
    convergence,
    idempotency,
  );

  // Phase 16A.0-DA, Unit DA.4B. Recovery now goes through
  // ReservationRecoveryConvergenceService (the mode-aware recovery-authority
  // port), never InventoryReservationsService directly - see the DA.4B
  // frozen plan. modeConfigRepository/modeService are real, against the
  // same Postgres/Redis connections as everything else in this fixture, so
  // real setMode() transitions and the shared/exclusive advisory-lock
  // fencing are genuinely exercised, never mocked.
  const modeConfigRepository = new ReservationEngineModeConfigRepository(prisma);
  const modeService = new ReservationEngineModeService(prisma, modeConfigRepository, redisService, inventoryReservations);
  const recoveryTarget = new ReservationRecoveryConvergenceService(modeService, inventoryReservations);
  const blockedRecheckService = new CartReservationSyncBlockedRecheckService(
    syncStateRepository,
    cartRepository,
    inventoryReservations,
    modeService,
  );
  const recoveryService = new CartReservationSyncRecoveryService(
    syncStateRepository,
    cartRepository,
    recoveryTarget,
    modeService,
    prisma,
    blockedRecheckService,
  );

  return {
    redisClient,
    prisma,
    cartRepository,
    syncStateRepository,
    inventoryReservations,
    cartService,
    recoveryService,
    modeService,
    modeConfigRepository,
    recoveryTarget,
    blockedRecheckService,
    productsRepository,
    vendorId: vendor.id,
    categoryId: category.id,
    customerId: customer.id,
    vendorUserId: vendorUser.id,
    category,
    adminUserId: admin.id,
  };
}

export async function tearDownRecoveryFixture(fixture: RecoveryFixture): Promise<void> {
  const cart = await fixture.cartRepository.findOrCreateByCustomerId(fixture.customerId);
  await fixture.prisma.cartItemAddAttempt.deleteMany({ where: { cartId: cart.id } });
  await fixture.prisma.cartReservationSyncState.deleteMany({ where: { cartId: cart.id } });
  // Phase 16A.0-DA, Unit DA.4B: any ReservationEngineModeConfig rows this
  // fixture's own tests created via setMode() must be cleared before the
  // admin user (their updatedById FK target) can be deleted - this table's
  // append-only rows are never touched by any other fixture in this file,
  // so a wholesale delete scoped to this fixture's own admin is safe.
  await fixture.prisma.reservationEngineModeConfig.deleteMany({ where: { updatedById: fixture.adminUserId } });
  await fixture.prisma.user.delete({ where: { id: fixture.customerId } });
  await fixture.prisma.user.delete({ where: { id: fixture.vendorUserId } });
  await fixture.prisma.user.delete({ where: { id: fixture.adminUserId } });
  await fixture.prisma.category.delete({ where: { id: fixture.category.id } });
  await fixture.prisma.onModuleDestroy();
  await fixture.redisClient.flushdb();
  await fixture.redisClient.quit();
}

// Phase 16A.0-DA, Unit DA.4B. fixture.cartService is deliberately wired to
// a LEGACY-only fake gateway (buildLegacyReservationGateway - see the DA.3
// test-helper rationale: "LEGACY remains the only effective mode" was the
// whole point at the time). It never observes a mode-touching test's own
// setMode() transitions, so every marker DA.4B's own tests need under a
// non-LEGACY mode is built directly against the repositories instead -
// this is also a more precise proof, since it means reconcileOne's own
// write is the ONLY thing that ever touches Redis in these tests.
export async function unresolvedReserveMarker(
  fixture: RecoveryFixture,
  quantity: number,
): Promise<{ cartId: string; productId: string; markerId: string }> {
  const { cartRepository, syncStateRepository, customerId } = fixture;
  const product = await createProduct(fixture, 'Mode Aware Test');
  const cart = await cartRepository.findOrCreateByCustomerId(customerId);
  await cartRepository.addOrIncrementItem(cart.id, product.id, quantity);
  await syncStateRepository.upsertDesiredState(cart.id, product.id, 0, quantity);
  const marker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
  return { cartId: cart.id, productId: product.id, markerId: marker!.id };
}

export async function unresolvedReleaseMarker(
  fixture: RecoveryFixture,
  quantity: number,
): Promise<{ cartId: string; productId: string; markerId: string }> {
  const { cartId, productId } = await unresolvedReserveMarker(fixture, quantity);
  const item = await fixture.cartRepository.findItemByCartAndProduct(cartId, productId);
  await fixture.prisma.cartItem.delete({ where: { id: item!.id } });
  await fixture.syncStateRepository.upsertDesiredState(cartId, productId, item!.mutationVersion, null);
  const marker = await fixture.syncStateRepository.findByCartAndProduct(cartId, productId);
  return { cartId, productId, markerId: marker!.id };
}

export function createProduct(fixture: RecoveryFixture, name: string): Promise<Product> {
  return fixture.productsRepository.create({
    vendorId: fixture.vendorId,
    categoryId: fixture.categoryId,
    name: `${name} ${randomUUID()}`,
    description: 'A product used only for one DA.1B recovery integration test case.',
    unit: 'PER_POUND',
    price: 500,
    quantityAvailable: 50,
    imageUrl: 'https://cdn.example.com/snapper.jpg',
  });
}

// Delay-spy helpers (installDelayedReserveSpy, installDelayedReleaseSpy,
// installDelayedReserveOrRenewSpy, installDelayedReleaseReservationSpy,
// DelayedCallHandle) now live in
// cart-reservation-sync-recovery-delay-spy-test-helpers.ts - split purely
// to keep both files within the repository's 400-line limit.

// Phase 16A.0-DA, Unit DA.4B. ReservationEngineModeConfig is a single
// GLOBAL, unscoped table - unlike everything else in this fixture, its
// "current" row is not isolated per test file. Both forceLegacyMode and
// ensureMode always walk a fully valid path from whatever mode is
// ACTUALLY current (never assumed), so DA.4B's mode-touching integration
// specs can never leak a non-LEGACY mode into any other test file sharing
// the same --runInBand process, regardless of execution order.
export async function forceLegacyMode(fixture: RecoveryFixture): Promise<void> {
  const current = await fixture.modeService.getCurrentMode();
  if (current === 'LEGACY') {
    return;
  }
  if (current === 'MIRROR') {
    await fixture.modeService.setMode({ targetMode: 'LEGACY', updatedById: fixture.adminUserId });
    return;
  }
  if (current === 'CART_SCOPED') {
    await fixture.modeService.setMode({ targetMode: 'DRAINING', updatedById: fixture.adminUserId });
  }
  // Dedicated, exclusive Redis DB index for this fixture - safe to flush
  // wholesale to guarantee verifyRollbackSafe's gate passes.
  await fixture.redisClient.flushdb();
  const rollback = await fixture.modeService.setMode({ targetMode: 'LEGACY', updatedById: fixture.adminUserId });
  if (!rollback.ok) {
    throw new Error(`Failed to force LEGACY mode in test setup/teardown: ${JSON.stringify(rollback)}`);
  }
}

export async function ensureMode(
  fixture: RecoveryFixture,
  target: 'LEGACY' | 'MIRROR' | 'CART_SCOPED' | 'DRAINING',
): Promise<void> {
  await forceLegacyMode(fixture);
  if (target === 'LEGACY') {
    return;
  }
  await fixture.modeService.setMode({ targetMode: 'MIRROR', updatedById: fixture.adminUserId });
  if (target === 'MIRROR') {
    return;
  }
  await fixture.modeService.setMode({ targetMode: 'CART_SCOPED', updatedById: fixture.adminUserId });
  if (target === 'CART_SCOPED') {
    return;
  }
  await fixture.modeService.setMode({ targetMode: 'DRAINING', updatedById: fixture.adminUserId });
}
