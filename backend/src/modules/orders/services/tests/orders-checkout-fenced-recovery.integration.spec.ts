import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import {
  CatalogueLifecycleStatus,
  CheckoutPath,
  FoodSafetyStatus,
  ListingLifecycleStatus,
  ListingPhotoModerationStatus,
  Prisma,
  ProductUnit,
  RoleName,
  SeafoodStorageType,
  WeightUnit,
} from '@prisma/client';
import { Redis } from 'ioredis';

import { PrismaService } from '../../../../database/prisma.service';
import { RedisService } from '../../../../common/redis/redis.service';
import { CheckoutAttemptRepository } from '../../../checkout-attempt/repositories/checkout-attempt.repository';
import {
  cartIndexKey,
  productIndexKey,
  productTotalKey,
  reservationKey,
} from '../../../inventory/constants/inventory.constants';
import { CheckoutReservationRecoveryService } from '../../../inventory/services/checkout-reservation-recovery.service';
import { InventoryReservationsService } from '../../../inventory/services/inventory-reservations.service';
import {
  connectRealRedis,
  cleanupKeys,
} from '../../../inventory/services/inventory-reservations.redis-test-helpers';
import {
  checkoutIds,
  getRawCheckoutFields,
} from '../../../inventory/services/checkout-reservation-state.redis-test-helpers';
import { SeafoodCheckoutRecoveryService } from '../seafood-checkout-recovery.service';

jest.setTimeout(60_000);

