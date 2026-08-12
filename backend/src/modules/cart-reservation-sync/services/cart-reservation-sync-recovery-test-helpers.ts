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
import { connectRealRedis } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartReservationSyncStateRepository } from '../repositories/cart-reservation-sync-state.repository';
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
  productsRepository: ProductsRepository;
  vendorId: string;
  categoryId: string;
  customerId: string;
  vendorUserId: string;
  category: Category;
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

  const convergence = new CartReservationConvergenceService(prisma, cartRepository, inventoryReservations, syncStateRepository);
  const idempotency = new CartItemAddIdempotencyService(new CartItemAddAttemptRepository(prisma));
  const cartService = new CartService(
    prisma,
    cartRepository,
    productsRepository,
    vendorsRepository,
    inventoryReservations,
    syncStateRepository,
    convergence,
    idempotency,
  );
  const recoveryService = new CartReservationSyncRecoveryService(syncStateRepository, cartRepository, inventoryReservations);

  return {
    redisClient,
    prisma,
    cartRepository,
    syncStateRepository,
    inventoryReservations,
    cartService,
    recoveryService,
    productsRepository,
    vendorId: vendor.id,
    categoryId: category.id,
    customerId: customer.id,
    vendorUserId: vendorUser.id,
    category,
  };
}

export async function tearDownRecoveryFixture(fixture: RecoveryFixture): Promise<void> {
  const cart = await fixture.cartRepository.findOrCreateByCustomerId(fixture.customerId);
  await fixture.prisma.cartItemAddAttempt.deleteMany({ where: { cartId: cart.id } });
  await fixture.prisma.cartReservationSyncState.deleteMany({ where: { cartId: cart.id } });
  await fixture.prisma.user.delete({ where: { id: fixture.customerId } });
  await fixture.prisma.user.delete({ where: { id: fixture.vendorUserId } });
  await fixture.prisma.category.delete({ where: { id: fixture.category.id } });
  await fixture.prisma.onModuleDestroy();
  await fixture.redisClient.flushdb();
  await fixture.redisClient.quit();
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

export interface DelayedCallHandle {
  staleCallStarted: Promise<void>;
  releaseStaleCall: () => void;
}

// Call-through spy: blocks the FIRST invocation of reserve() until
// explicitly released, while every invocation - including the eventually-
// released first one - still performs the REAL underlying Redis HSET
// (never mocked away). Mirrors cart-service-concurrency-test-helpers.ts's
// own helper of the same shape.
//
// Binds from the class PROTOTYPE, never from the instance's own (possibly
// already-spied) property: several tests in this file's siblings share one
// fixture/instance across multiple installDelayedReserveSpy calls without
// restoring between them (calling reconcileOne again mid-test needs the
// spy to stay live). jest.spyOn(instance, 'method') shadows via an own
// property, leaving the prototype method untouched - binding from the
// instance instead would capture a PRIOR test's still-installed spy as
// "real", producing unbounded mutual recursion (a real bug hit and fixed
// during this unit's own implementation).
export function installDelayedReserveSpy(
  inventoryReservations: InventoryReservationsService,
): DelayedCallHandle {
  const realReserve = InventoryReservationsService.prototype.reserve.bind(inventoryReservations);
  let callCount = 0;
  let release!: () => void;
  const staleCallStarted = new Promise<void>((resolveStarted) => {
    jest.spyOn(inventoryReservations, 'reserve').mockImplementation(async (productId, cartId, quantity) => {
      callCount += 1;
      if (callCount === 1) {
        resolveStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return realReserve(productId, cartId, quantity);
    });
  });
  return { staleCallStarted, releaseStaleCall: () => release() };
}

// Same prototype-binding rationale as installDelayedReserveSpy above.
export function installDelayedReleaseSpy(
  inventoryReservations: InventoryReservationsService,
): DelayedCallHandle {
  const realRelease = InventoryReservationsService.prototype.release.bind(inventoryReservations);
  let callCount = 0;
  let release!: () => void;
  const staleCallStarted = new Promise<void>((resolveStarted) => {
    jest.spyOn(inventoryReservations, 'release').mockImplementation(async (productId, cartId) => {
      callCount += 1;
      if (callCount === 1) {
        resolveStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return realRelease(productId, cartId);
    });
  });
  return { staleCallStarted, releaseStaleCall: () => release() };
}
