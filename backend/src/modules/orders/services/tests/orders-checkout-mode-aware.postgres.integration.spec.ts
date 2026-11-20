import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import {
  CatalogueLifecycleStatus,
  CheckoutPath,
  FoodSafetyStatus,
  ListingLifecycleStatus,
  Prisma,
  ProductUnit,
  ReservationEngineMode,
  RoleName,
  SeafoodPricingBasis,
  SeafoodStorageType,
  UsablePartsPreference,
  WeightUnit,
} from '@prisma/client';
import { Redis } from 'ioredis';

import { REDIS_CLIENT } from '../../../../common/redis/redis.constants';
import { RedisModule } from '../../../../common/redis/redis.module';
import { validateEnv } from '../../../../config/env.validation';
import { PrismaModule } from '../../../../database/prisma.module';
import { PrismaService } from '../../../../database/prisma.service';
import { CartMutationBarrierModule } from '../../../cart-mutation-barrier/cart-mutation-barrier.module';
import { CartMutationBarrierService } from '../../../cart-mutation-barrier/services/cart-mutation-barrier.service';
import { CartModule } from '../../../cart/cart.module';
import { CartService } from '../../../cart/services/cart.service';
import {
  cartIndexKey,
  productIndexKey,
  productTotalKey,
  reservationHashKey,
  reservationKey,
} from '../../../inventory/constants/inventory.constants';
import { InventoryModule } from '../../../inventory/inventory.module';
import { InventoryReservationsService } from '../../../inventory/services/inventory-reservations.service';
import { connectRealRedis } from '../../../inventory/services/inventory-reservations.redis-test-helpers';
import { PaymentsModule } from '../../../payments/payments.module';
import { CashOnDeliveryAdapter } from '../../../payments/providers/cash-on-delivery.adapter';
import { ProductsModule } from '../../../products/products.module';
import { ReservationEngineModeModule } from '../../../reservation-engine-mode/reservation-engine-mode.module';
import { ReservationEngineModeService } from '../../../reservation-engine-mode/services/reservation-engine-mode.service';
import { RESERVATION_FENCE_KEY } from '../../../reservation-fence/lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY } from '../../../reservation-fence/lua/reservation-mutation-common.lua';
import { transitionTuple } from '../../../reservation-fence/repositories/reservation-fence.repository';
import { VendorsModule } from '../../../vendors/vendors.module';
import { CheckoutDto } from '../../dto/checkout.dto';
import { OrdersModule } from '../../orders.module';
import { issueQuoteToken } from '../checkout-quote.service';
import { OrdersService } from '../orders.service';

jest.setTimeout(60_000);

const ISOLATED_REDIS_DB_INDEX = 8;

const BASE_CHECKOUT_DTO: CheckoutDto = {
  deliveryAddressLine1: '18 Harbour View Way',
  deliveryParish: 'KINGSTON',
  deliveryPhone: '+18765550199',
  paymentMethod: 'CASH_ON_DELIVERY',
};