describe('Fenced Recovery and Delayed Checkout Race (real Postgres + real Redis)', () => {
  let prisma: PrismaService;
  let client: Redis;
  let redisService: RedisService;
  let attemptRepo: CheckoutAttemptRepository;
  let recoveryService: CheckoutReservationRecoveryService;
  let inventoryReservationsService: InventoryReservationsService;
  let seafoodRecoveryService: SeafoodCheckoutRecoveryService;

  const createdRedisKeys = new Set<string>();
  const createdDbIds = {
    userIds: new Set<string>(),
    vendorIds: new Set<string>(),
    categoryIds: new Set<string>(),
    catalogueItemIds: new Set<string>(),
    lotIds: new Set<string>(),
    productIds: new Set<string>(),
    listingIds: new Set<string>(),
    cartIds: new Set<string>(),
    orderIds: new Set<string>(),
    attemptIds: new Set<string>(),
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    client = await connectRealRedis();
    redisService = new RedisService(client);

    attemptRepo = new CheckoutAttemptRepository(prisma);
    recoveryService = new CheckoutReservationRecoveryService(redisService);
    inventoryReservationsService = new InventoryReservationsService(redisService);

    seafoodRecoveryService = new SeafoodCheckoutRecoveryService(
      attemptRepo,
      recoveryService,
      inventoryReservationsService,
      prisma,
    );
  });

  afterAll(async () => {
    // Teardown database in reverse dependency order
    for (const id of createdDbIds.attemptIds) {
      await prisma.checkoutAttempt.deleteMany({ where: { id } });
    }
    for (const orderId of createdDbIds.orderIds) {
      await prisma.inventoryEvent.deleteMany({ where: { vendorOrder: { orderId } } });
      await prisma.orderItem.deleteMany({ where: { vendorOrder: { orderId } } });
      await prisma.vendorOrder.deleteMany({ where: { orderId } });
      await prisma.order.deleteMany({ where: { id: orderId } });
    }
    for (const cartId of createdDbIds.cartIds) {
      await prisma.cartItem.deleteMany({ where: { cartId } });
      await prisma.cart.deleteMany({ where: { id: cartId } });
    }
    for (const id of createdDbIds.listingIds) {
      await prisma.listingPhoto.deleteMany({ where: { vendorDailyListingId: id } });
      await prisma.vendorDailyListing.deleteMany({ where: { id } });
    }
    for (const id of createdDbIds.productIds) {
      await prisma.product.deleteMany({ where: { id } });
    }
    for (const id of createdDbIds.lotIds) {
      await prisma.seafoodLot.deleteMany({ where: { id } });
    }
    for (const id of createdDbIds.catalogueItemIds) {
      await prisma.seafoodCatalogueItem.deleteMany({ where: { id } });
    }
    for (const id of createdDbIds.categoryIds) {
      await prisma.category.deleteMany({ where: { id } });
    }
    for (const id of createdDbIds.vendorIds) {
      await prisma.vendor.deleteMany({ where: { id } });
    }
    for (const id of createdDbIds.userIds) {
      await prisma.userRole.deleteMany({ where: { userId: id } });
      await prisma.user.deleteMany({ where: { id } });
    }

    await cleanupKeys(client, createdRedisKeys);
    await client.quit();
    await prisma.onModuleDestroy();
  });

  beforeEach(() => {
    createdRedisKeys.clear();
  });

  afterEach(async () => {
    await cleanupKeys(client, createdRedisKeys);
  });

  async function seedTestEnvironment() {
    const customerRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const vendorRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });

    const customerUser = await prisma.user.create({
      data: {
        email: `cust-${randomUUID()}@example.com`,
        passwordHash: 'hash',
        firstName: 'Cara',
        lastName: 'Customer',
        roles: { create: { roleId: customerRole.id } },
      },
    });
    createdDbIds.userIds.add(customerUser.id);

    const vendorUser = await prisma.user.create({
      data: {
        email: `vend-${randomUUID()}@example.com`,
        passwordHash: 'hash',
        firstName: 'Vera',
        lastName: 'Vendor',
        roles: { create: { roleId: vendorRole.id } },
      },
    });
    createdDbIds.userIds.add(vendorUser.id);

    const vendor = await prisma.vendor.create({
      data: {
        userId: vendorUser.id,
        businessName: `Test Vendor ${randomUUID()}`,
        parish: 'KINGSTON',
        termsAcceptedAt: new Date(),
        status: 'APPROVED',
      },
    });
    createdDbIds.vendorIds.add(vendor.id);

    const category = await prisma.category.create({
      data: {
        name: `Fish Category ${randomUUID()}`,
        slug: `fish-${randomUUID()}`,
      },
    });
    createdDbIds.categoryIds.add(category.id);

    const catalogueItem = await prisma.seafoodCatalogueItem.create({
      data: {
        name: `Snapper ${randomUUID()}`,
        commonName: 'Red Snapper',
        categoryId: category.id,
        lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
      },
    });
    createdDbIds.catalogueItemIds.add(catalogueItem.id);

    const lot = await prisma.seafoodLot.create({
      data: {
        lotNumber: `LOT-${randomUUID()}`,
        vendorId: vendor.id,
        species: 'Red Snapper',
        storageType: SeafoodStorageType.FRESH,
        catchDate: new Date(),
        weight: new Prisma.Decimal('100.00'),
        weightUnit: WeightUnit.POUNDS,
        foodSafetyStatus: FoodSafetyStatus.SAFE,
      },
    });
    createdDbIds.lotIds.add(lot.id);

    const product = await prisma.product.create({
      data: {
        vendorId: vendor.id,
        categoryId: category.id,
        lotId: lot.id,
        catalogueItemId: catalogueItem.id,
        name: `Snapper ${randomUUID()}`,
        description: 'Fresh snapper',
        unit: ProductUnit.PER_POUND,
        price: new Prisma.Decimal('25.00'),
        quantityAvailable: 100,
        imageUrl: 'https://example.com/s.jpg',
      },
    });
    createdDbIds.productIds.add(product.id);

    const cart = await prisma.cart.create({
      data: {
        customerId: customerUser.id,
      },
    });
    createdDbIds.cartIds.add(cart.id);

    const cartItem = await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId: product.id,
        quantity: 2,
      },
    });

    return { customerUser, vendorUser, vendor, category, catalogueItem, lot, product, cart, cartItem };
  }

  async function createRealOrder(customerId: string) {
    const order = await prisma.order.create({
      data: {
        customerId,
        deliveryAddressLine1: '123 Coastal Way',
        deliveryParish: 'KINGSTON',
        deliveryPhone: '+18765551234',
      },
    });
    createdDbIds.orderIds.add(order.id);
    return order;
  }

  async function seedPendingRedisReservation(
    cartId: string,
    productId: string,
    customerId: string,
    checkoutIdempotencyKey: string,
    quantity = 2,
  ) {
    const now = Date.now();
    const payload = JSON.stringify({
      version: 1,
      cartId,
      customerId,
      quantity,
      status: 'CHECKOUT_PENDING',
      createdAt: now - 30_000,
      lastRenewedAt: now - 30_000,
      expiresAt: now + 900_000,
      absoluteExpiresAt: now + 3_600_000,
      checkoutIdempotencyKey,
      checkoutPendingAt: now - 30_000,
      checkoutPendingExpiresAt: now + 150_000,
    });

    createdRedisKeys.add(reservationKey(cartId, productId));
    createdRedisKeys.add(cartIndexKey(cartId));
    createdRedisKeys.add(productIndexKey(productId));
    createdRedisKeys.add(productTotalKey(productId));

    await client.set(reservationKey(cartId, productId), payload);
    await client.sadd(cartIndexKey(cartId), productId);
    await client.sadd(productIndexKey(productId), cartId);
    await client.set(productTotalKey(productId), quantity.toString());
  }

  it('permanently blocks delayed checkout from committing after recovery fences the attempt and releases Redis', async () => {
    const env = await seedTestEnvironment();
    const idempotencyKey = `quote-${randomUUID()}`;

    // 1. Seed Redis reservation in CHECKOUT_PENDING
    await seedPendingRedisReservation(
      env.cart.id,
      env.product.id,
      env.customerUser.id,
      idempotencyKey,
      2,
    );

    // 2. Register attempt in PostgreSQL with stale heartbeat (240s ago, well past the 180s heartbeat window)
    const staleHeartbeat = new Date(Date.now() - 240_000);
    const { attempt } = await attemptRepo.createOrGetByIdempotencyKey({
      selectedPath: CheckoutPath.CART_SCOPED,
      idempotencyKey,
      cartId: env.cart.id,
      customerId: env.customerUser.id,
      now: staleHeartbeat,
    });
    createdDbIds.attemptIds.add(attempt.id);

    // 3. Recovery cycle runs: detects stale attempt, fences it in PostgreSQL, releases Redis reservation
    const cycleResult = await seafoodRecoveryService.runCycle();
    expect(cycleResult.fenced).toBe(1);

    // Verify PostgreSQL attempt state is now FAILED with fenceReason
    const fencedAttempt = await attemptRepo.findById(attempt.id);
    expect(fencedAttempt?.status).toBe('FAILED');
    expect(fencedAttempt?.failureCode).toBe('STALE_RECOVERY_FENCED');

    // Verify Redis reservation was released
    const fieldsAfterRecovery = await getRawCheckoutFields(client, env.cart.id, env.product.id);
    expect(fieldsAfterRecovery).toBeNull();

    // 4. Delayed checkout resumes and attempts to commit under transaction
    // markCommitted must return count === 0 and the checkout must abort
    await expect(
      prisma.$transaction(async (tx) => {
        const commitResult = await attemptRepo.markCommitted(
          tx,
          attempt.id,
          env.customerUser.id,
          `order-${randomUUID()}`,
          new Date(),
        );

        if (commitResult.count === 0) {
          throw new ConflictException(
            `Checkout attempt "${attempt.id}" was fenced or updated concurrently; cannot commit order.`,
          );
        }
      }),
    ).rejects.toThrow(ConflictException);

    // Verify attempt remains FAILED and was NOT committed
    const finalAttempt = await attemptRepo.findById(attempt.id);
    expect(finalAttempt?.status).toBe('FAILED');
    expect(finalAttempt?.orderId).toBeNull();
  });

  it('does NOT fence an attempt that committed before recovery, and safely finalizes Redis consumption', async () => {
    const env = await seedTestEnvironment();
    const idempotencyKey = `quote-${randomUUID()}`;

    // 1. Seed Redis reservation in CHECKOUT_PENDING
    await seedPendingRedisReservation(
      env.cart.id,
      env.product.id,
      env.customerUser.id,
      idempotencyKey,
      2,
    );

    // 2. Attempt was registered
    const staleHeartbeat = new Date(Date.now() - 240_000);
    const { attempt } = await attemptRepo.createOrGetByIdempotencyKey({
      selectedPath: CheckoutPath.CART_SCOPED,
      idempotencyKey,
      cartId: env.cart.id,
      customerId: env.customerUser.id,
      now: staleHeartbeat,
    });
    createdDbIds.attemptIds.add(attempt.id);

    // 3. Checkout completes and commits to PostgreSQL BEFORE recovery sweep
    const realOrder = await createRealOrder(env.customerUser.id);
    const commitResult = await prisma.$transaction((tx) =>
      attemptRepo.markCommitted(
        tx,
        attempt.id,
        env.customerUser.id,
        realOrder.id,
        new Date(),
      ),
    );
    expect(commitResult.count).toBe(1);

    // 4. Recovery sweep runs: sees COMMITTED status, finalizes Redis reservation without releasing
    const cycleResult = await seafoodRecoveryService.runCycle();
    expect(cycleResult.fenced).toBe(0);
    expect(cycleResult.finalized).toBe(1);

    // Attempt is intact as COMMITTED
    const verifiedAttempt = await attemptRepo.findById(attempt.id);
    expect(verifiedAttempt?.status).toBe('COMMITTED');
    expect(verifiedAttempt?.orderId).toBe(realOrder.id);
  });

  it('safely completes Redis consumption on crash recovery when PostgreSQL committed but Redis was not finalized', async () => {
    const env = await seedTestEnvironment();
    const idempotencyKey = `quote-${randomUUID()}`;

    // Seed Redis reservation in CHECKOUT_PENDING
    await seedPendingRedisReservation(
      env.cart.id,
      env.product.id,
      env.customerUser.id,
      idempotencyKey,
      2,
    );

    // Attempt was committed in PostgreSQL
    const { attempt } = await attemptRepo.createOrGetByIdempotencyKey({
      selectedPath: CheckoutPath.CART_SCOPED,
      idempotencyKey,
      cartId: env.cart.id,
      customerId: env.customerUser.id,
      now: new Date(Date.now() - 240_000),
    });
    createdDbIds.attemptIds.add(attempt.id);

    const realOrder = await createRealOrder(env.customerUser.id);
    await prisma.$transaction((tx) =>
      attemptRepo.markCommitted(
        tx,
        attempt.id,
        env.customerUser.id,
        realOrder.id,
        new Date(),
      ),
    );

    // Crash simulated: process terminated before post-commit Redis finalization
    // Redis key is still in CHECKOUT_PENDING
    const preRecoveryFields = await getRawCheckoutFields(client, env.cart.id, env.product.id);
    expect(preRecoveryFields?.status).toBe('CHECKOUT_PENDING');

    // Scheduled recovery cycle sweeps and finalizes Redis reservation
    const cycleResult = await seafoodRecoveryService.runCycle();
    expect(cycleResult.finalized).toBe(1);

    // Redis reservation was finalized (not orphaned or re-added to total stock)
    const postRecoveryFields = await getRawCheckoutFields(client, env.cart.id, env.product.id);
    expect(postRecoveryFields).toBeNull();
  });

  it('ensures concurrent recovery workers fence exactly once with no double release', async () => {
    const env = await seedTestEnvironment();
    const idempotencyKey = `quote-${randomUUID()}`;

    await seedPendingRedisReservation(
      env.cart.id,
      env.product.id,
      env.customerUser.id,
      idempotencyKey,
      2,
    );

    const { attempt } = await attemptRepo.createOrGetByIdempotencyKey({
      selectedPath: CheckoutPath.CART_SCOPED,
      idempotencyKey,
      cartId: env.cart.id,
      customerId: env.customerUser.id,
      now: new Date(Date.now() - 240_000),
    });
    createdDbIds.attemptIds.add(attempt.id);

    // Second recovery worker instance
    const secondRecoveryService = new SeafoodCheckoutRecoveryService(
      attemptRepo,
      recoveryService,
      inventoryReservationsService,
      prisma,
    );

    // Launch both sweeps concurrently
    const [result1, result2] = await Promise.all([
      seafoodRecoveryService.runCycle(),
      secondRecoveryService.runCycle(),
    ]);

    // Exactly 1 worker must fence it
    expect(result1.fenced + result2.fenced).toBe(1);
    expect(result1.errors + result2.errors).toBe(0);

    const finalAttempt = await attemptRepo.findById(attempt.id);
    expect(finalAttempt?.status).toBe('FAILED');
  });

  it('paginates over multiple stale attempts using cursor-based pagination', async () => {
    const env = await seedTestEnvironment();
    const staleTime = new Date(Date.now() - 250_000);

    // Seed 3 stale attempts
    for (let i = 0; i < 3; i++) {
      const { attempt } = await attemptRepo.createOrGetByIdempotencyKey({
        selectedPath: CheckoutPath.CART_SCOPED,
        idempotencyKey: `quote-page-${i}-${randomUUID()}`,
        cartId: env.cart.id,
        customerId: env.customerUser.id,
        now: new Date(staleTime.getTime() + i * 1000),
      });
      createdDbIds.attemptIds.add(attempt.id);
    }

    // Run recovery sweep
    const result = await seafoodRecoveryService.runCycle();
    expect(result.fenced).toBe(3);
    expect(result.errors).toBe(0);
  });

  it('1 & 2. discovers and releases Redis reservation when worker crashes after PostgreSQL FAILED commit before release', async () => {
    const env = await seedTestEnvironment();
    const idempotencyKey = `quote-${randomUUID()}`;

    // 1. Seed Redis reservation in CHECKOUT_PENDING
    await seedPendingRedisReservation(
      env.cart.id,
      env.product.id,
      env.customerUser.id,
      idempotencyKey,
      2,
    );

    // 2. Register attempt and simulate Worker 1 crashing after PostgreSQL fence commit before releaseCartHolds
    const staleHeartbeat = new Date(Date.now() - 240_000);
    const { attempt } = await attemptRepo.createOrGetByIdempotencyKey({
      selectedPath: CheckoutPath.CART_SCOPED,
      idempotencyKey,
      cartId: env.cart.id,
      customerId: env.customerUser.id,
      now: staleHeartbeat,
    });
    createdDbIds.attemptIds.add(attempt.id);

    // Worker 1 atomically fences to FAILED, but crashes immediately before releaseCartHolds
    const fenceResult = await attemptRepo.fenceStaleProcessing({
      attemptId: attempt.id,
      customerId: env.customerUser.id,
      selectedPath: CheckoutPath.CART_SCOPED,
      observedHeartbeatAt: staleHeartbeat,
      staleBefore: new Date(Date.now() - 180_000),
      now: new Date(),
    });
    expect(fenceResult.count).toBe(1);

    // Pre-recovery state: PostgreSQL status is FAILED, but Redis still holds CHECKOUT_PENDING
    const fencedAttempt = await attemptRepo.findById(attempt.id);
    expect(fencedAttempt?.status).toBe('FAILED');
    expect(fencedAttempt?.failureCode).toBe('STALE_RECOVERY_FENCED');
    const preRedis = await getRawCheckoutFields(client, env.cart.id, env.product.id);
    expect(preRedis?.status).toBe('CHECKOUT_PENDING');
    expect(await client.get(productTotalKey(env.product.id))).toBe('2');

    // Worker 2 runs recovery sweep
    const result = await seafoodRecoveryService.runCycle(new Date(), true);
    expect(result.cleanedFailed).toBe(1);

    // Post-recovery state: Redis reservation released and productTotalKey decremented to 0
    const postRedis = await getRawCheckoutFields(client, env.cart.id, env.product.id);
    expect(postRedis).toBeNull();
    expect(await client.get(productTotalKey(env.product.id))).toBe('0');
  });

  it('3. retries Redis release on subsequent cycle when initial release fails transiently', async () => {
    const env = await seedTestEnvironment();
    const idempotencyKey = `quote-${randomUUID()}`;

    await seedPendingRedisReservation(
      env.cart.id,
      env.product.id,
      env.customerUser.id,
      idempotencyKey,
      2,
    );

    const staleHeartbeat = new Date(Date.now() - 240_000);
    const { attempt } = await attemptRepo.createOrGetByIdempotencyKey({
      selectedPath: CheckoutPath.CART_SCOPED,
      idempotencyKey,
      cartId: env.cart.id,
      customerId: env.customerUser.id,
      now: staleHeartbeat,
    });
    createdDbIds.attemptIds.add(attempt.id);

    await attemptRepo.fenceStaleProcessing({
      attemptId: attempt.id,
      customerId: env.customerUser.id,
      selectedPath: CheckoutPath.CART_SCOPED,
      observedHeartbeatAt: staleHeartbeat,
      staleBefore: new Date(Date.now() - 180_000),
      now: new Date(),
    });

    // Mock transient Redis failure specifically for this cart on first cycle
    const releaseSpy = jest.spyOn(inventoryReservationsService, 'releaseReservation')
      .mockImplementation(async (cartId, productId) => {
        if (cartId === env.cart.id) {
          throw new Error('Transient Redis timeout');
        }
        return { released: false, quantity: 0, underflow: null };
      });

    // Cycle 1: encounters transient error for this cart, records error, hold remains uncleaned
    const result1 = await seafoodRecoveryService.runCycle(new Date(), true);
    expect(result1.errors).toBeGreaterThanOrEqual(1);
    expect(await client.get(productTotalKey(env.product.id))).toBe('2');

    releaseSpy.mockRestore();

    // Cycle 2: retries, succeeds, releases Redis hold
    const result2 = await seafoodRecoveryService.runCycle(new Date(), true);
    expect(result2.cleanedFailed).toBeGreaterThanOrEqual(1);
    expect(result2.errors).toBe(0);
    expect(await client.get(productTotalKey(env.product.id))).toBe('0');
  });

  it('4 & 5. concurrent recovery workers process FAILED attempt without double-decrementing total', async () => {
    const env = await seedTestEnvironment();
    const idempotencyKey = `quote-${randomUUID()}`;

    await seedPendingRedisReservation(
      env.cart.id,
      env.product.id,
      env.customerUser.id,
      idempotencyKey,
      3,
    );

    const staleHeartbeat = new Date(Date.now() - 240_000);
    const { attempt } = await attemptRepo.createOrGetByIdempotencyKey({
      selectedPath: CheckoutPath.CART_SCOPED,
      idempotencyKey,
      cartId: env.cart.id,
      customerId: env.customerUser.id,
      now: staleHeartbeat,
    });
    createdDbIds.attemptIds.add(attempt.id);

    await attemptRepo.fenceStaleProcessing({
      attemptId: attempt.id,
      customerId: env.customerUser.id,
      selectedPath: CheckoutPath.CART_SCOPED,
      observedHeartbeatAt: staleHeartbeat,
      staleBefore: new Date(Date.now() - 180_000),
      now: new Date(),
    });

    const secondWorker = new SeafoodCheckoutRecoveryService(
      attemptRepo,
      recoveryService,
      inventoryReservationsService,
      prisma,
    );

    // Launch concurrent runs
    const [res1, res2] = await Promise.all([
      seafoodRecoveryService.runCycle(new Date(), true),
      secondWorker.runCycle(new Date(), true),
    ]);

    expect(res1.errors + res2.errors).toBe(0);
    // Across both workers, total decrement must be exactly 3, leaving total = 0
    expect(await client.get(productTotalKey(env.product.id))).toBe('0');

    // Run repeated cleanup cycle: must not double-decrement or underflow
    const res3 = await seafoodRecoveryService.runCycle(new Date(), true);
    expect(res3.errors).toBe(0);
    expect(await client.get(productTotalKey(env.product.id))).toBe('0');
    expect(await client.get(`inv:reserved:product-total-suspect:{${env.product.id}}`)).toBeNull();
  });

  it('6. COMMITTED attempts are never released by the FAILED sweep', async () => {
    const env = await seedTestEnvironment();
    const idempotencyKey = `quote-${randomUUID()}`;

    await seedPendingRedisReservation(
      env.cart.id,
      env.product.id,
      env.customerUser.id,
      idempotencyKey,
      2,
    );

    const { attempt } = await attemptRepo.createOrGetByIdempotencyKey({
      selectedPath: CheckoutPath.CART_SCOPED,
      idempotencyKey,
      cartId: env.cart.id,
      customerId: env.customerUser.id,
      now: new Date(Date.now() - 240_000),
    });
    createdDbIds.attemptIds.add(attempt.id);

    const realOrder = await createRealOrder(env.customerUser.id);
    await prisma.$transaction((tx) =>
      attemptRepo.markCommitted(
        tx,
        attempt.id,
        env.customerUser.id,
        realOrder.id,
        new Date(),
      ),
    );

    const releaseSpy = jest.spyOn(inventoryReservationsService, 'releaseReservation');

    const result = await seafoodRecoveryService.runCycle(new Date(), true);

    // releaseReservation must NEVER have been called on the committed attempt's items
    expect(releaseSpy).not.toHaveBeenCalledWith(env.cart.id, env.product.id);
    expect(result.finalized).toBe(1);
    expect(result.cleanedFailed).toBe(0);

    releaseSpy.mockRestore();
  });

  it('7. expired reservation keys are handled safely without counter underflow', async () => {
    const env = await seedTestEnvironment();
    const idempotencyKey = `quote-${randomUUID()}`;

    // Seed Redis total but NO reservation key (simulating natural TTL eviction)
    createdRedisKeys.add(productTotalKey(env.product.id));
    await client.set(productTotalKey(env.product.id), '4');

    const staleHeartbeat = new Date(Date.now() - 240_000);
    const { attempt } = await attemptRepo.createOrGetByIdempotencyKey({
      selectedPath: CheckoutPath.CART_SCOPED,
      idempotencyKey,
      cartId: env.cart.id,
      customerId: env.customerUser.id,
      now: staleHeartbeat,
    });
    createdDbIds.attemptIds.add(attempt.id);

    await attemptRepo.fenceStaleProcessing({
      attemptId: attempt.id,
      customerId: env.customerUser.id,
      selectedPath: CheckoutPath.CART_SCOPED,
      observedHeartbeatAt: staleHeartbeat,
      staleBefore: new Date(Date.now() - 180_000),
      now: new Date(),
    });

    // FAILED sweep encounters missing key (raw == nil)
    const result = await seafoodRecoveryService.runCycle(new Date(), true);
    expect(result.errors).toBe(0);

    // Stored total must NOT underflow below 0 or be corrupted
    const finalTotal = await client.get(productTotalKey(env.product.id));
    expect(finalTotal).toBe('4'); // Unaltered because entry was missing; zero underflow
    expect(await client.get(`inv:reserved:product-total-suspect:{${env.product.id}}`)).toBeNull();
  });

  it('8. older unresolved FAILED attempts remain discoverable across recovery cycles', async () => {
    const env = await seedTestEnvironment();
    const idempotencyKey = `quote-${randomUUID()}`;

    await seedPendingRedisReservation(
      env.cart.id,
      env.product.id,
      env.customerUser.id,
      idempotencyKey,
      2,
    );

    // Heartbeat from 7 days ago (well beyond standard 24-hour window)
    const oldHeartbeat = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const { attempt } = await attemptRepo.createOrGetByIdempotencyKey({
      selectedPath: CheckoutPath.CART_SCOPED,
      idempotencyKey,
      cartId: env.cart.id,
      customerId: env.customerUser.id,
      now: oldHeartbeat,
    });
    createdDbIds.attemptIds.add(attempt.id);

    // Terminal fence committed in PostgreSQL
    await attemptRepo.fenceStaleProcessing({
      attemptId: attempt.id,
      customerId: env.customerUser.id,
      selectedPath: CheckoutPath.CART_SCOPED,
      observedHeartbeatAt: oldHeartbeat,
      staleBefore: new Date(Date.now() - 180_000),
      now: new Date(),
    });

    // FAILED sweep must discover and clean up even this older attempt without skipping it
    const result = await seafoodRecoveryService.runCycle(new Date(), true);
    expect(result.cleanedFailed).toBe(1);
    expect(result.errors).toBe(0);

    const postRedis = await getRawCheckoutFields(client, env.cart.id, env.product.id);
    expect(postRedis).toBeNull();
    expect(await client.get(productTotalKey(env.product.id))).toBe('0');
  });
});
