import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';
import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { connectRealRedis } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartRepository } from '../repositories/cart.repository';
import { CartService } from './cart.service';

// Shared plumbing for the real-Postgres + real-Redis DA.1A concurrency
// specs (Phase 16A.0-DA, Unit DA.1A, see the DA.1 architecture review's
// concurrency-proof correction - Review #2 specifically required that
// InventoryReservationsService never be mocked away for these races, since
// its reserve/release primitives are unconditioned HSET/HDEL and only a
// real client proves what actually lands in Redis). Dedicated Redis index -
// see the sibling checkout-coordinator/mirror-compensation integration
// specs' own comments for why 1-6 are already claimed.
export const CONCURRENCY_ISOLATED_DB_INDEX = 7;

export interface ConcurrencyFixture {
  redisClient: Redis;
  prisma: PrismaService;
  cartRepository: CartRepository;
  syncStateRepository: CartReservationSyncStateRepository;
  inventoryReservations: InventoryReservationsService;
  service: CartService;
  productId: string;
  customerId: string;
  vendorUserId: string;
  category: Category;
}

export async function setUpConcurrencyFixture(namePrefix: string): Promise<ConcurrencyFixture> {
  const redisClient = await connectRealRedis();
  await redisClient.select(CONCURRENCY_ISOLATED_DB_INDEX);
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
    lastName: 'Race',
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
  // Vendor.status defaults to PENDING in the schema - approve explicitly so
  // assertProductIsPurchasable's vendor-approval check passes.
  await prisma.vendor.update({ where: { id: vendor.id }, data: { status: 'APPROVED' } });

  const category = await categoriesRepository.create({
    name: `${namePrefix} Category ${randomUUID()}`,
    slug: `${namePrefix}-category-${randomUUID()}`,
  });
  const product = await productsRepository.create({
    vendorId: vendor.id,
    categoryId: category.id,
    name: `${namePrefix} Snapper`,
    description: 'A product used only for a real-Redis DA.1A concurrency race test.',
    unit: 'PER_POUND',
    price: 500,
    quantityAvailable: 50,
    imageUrl: 'https://cdn.example.com/snapper.jpg',
  });

  const service = new CartService(
    prisma,
    cartRepository,
    productsRepository,
    vendorsRepository,
    inventoryReservations,
    syncStateRepository,
  );

  return {
    redisClient,
    prisma,
    cartRepository,
    syncStateRepository,
    inventoryReservations,
    service,
    productId: product.id,
    customerId: customer.id,
    vendorUserId: vendorUser.id,
    category,
  };
}

export async function tearDownConcurrencyFixture(fixture: ConcurrencyFixture): Promise<void> {
  // CartReservationSyncState rows are never deleted by DA.1A itself
  // (generation must be permanent) and use onDelete: Restrict on their Cart
  // relation, so they must be cleared explicitly before the owning
  // user/cart can be deleted.
  await fixture.prisma.cartReservationSyncState.deleteMany({ where: { productId: fixture.productId } });
  await fixture.prisma.user.delete({ where: { id: fixture.customerId } });
  await fixture.prisma.user.delete({ where: { id: fixture.vendorUserId } });
  await fixture.prisma.category.delete({ where: { id: fixture.category.id } });
  await fixture.prisma.onModuleDestroy();
  await fixture.redisClient.flushdb();
  await fixture.redisClient.quit();
}

export interface DelayedCallHandle {
  staleCallStarted: Promise<void>;
  releaseStaleCall: () => void;
}

// Call-through spy: blocks the FIRST invocation of reserve() until
// explicitly released, while every invocation - including the eventually-
// released first one - still performs the REAL underlying Redis HSET
// (never mocked away, per Review #2's explicit requirement). Mirrors
// installDelayedReleaseSpy below for the HDEL path.
export function installDelayedReserveSpy(
  inventoryReservations: InventoryReservationsService,
): DelayedCallHandle {
  const realReserve = inventoryReservations.reserve.bind(inventoryReservations);
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

export function installDelayedReleaseSpy(
  inventoryReservations: InventoryReservationsService,
): DelayedCallHandle {
  const realRelease = inventoryReservations.release.bind(inventoryReservations);
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