describe('OrdersService Mode-Aware Checkout (real Postgres + real Redis + Nest DI)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let redisClient: Redis;
  let ordersService: OrdersService;
  let cartService: CartService;
  let modeService: ReservationEngineModeService;
  let inventoryReservations: InventoryReservationsService;
  let mutationBarrier: CartMutationBarrierService;
  let cashOnDeliveryAdapter: CashOnDeliveryAdapter;

  let adminUserId: string;
  let vendorAUserId: string;
  let vendorAId: string;
  let vendorBUserId: string;
  let vendorBId: string;
  let categoryId: string;

  async function ensureRole(name: RoleName): Promise<string> {
    const role = await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
    return role.id;
  }

  async function createCustomer(): Promise<{ id: string; cartId: string }> {
    const roleId = await ensureRole(RoleName.CUSTOMER);
    const user = await prisma.user.create({
      data: {
        email: `mode-cust-${randomUUID()}@example.com`,
        passwordHash: 'hash',
        firstName: 'Mara',
        lastName: 'Customer',
        status: 'ACTIVE',
        roles: { create: [{ roleId }] },
      },
    });
    const cart = await prisma.cart.create({ data: { customerId: user.id } });
    return { id: user.id, cartId: cart.id };
  }

  async function createProduct(
    vendorId: string,
    opts: { price?: number; stock?: number; seafood?: boolean } = {},
  ) {
    const price = opts.price ?? 500;
    const stock = opts.stock ?? 20;
    return prisma.product.create({
      data: {
        vendorId,
        categoryId,
        name: `Snapper ${randomUUID()}`,
        description: 'Mode-aware integration test item',
        unit: ProductUnit.PER_POUND,
        price: new Prisma.Decimal(price),
        quantityAvailable: stock,
        imageUrl: 'https://cdn.example.com/snapper.jpg',
        isActive: true,
      },
    });
  }

  async function forceModeReset(mode: ReservationEngineMode): Promise<void> {
    const config = await prisma.reservationEngineModeConfig.create({
      data: { mode, updatedById: adminUserId },
    });
    if (mode === ReservationEngineMode.CART_SCOPED || mode === ReservationEngineMode.DRAINING) {
      await syncOpenFenceForMode(config.mode, config.revision);
    } else {
      await redisClient.del(RESERVATION_FENCE_KEY, MUTATION_HISTORY_KEY);
    }
  }

  async function syncOpenFenceForMode(
    mode: ReservationEngineMode,
    modeRevision: number,
  ): Promise<void> {
    const maxFence = await prisma.reservationFenceTransition.findFirst({
      orderBy: { revision: 'desc' },
      select: { revision: true },
    });
    const nextRevision = (maxFence?.revision ?? 0) + 1;
    const fence = await prisma.reservationFenceTransition.create({
      data: {
        incarnation: randomUUID(),
        epoch: 1,
        revision: nextRevision,
        phase: mode === ReservationEngineMode.DRAINING ? 'DRAINING' : 'OPEN',
        protocol: 1,
        status: 'ACKNOWLEDGED',
        acknowledgedAt: new Date(),
        mode,
        modeRevision,
        reason: mode === ReservationEngineMode.DRAINING ? 'RESTRICT' : 'OPEN',
        actorId: adminUserId,
      },
    });
    await redisClient.set(RESERVATION_FENCE_KEY, JSON.stringify(transitionTuple(fence)));
    await redisClient.hset(MUTATION_HISTORY_KEY, 'incarnation', fence.incarnation);
  }

  async function seedCartScopedReservationDirect(
    cartId: string,
    productId: string,
    customerId: string,
    quantity: number,
    overrides: Partial<{ expiresAt: number; absoluteExpiresAt: number }> = {},
  ): Promise<void> {
    const now = Date.now();
    const payload = JSON.stringify({
      version: 1,
      cartId,
      productId,
      customerId,
      quantity,
      status: 'ACTIVE',
      createdAt: now - 10_000,
      lastRenewedAt: now - 10_000,
      expiresAt: overrides.expiresAt ?? now + 600_000,
      absoluteExpiresAt: overrides.absoluteExpiresAt ?? now + 3_600_000,
    });
    await redisClient.set(reservationKey(cartId, productId), payload);
    await redisClient.sadd(cartIndexKey(cartId), productId);
    await redisClient.sadd(productIndexKey(productId), cartId);
    await redisClient.incrby(productTotalKey(productId), quantity);
  }

  beforeAll(async () => {
    redisClient = await connectRealRedis();
    await redisClient.select(ISOLATED_REDIS_DB_INDEX);
    await redisClient.flushdb();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        PrismaModule,
        EventEmitterModule.forRoot(),
        RedisModule,
        OrdersModule,
        CartModule,
        ReservationEngineModeModule,
        InventoryModule,
        CartMutationBarrierModule,
        PaymentsModule,
        ProductsModule,
        VendorsModule,
      ],
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue(redisClient)
      .compile();

    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    ordersService = moduleRef.get(OrdersService);
    cartService = moduleRef.get(CartService);
    modeService = moduleRef.get(ReservationEngineModeService);
    inventoryReservations = moduleRef.get(InventoryReservationsService);
    mutationBarrier = moduleRef.get(CartMutationBarrierService);
    cashOnDeliveryAdapter = moduleRef.get(CashOnDeliveryAdapter);

    const adminRoleId = await ensureRole(RoleName.ADMINISTRATOR);
    const vendorRoleId = await ensureRole(RoleName.VENDOR);

    const admin = await prisma.user.create({
      data: {
        email: `mode-admin-${randomUUID()}@example.com`,
        passwordHash: 'hash',
        firstName: 'Ada',
        lastName: 'Min',
        status: 'ACTIVE',
        roles: { create: [{ roleId: adminRoleId }] },
      },
    });
    adminUserId = admin.id;

    const vUserA = await prisma.user.create({
      data: {
        email: `mode-va-${randomUUID()}@example.com`,
        passwordHash: 'hash',
        firstName: 'Victor',
        lastName: 'Alpha',
        status: 'ACTIVE',
        roles: { create: [{ roleId: vendorRoleId }] },
      },
    });
    vendorAUserId = vUserA.id;
    const vendorA = await prisma.vendor.create({
      data: {
        userId: vendorAUserId,
        businessName: `Vendor Alpha ${randomUUID()}`,
        parish: 'KINGSTON',
        termsAcceptedAt: new Date(),
        status: 'APPROVED',
      },
    });
    vendorAId = vendorA.id;

    const vUserB = await prisma.user.create({
      data: {
        email: `mode-vb-${randomUUID()}@example.com`,
        passwordHash: 'hash',
        firstName: 'Vivian',
        lastName: 'Beta',
        status: 'ACTIVE',
        roles: { create: [{ roleId: vendorRoleId }] },
      },
    });
    vendorBUserId = vUserB.id;
    const vendorB = await prisma.vendor.create({
      data: {
        userId: vendorBUserId,
        businessName: `Vendor Beta ${randomUUID()}`,
        parish: 'ST_ANDREW',
        termsAcceptedAt: new Date(),
        status: 'APPROVED',
      },
    });
    vendorBId = vendorB.id;

    const category = await prisma.category.create({
      data: {
        name: `Mode Seafood ${randomUUID()}`,
        slug: `mode-seafood-${randomUUID()}`,
      },
    });
    categoryId = category.id;
  });

  afterEach(async () => {
    await redisClient.flushdb();
    await mutationBarrier.deactivate(adminUserId).catch(() => undefined);
    await forceModeReset(ReservationEngineMode.LEGACY);
  });

  afterAll(async () => {
    await redisClient.flushdb();
    await moduleRef.close();
  });

  it('1. LEGACY mode: executes legacy checkout, records CheckoutPath.LEGACY, skips C3 mark/finalize, and supports sequential subsequent orders', async () => {
    await forceModeReset(ReservationEngineMode.LEGACY);
    const { id: customerId, cartId } = await createCustomer();
    const prod1 = await createProduct(vendorAId, { stock: 12, price: 450 });
    const prod2 = await createProduct(vendorAId, { stock: 10, price: 300 });

    await cartService.addItem(customerId, { productId: prod1.id, quantity: 3 }, randomUUID());
    const legHold1 = JSON.parse((await redisClient.hget(reservationHashKey(prod1.id), cartId))!);
    expect(legHold1.quantity).toBe(3);
    expect(await redisClient.get(productTotalKey(prod1.id))).toBeNull();

    const stateSvc = Reflect.get(ordersService as object, 'checkoutReservationState');
    const recSvc = Reflect.get(ordersService as object, 'checkoutReservationRecovery');
    const markSpy = jest.spyOn(stateSvc, 'checkoutMark');
    const finalizeSpy = jest.spyOn(recSvc, 'finalizeCheckoutConsumption');

    try {
      const order1 = await ordersService.checkout(customerId, BASE_CHECKOUT_DTO);

      expect(order1.id).toBeDefined();
      expect(markSpy).not.toHaveBeenCalled();
      expect(finalizeSpy).not.toHaveBeenCalled();

      const p1After = await prisma.product.findUniqueOrThrow({ where: { id: prod1.id } });
      expect(p1After.quantityAvailable).toBe(9);
      expect(await redisClient.hget(reservationHashKey(prod1.id), cartId)).toBeNull();

      const attempts1 = await prisma.checkoutAttempt.findMany({ where: { cartId } });
      expect(attempts1).toHaveLength(1);
      expect(attempts1[0]).toMatchObject({
        selectedPath: CheckoutPath.LEGACY,
        status: 'COMMITTED',
        orderId: order1.id,
      });

      // Sequential second non-seafood order on the same cleared Cart creates a distinct Order 2
      await cartService.addItem(customerId, { productId: prod2.id, quantity: 2 }, randomUUID());
      const order2 = await ordersService.checkout(customerId, BASE_CHECKOUT_DTO);

      expect(order2.id).toBeDefined();
      expect(order2.id).not.toBe(order1.id);
      const p2After = await prisma.product.findUniqueOrThrow({ where: { id: prod2.id } });
      expect(p2After.quantityAvailable).toBe(8);

      const attempts2 = await prisma.checkoutAttempt.findMany({
        where: { cartId },
        orderBy: { createdAt: 'asc' },
      });
      expect(attempts2).toHaveLength(2);
      expect(attempts2.every((a) => a.selectedPath === CheckoutPath.LEGACY && a.status === 'COMMITTED')).toBe(true);
    } finally {
      markSpy.mockRestore();
      finalizeSpy.mockRestore();
    }
  });

  it('2. MIRROR mode: executes legacy authoritative checkout (CheckoutPath.LEGACY), skips C3 mark/finalize, and releases both legacy & C3 mirror holds', async () => {
    const mirrorTransition = await modeService.setMode({
      targetMode: ReservationEngineMode.MIRROR,
      updatedById: adminUserId,
    });
    expect(mirrorTransition.ok).toBe(true);

    const { id: customerId, cartId } = await createCustomer();
    const product = await createProduct(vendorAId, { stock: 15, price: 600 });

    await cartService.addItem(customerId, { productId: product.id, quantity: 4 }, randomUUID());
    const mirHold = JSON.parse((await redisClient.hget(reservationHashKey(product.id), cartId))!);
    expect(mirHold.quantity).toBe(4);
    if ((await redisClient.get(productTotalKey(product.id))) === null) {
      await seedCartScopedReservationDirect(cartId, product.id, customerId, 4);
    }
    expect(await redisClient.get(productTotalKey(product.id))).toBe('4');

    const stateSvc = Reflect.get(ordersService as object, 'checkoutReservationState');
    const markSpy = jest.spyOn(stateSvc, 'checkoutMark');
    try {
      const order = await ordersService.checkout(customerId, BASE_CHECKOUT_DTO);

      expect(order.id).toBeDefined();
      expect(markSpy).not.toHaveBeenCalled();

      const updatedProd = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(updatedProd.quantityAvailable).toBe(11);
      expect(await redisClient.hget(reservationHashKey(product.id), cartId)).toBeNull();
      expect(await redisClient.get(reservationKey(cartId, product.id))).toBeNull();
      expect(await redisClient.get(productTotalKey(product.id))).toBe('0');

      const attempt = await prisma.checkoutAttempt.findFirstOrThrow({
        where: { orderId: order.id },
      });
      expect(attempt.selectedPath).toBe(CheckoutPath.LEGACY);
      expect(attempt.status).toBe('COMMITTED');
    } finally {
      markSpy.mockRestore();
    }
  });

  it('3. MIRROR mode resilience: missing/diverged or throwing C3 mirror release never blocks or corrupts legacy checkout', async () => {
    await modeService.setMode({
      targetMode: ReservationEngineMode.MIRROR,
      updatedById: adminUserId,
    });

    const { id: customerId, cartId } = await createCustomer();
    const product = await createProduct(vendorAId, { stock: 10, price: 400 });

    await cartService.addItem(customerId, { productId: product.id, quantity: 2 }, randomUUID());
    // Simulate diverged/missing C3 mirror key AND throwing mirror cleanup
    await redisClient.del(reservationKey(cartId, product.id), productTotalKey(product.id));
    await redisClient.srem(cartIndexKey(cartId), product.id);
    const mirrorReleaseSpy = jest
      .spyOn(inventoryReservations, 'releaseReservation')
      .mockRejectedValueOnce(new Error('Simulated Redis mirror failure'));

    try {
      const order = await ordersService.checkout(customerId, BASE_CHECKOUT_DTO);

      expect(order.id).toBeDefined();
      const prodAfter = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(prodAfter.quantityAvailable).toBe(8);
      expect(await redisClient.hget(reservationHashKey(product.id), cartId)).toBeNull();

      const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(payment.amount.toFixed(2)).toBe('800.00');
      const attempt = await prisma.checkoutAttempt.findFirstOrThrow({ where: { orderId: order.id } });
      expect(attempt.selectedPath).toBe(CheckoutPath.LEGACY);
      expect(attempt.status).toBe('COMMITTED');
    } finally {
      mirrorReleaseSpy.mockRestore();
    }
  });

  it('4. CART_SCOPED mode: happy-path checkout enforces checkoutMark, records CheckoutPath.CART_SCOPED, commits order, and consumes C3 hold', async () => {
    await forceModeReset(ReservationEngineMode.CART_SCOPED);
    const { id: customerId, cartId } = await createCustomer();
    const product = await createProduct(vendorAId, { stock: 10, price: 750 });

    await prisma.cartItem.create({
      data: { cartId, productId: product.id, quantity: 3, mutationVersion: 1 },
    });
    await seedCartScopedReservationDirect(cartId, product.id, customerId, 3);
    expect(await redisClient.get(productTotalKey(product.id))).toBe('3');

    const stateSvc = Reflect.get(ordersService as object, 'checkoutReservationState');
    const markSpy = jest.spyOn(stateSvc, 'checkoutMark');

    try {
      const order = await ordersService.checkout(customerId, BASE_CHECKOUT_DTO);

      expect(order.id).toBeDefined();
      expect(markSpy).toHaveBeenCalledTimes(1);

      const prodAfter = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(prodAfter.quantityAvailable).toBe(7);
      expect(await redisClient.get(reservationKey(cartId, product.id))).toBeNull();
      expect(await redisClient.get(productTotalKey(product.id))).toBe('0');

      const attempt = await prisma.checkoutAttempt.findFirstOrThrow({ where: { orderId: order.id } });
      expect(attempt.selectedPath).toBe(CheckoutPath.CART_SCOPED);
      expect(attempt.status).toBe('COMMITTED');
    } finally {
      markSpy.mockRestore();
    }
  });

  it('5. CART_SCOPED mode: rejects checkout with missing or mismatched C3 reservation and never falls back to legacy', async () => {
    await forceModeReset(ReservationEngineMode.CART_SCOPED);
    const { id: customerId, cartId } = await createCustomer();
    const product = await createProduct(vendorAId, { stock: 10, price: 500 });

    await prisma.cartItem.create({
      data: { cartId, productId: product.id, quantity: 3, mutationVersion: 1 },
    });
    // Legacy-only hold (or wrong C3 qty) must NOT satisfy CART_SCOPED admission
    await inventoryReservations.reserve(product.id, cartId, 3);
    await seedCartScopedReservationDirect(cartId, product.id, customerId, 1);

    await expect(ordersService.checkout(customerId, BASE_CHECKOUT_DTO)).rejects.toThrow(
      ConflictException,
    );

    const prodAfter = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(prodAfter.quantityAvailable).toBe(10);
    expect(await prisma.order.count({ where: { customerId } })).toBe(0);

    const failedAttempt = await prisma.checkoutAttempt.findFirstOrThrow({ where: { cartId } });
    expect(failedAttempt.selectedPath).toBe(CheckoutPath.CART_SCOPED);
    expect(failedAttempt.status).toBe('FAILED');
  });

  it('6. CART_SCOPED mode: rejects checkout with an expired C3 reservation cleanly', async () => {
    await forceModeReset(ReservationEngineMode.CART_SCOPED);
    const { id: customerId, cartId } = await createCustomer();
    const product = await createProduct(vendorAId, { stock: 10, price: 500 });

    await prisma.cartItem.create({
      data: { cartId, productId: product.id, quantity: 2, mutationVersion: 1 },
    });
    await seedCartScopedReservationDirect(cartId, product.id, customerId, 2, {
      expiresAt: Date.now() - 5_000,
    });

    await expect(ordersService.checkout(customerId, BASE_CHECKOUT_DTO)).rejects.toThrow(
      ConflictException,
    );

    const prodAfter = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(prodAfter.quantityAvailable).toBe(10);
    expect(await prisma.order.count({ where: { customerId } })).toBe(0);

    const failedAttempt = await prisma.checkoutAttempt.findFirstOrThrow({ where: { cartId } });
    expect(failedAttempt.selectedPath).toBe(CheckoutPath.CART_SCOPED);
    expect(failedAttempt.status).toBe('FAILED');
  });

  it('7. Duplicate checkout idempotency: post-clear quoteToken replay returns existing committed order and preserves selectedPath', async () => {
    await forceModeReset(ReservationEngineMode.LEGACY);
    const { id: customerId, cartId } = await createCustomer();

    const cat = await prisma.seafoodCatalogueItem.create({
      data: {
        name: `Red Snapper ${randomUUID()}`,
        commonName: 'Red Snapper',
        categoryId,
        lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
      },
    });
    const lot = await prisma.seafoodLot.create({
      data: {
        lotNumber: `LOT-${randomUUID()}`,
        vendorId: vendorAId,
        species: 'Red Snapper',
        storageType: SeafoodStorageType.FRESH,
        catchDate: new Date(),
        weight: new Prisma.Decimal('20.00'),
        weightUnit: WeightUnit.POUNDS,
        foodSafetyStatus: FoodSafetyStatus.SAFE,
      },
    });
    const product = await prisma.product.create({
      data: {
        vendorId: vendorAId,
        categoryId,
        lotId: lot.id,
        catalogueItemId: cat.id,
        name: `Seafood Snapper ${randomUUID()}`,
        description: 'Whole fresh snapper',
        unit: ProductUnit.PER_POUND,
        price: new Prisma.Decimal('1000.00'),
        quantityAvailable: 10,
        imageUrl: 'https://cdn.example.com/fish.jpg',
        isActive: true,
      },
    });
    const listing = await prisma.vendorDailyListing.create({
      data: {
        vendorId: vendorAId,
        lotId: lot.id,
        productId: product.id,
        catalogueItemId: cat.id,
        listingTitle: product.name,
        description: 'Today fresh catch',
        catchDate: new Date(),
        quantityUploaded: new Prisma.Decimal('10.00'),
        quantityAvailable: new Prisma.Decimal('10.00'),
        price: new Prisma.Decimal('1000.00'),
        unit: ProductUnit.PER_POUND,
        status: ListingLifecycleStatus.PUBLISHED,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const cartItem = await prisma.cartItem.create({
      data: { cartId, productId: product.id, quantity: 2, mutationVersion: 1 },
    });
    await inventoryReservations.reserve(product.id, cartId, 2);

    const quoteService = Reflect.get(ordersService as object, 'checkoutQuoteService');
    const cartRevisionHash = quoteService.computeCartRevisionHash([
      {
        id: cartItem.id,
        productId: product.id,
        quantity: 2,
        mutationVersion: 1,
      },
    ]);
    const quoteId = randomUUID();
    const quoteToken = issueQuoteToken(
      {
        quoteId,
        authenticatedCustomerId: customerId,
        cartId,
        cartRevisionHash,
        items: [
          {
            cartItemId: cartItem.id,
            productId: product.id,
            mutationVersion: 1,
            listingId: listing.id,
            lotId: lot.id,
            vendorId: vendorAId,
            species: 'Red Snapper',
            productTitle: product.name,
            unit: ProductUnit.PER_POUND,
            unitPrice: '1000.00',
            currency: 'JMD',
            pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
            pieceCount: 2,
            estimatedBillableWeight: 2,
            weightUnit: WeightUnit.POUNDS,
            usablePartsPreference: UsablePartsPreference.DO_NOT_RETURN_USABLE_PARTS,
            estimatedProductSubtotal: '2000.00',
            estimatedPreparationFee: '0.00',
            estimatedItemTotal: '2000.00',
            minimumAuthorizedCeilingJmd: '2200.00',
            customerAuthorizedCeilingJmd: '2200.00',
          },
        ],
        termsVersion: '2026-v1',
      },
      process.env.CHECKOUT_QUOTE_SIGNING_SECRET!,
    );

    const order1 = await ordersService.checkout(customerId, {
      ...BASE_CHECKOUT_DTO,
      quoteToken,
    });
    // Replay the exact same quoteToken after cart items were cleared
    const order2 = await ordersService.checkout(customerId, {
      ...BASE_CHECKOUT_DTO,
      quoteToken,
    });

    expect(order2.id).toBe(order1.id);
    expect(await prisma.order.count({ where: { customerId } })).toBe(1);
    const prodAfter = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(prodAfter.quantityAvailable).toBe(8);
    const attempt = await prisma.checkoutAttempt.findUniqueOrThrow({
      where: { idempotencyKey: quoteId },
    });
    expect(attempt.selectedPath).toBe(CheckoutPath.LEGACY);
    expect(attempt.status).toBe('COMMITTED');
  });

  it('8. Concurrent duplicate checkout in LEGACY and CART_SCOPED creates exactly one order and never double-decrements stock', async () => {
    // Part A: LEGACY concurrency
    await forceModeReset(ReservationEngineMode.LEGACY);
    const legCust = await createCustomer();
    const legProd = await createProduct(vendorAId, { stock: 10, price: 500 });
    await cartService.addItem(legCust.id, { productId: legProd.id, quantity: 3 }, randomUUID());

    const legResults = await Promise.allSettled([
      ordersService.checkout(legCust.id, BASE_CHECKOUT_DTO),
      ordersService.checkout(legCust.id, BASE_CHECKOUT_DTO),
    ]);
    const legFulfilled = legResults.filter((r) => r.status === 'fulfilled');
    const legRejected = legResults.filter((r) => r.status === 'rejected');
    expect(legFulfilled.length).toBeGreaterThanOrEqual(1);
    expect(await prisma.order.count({ where: { customerId: legCust.id } })).toBe(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: legProd.id } })).quantityAvailable).toBe(7);
    if (legRejected.length > 0) {
      const reason = (legRejected[0] as PromiseRejectedResult).reason;
      expect(reason instanceof ConflictException || reason instanceof BadRequestException).toBe(true);
    }

    // Part B: CART_SCOPED concurrency
    await forceModeReset(ReservationEngineMode.CART_SCOPED);
    const csCust = await createCustomer();
    const csProd = await createProduct(vendorAId, { stock: 10, price: 500 });
    await prisma.cartItem.create({
      data: { cartId: csCust.cartId, productId: csProd.id, quantity: 4, mutationVersion: 1 },
    });
    await seedCartScopedReservationDirect(csCust.cartId, csProd.id, csCust.id, 4);

    const csResults = await Promise.allSettled([
      ordersService.checkout(csCust.id, BASE_CHECKOUT_DTO),
      ordersService.checkout(csCust.id, BASE_CHECKOUT_DTO),
    ]);
    expect(csResults.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(await prisma.order.count({ where: { customerId: csCust.id } })).toBe(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: csProd.id } })).quantityAvailable).toBe(6);
    const csAttempt = await prisma.checkoutAttempt.findFirstOrThrow({ where: { cartId: csCust.cartId } });
    expect(csAttempt.selectedPath).toBe(CheckoutPath.CART_SCOPED);
    expect(csAttempt.status).toBe('COMMITTED');
  });

  it('9. Insufficient inventory during checkout rejects without partial order or stock mutation', async () => {
    await forceModeReset(ReservationEngineMode.LEGACY);
    const { id: customerId, cartId } = await createCustomer();
    const product = await createProduct(vendorAId, { stock: 5, price: 300 });

    await cartService.addItem(customerId, { productId: product.id, quantity: 4 }, randomUUID());
    await prisma.product.update({ where: { id: product.id }, data: { quantityAvailable: 2 } });

    await expect(ordersService.checkout(customerId, BASE_CHECKOUT_DTO)).rejects.toThrow(
      ConflictException,
    );

    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).quantityAvailable).toBe(2);
    expect(await prisma.order.count({ where: { customerId } })).toBe(0);
    expect(await prisma.cartItem.count({ where: { cartId } })).toBe(1);
    const failedAttempt = await prisma.checkoutAttempt.findFirstOrThrow({ where: { cartId } });
    expect(failedAttempt.selectedPath).toBe(CheckoutPath.LEGACY);
    expect(failedAttempt.status).toBe('FAILED');
  });

  it('10. Multi-vendor checkout succeeds with separate VendorOrders across LEGACY, MIRROR, and CART_SCOPED', async () => {
    for (const mode of [
      ReservationEngineMode.LEGACY,
      ReservationEngineMode.MIRROR,
      ReservationEngineMode.CART_SCOPED,
    ]) {
      await forceModeReset(mode);
      const { id: customerId, cartId } = await createCustomer();
      const pA = await createProduct(vendorAId, { stock: 10, price: 400 });
      const pB = await createProduct(vendorBId, { stock: 10, price: 250 });

      await cartService.addItem(customerId, { productId: pA.id, quantity: 2 }, randomUUID());
      await cartService.addItem(customerId, { productId: pB.id, quantity: 3 }, randomUUID());

      const order = await ordersService.checkout(customerId, BASE_CHECKOUT_DTO);

      expect(order.vendorOrders).toHaveLength(2);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(payment.amount.toFixed(2)).toBe('1550.00');
      const attempt = await prisma.checkoutAttempt.findFirstOrThrow({ where: { orderId: order.id } });
      expect(attempt.selectedPath).toBe(
        mode === ReservationEngineMode.CART_SCOPED ? CheckoutPath.CART_SCOPED : CheckoutPath.LEGACY,
      );
      expect(attempt.status).toBe('COMMITTED');
      expect(await redisClient.hget(reservationHashKey(pA.id), cartId)).toBeNull();
      expect(await redisClient.get(reservationKey(cartId, pB.id))).toBeNull();
    }
  });

  it('11. Failure and compensation: pre-commit barrier failure rolls back DB and marks attempt FAILED; post-commit payment gateway timeout preserves committed Order with RECONCILE_REQUIRED', async () => {
    // 11a: Pre-commit barrier activation inside $transaction marks attempt FAILED and leaves zero order/stock change
    await forceModeReset(ReservationEngineMode.LEGACY);
    const { id: c1, cartId: cart1 } = await createCustomer();
    const p1 = await createProduct(vendorAId, { stock: 10, price: 500 });
    await cartService.addItem(c1, { productId: p1.id, quantity: 2 }, randomUUID());
    await mutationBarrier.activate(adminUserId);

    await expect(ordersService.checkout(c1, BASE_CHECKOUT_DTO)).rejects.toThrow(
      ServiceUnavailableException,
    );
    await mutationBarrier.deactivate(adminUserId);

    expect((await prisma.product.findUniqueOrThrow({ where: { id: p1.id } })).quantityAvailable).toBe(10);
    expect(await prisma.order.count({ where: { customerId: c1 } })).toBe(0);
    const attempt1 = await prisma.checkoutAttempt.findFirstOrThrow({ where: { cartId: cart1 } });
    expect(attempt1.selectedPath).toBe(CheckoutPath.LEGACY);
    expect(attempt1.status).toBe('FAILED');
    expect(attempt1.failureCode).toBe('CART_MUTATION_BARRIER_ACTIVE');

    // 11b: Post-commit gateway timeout preserves Order, COMMITTED attempt, and Payment in RECONCILE_REQUIRED
    const { id: c2, cartId: cart2 } = await createCustomer();
    const p2 = await createProduct(vendorAId, { stock: 10, price: 650 });
    await cartService.addItem(c2, { productId: p2.id, quantity: 1 }, randomUUID());

    const gatewaySpy = jest
      .spyOn(cashOnDeliveryAdapter, 'createPayment')
      .mockRejectedValueOnce(new Error('Gateway timeout during payment init'));
    try {
      const order = await ordersService.checkout(c2, BASE_CHECKOUT_DTO);

      expect(order.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');
      expect((await prisma.product.findUniqueOrThrow({ where: { id: p2.id } })).quantityAvailable).toBe(9);
      const attempt2 = await prisma.checkoutAttempt.findFirstOrThrow({ where: { cartId: cart2 } });
      expect(attempt2.status).toBe('COMMITTED');
      expect(attempt2.orderId).toBe(order.id);
    } finally {
      gatewaySpy.mockRestore();
    }
  });

  it('12. Transitions LEGACY -> MIRROR, MIRROR -> LEGACY, and MIRROR -> CART_SCOPED stay consistent and reject incompatible C3 state', async () => {
    // 12a: LEGACY -> MIRROR (legacy-only hold succeeds cleanly via LEGACY path)
    await forceModeReset(ReservationEngineMode.LEGACY);
    const cLegToMir = await createCustomer();
    const pLegToMir = await createProduct(vendorAId, { stock: 10, price: 300 });
    await cartService.addItem(cLegToMir.id, { productId: pLegToMir.id, quantity: 2 }, randomUUID());
    await modeService.setMode({ targetMode: ReservationEngineMode.MIRROR, updatedById: adminUserId });

    const orderLegToMir = await ordersService.checkout(cLegToMir.id, BASE_CHECKOUT_DTO);
    expect((await prisma.checkoutAttempt.findFirstOrThrow({ where: { orderId: orderLegToMir.id } })).selectedPath).toBe(
      CheckoutPath.LEGACY,
    );

    // 12b: MIRROR -> LEGACY (legacy + mirror hold checks out via LEGACY path cleanly)
    const cMirToLeg = await createCustomer();
    const pMirToLeg = await createProduct(vendorAId, { stock: 10, price: 350 });
    await cartService.addItem(cMirToLeg.id, { productId: pMirToLeg.id, quantity: 2 }, randomUUID());
    await modeService.setMode({ targetMode: ReservationEngineMode.LEGACY, updatedById: adminUserId });

    const orderMirToLeg = await ordersService.checkout(cMirToLeg.id, BASE_CHECKOUT_DTO);
    expect((await prisma.checkoutAttempt.findFirstOrThrow({ where: { orderId: orderMirToLeg.id } })).selectedPath).toBe(
      CheckoutPath.LEGACY,
    );

    // 12c: MIRROR (mirror C3 diverged/absent) -> CART_SCOPED fails explicitly without bypassing C3
    await modeService.setMode({ targetMode: ReservationEngineMode.MIRROR, updatedById: adminUserId });
    const cMirFailToCs = await createCustomer();
    const pMirFailToCs = await createProduct(vendorAId, { stock: 10, price: 400 });
    await cartService.addItem(cMirFailToCs.id, { productId: pMirFailToCs.id, quantity: 2 }, randomUUID());
    await redisClient.del(
      reservationKey(cMirFailToCs.cartId, pMirFailToCs.id),
      productTotalKey(pMirFailToCs.id),
    );
    await redisClient.srem(cartIndexKey(cMirFailToCs.cartId), pMirFailToCs.id);
    await forceModeReset(ReservationEngineMode.CART_SCOPED);

    await expect(ordersService.checkout(cMirFailToCs.id, BASE_CHECKOUT_DTO)).rejects.toThrow(
      ConflictException,
    );
    expect((await prisma.product.findUniqueOrThrow({ where: { id: pMirFailToCs.id } })).quantityAvailable).toBe(10);
    expect(await prisma.order.count({ where: { customerId: cMirFailToCs.id } })).toBe(0);
  });

  it('13. CART_SCOPED -> DRAINING -> LEGACY drains valid C3 holds, blocks incompatible carts in DRAINING, and preserves selectedPath across retries/replays', async () => {
    // Enter CART_SCOPED and create two carts: one with a valid C3 hold, one without C3 hold
    await forceModeReset(ReservationEngineMode.CART_SCOPED);
    const validDrainingCust = await createCustomer();
    const invalidDrainingCust = await createCustomer();
    const prodA = await createProduct(vendorAId, { stock: 10, price: 500 });
    const prodB = await createProduct(vendorAId, { stock: 10, price: 500 });

    await cartService.addItem(validDrainingCust.id, { productId: prodA.id, quantity: 2 }, randomUUID());
    await prisma.cartItem.create({
      data: { cartId: invalidDrainingCust.cartId, productId: prodB.id, quantity: 1, mutationVersion: 1 },
    });

    // Transition CART_SCOPED -> DRAINING
    const drainRes = await modeService.setMode({
      targetMode: ReservationEngineMode.DRAINING,
      updatedById: adminUserId,
    });
    expect(drainRes.ok).toBe(true);
    await syncOpenFenceForMode(ReservationEngineMode.DRAINING, (await modeService.getCurrentModeSnapshot()).revision!);

    // Unreserved cart fails explicitly during DRAINING
    await expect(ordersService.checkout(invalidDrainingCust.id, BASE_CHECKOUT_DTO)).rejects.toThrow(
      ConflictException,
    );
    expect((await prisma.product.findUniqueOrThrow({ where: { id: prodB.id } })).quantityAvailable).toBe(10);

    // Pre-existing valid C3 cart cannot rollback while held, drains cleanly via checkout, unblocking DRAINING -> LEGACY
    const blockedRollback = await modeService.setMode({
      targetMode: ReservationEngineMode.LEGACY,
      updatedById: adminUserId,
    });
    expect(blockedRollback).toMatchObject({ ok: false, code: 'ROLLBACK_BLOCKED' });

    const drainedOrder = await ordersService.checkout(validDrainingCust.id, BASE_CHECKOUT_DTO);
    expect(
      (await prisma.checkoutAttempt.findFirstOrThrow({ where: { orderId: drainedOrder.id } })).selectedPath,
    ).toBe(CheckoutPath.CART_SCOPED);

    // Delete Redis non-reservation test fence keys if needed? Rollback checks only product-total & cart-index
    const rollbackToLegacy = await modeService.setMode({
      targetMode: ReservationEngineMode.LEGACY,
      updatedById: adminUserId,
    });
    expect(rollbackToLegacy.ok).toBe(true);

    // Retry / replay selectedPath preservation across mode transition:
    // An existing PROCESSING LEGACY attempt rejects CART_SCOPED retry without shifting path
    const processingCust = await createCustomer();
    const prodC = await createProduct(vendorAId, { stock: 10, price: 200 });
    const itemC = await prisma.cartItem.create({
      data: { cartId: processingCust.cartId, productId: prodC.id, quantity: 1, mutationVersion: 0 },
    });
    const keyC = Reflect.get(ordersService as object, 'computeCheckoutIdempotencyKey').call(
      ordersService,
      { id: processingCust.cartId, items: [itemC] },
    );
    await prisma.checkoutAttempt.create({
      data: {
        idempotencyKey: keyC,
        cartId: processingCust.cartId,
        customerId: processingCust.id,
        selectedPath: CheckoutPath.LEGACY,
        status: 'PROCESSING',
      },
    });
    await forceModeReset(ReservationEngineMode.CART_SCOPED);

    await expect(ordersService.checkout(processingCust.id, BASE_CHECKOUT_DTO)).rejects.toThrow(
      ConflictException,
    );
    const unchangedAttempt = await prisma.checkoutAttempt.findUniqueOrThrow({
      where: { idempotencyKey: keyC },
    });
    expect(unchangedAttempt.selectedPath).toBe(CheckoutPath.LEGACY);
    expect(unchangedAttempt.status).toBe('PROCESSING');
  });
});
