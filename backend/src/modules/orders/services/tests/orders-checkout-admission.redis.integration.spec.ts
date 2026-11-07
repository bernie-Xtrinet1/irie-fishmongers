import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { Redis } from 'ioredis';

import { PrismaService } from '../../../../database/prisma.service';
import { RedisService } from '../../../../common/redis/redis.service';
import { CartRepository, CartWithItems } from '../../../cart/repositories/cart.repository';
import { CartMutationBarrierService } from '../../../cart-mutation-barrier/services/cart-mutation-barrier.service';
import { CartReservationSyncStateRepository } from '../../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { CheckoutAttemptRepository } from '../../../checkout-attempt/repositories/checkout-attempt.repository';
import { CheckoutQuoteService } from '../checkout-quote.service';
import {
  cartIndexKey,
  productIndexKey,
  productTotalKey,
  reservationKey,
} from '../../../inventory/constants/inventory.constants';
import { InventoryEventsRepository } from '../../../inventory/repositories/inventory-events.repository';
import { CheckoutReservationStateService } from '../../../inventory/services/checkout-reservation-state.service';
import { InventoryReservationsService } from '../../../inventory/services/inventory-reservations.service';
import {
  connectRealRedis,
  cleanupKeys,
} from '../../../inventory/services/inventory-reservations.redis-test-helpers';
import {
  checkoutIds,
  getRawCheckoutFields,
  trackCheckoutKeysFor,
} from '../../../inventory/services/checkout-reservation-state.redis-test-helpers';
import { OrdersRepository, OrderWithDetails } from '../../repositories/orders.repository';
import { VendorOrdersRepository } from '../../repositories/vendor-orders.repository';
import { PaymentsService } from '../../../payments/services/payments.service';
import { ProductsRepository } from '../../../products/repositories/products.repository';
import { VendorPermissionsService } from '../../../vendor-tiers/services/vendor-permissions.service';
import { VendorsRepository } from '../../../vendors/repositories/vendors.repository';
import { WeightAdjustmentSnapshotInitializationService } from '../../../weight-adjustment/services/weight-adjustment-snapshot-initialization.service';
import { OrdersService } from '../orders.service';

jest.setTimeout(45_000);

describe('OrdersService Checkout Admission Gate (real Redis integration)', () => {
  let client: Redis;
  let redisService: RedisService;
  let checkoutStateService: CheckoutReservationStateService;
  let createdKeys: Set<string>;

  let ordersService: OrdersService;
  let mockPrisma: any;
  let mockOrdersRepo: any;
  let mockVendorOrdersRepo: any;
  let mockCartRepo: any;
  let mockProductsRepo: any;
  let mockVendorsRepo: any;
  let mockPaymentsService: any;
  let mockVendorPermissions: any;
  let mockInventoryEventsRepo: any;
  let mockInventoryReservations: any;
  let mockEventEmitter: any;
  let mockSyncStateRepo: any;
  let mockMutationBarrier: any;
  let mockQuoteService: any;
  let mockWeightAdjustmentInit: any;
  let mockConfigService: any;
  let mockCheckoutAttemptRepo: any;

  beforeAll(async () => {
    client = await connectRealRedis();
    redisService = new RedisService(client);
    checkoutStateService = new CheckoutReservationStateService(redisService);
  });

  afterAll(async () => {
    await client.quit();
  });

  beforeEach(() => {
    createdKeys = new Set<string>();

    mockPrisma = {
      $transaction: jest.fn().mockImplementation((cb) => cb(mockPrisma)),
      deliveryZoneParish: {
        findUnique: jest.fn().mockResolvedValue({ zoneId: 'zone-1' }),
      },
      order: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };

    mockOrdersRepo = {
      create: jest.fn().mockResolvedValue({ id: 'order-1', vendorOrders: [] }),
      findById: jest.fn().mockResolvedValue({ id: 'order-1', vendorOrders: [] }),
    };

    mockVendorOrdersRepo = {
      create: jest.fn().mockResolvedValue({ id: 'vo-1' }),
    };

    mockCartRepo = {
      findOrCreateByCustomerId: jest.fn(),
      clear: jest.fn().mockResolvedValue(undefined),
    };

    mockProductsRepo = {
      decrementStock: jest.fn().mockResolvedValue(undefined),
      adjustStock: jest.fn().mockResolvedValue(undefined),
    };

    mockVendorsRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'vendor-1',
        status: 'APPROVED',
        tier: 'COMMUNITY_FISHER',
      }),
    };

    mockPaymentsService = {
      initiatePayment: jest.fn().mockResolvedValue({
        payment: {
          id: 'payment-1',
          orderId: 'order-1',
          provider: 'CASH_ON_DELIVERY',
          status: 'PENDING',
          initiationStatus: 'ESTABLISHED',
          amount: '100.00',
          currency: 'JMD',
          paidAt: null,
          createdAt: new Date(),
        },
        redirectUrl: null,
      }),
      processOrderPayment: jest.fn().mockResolvedValue({
        id: 'payment-1',
        orderId: 'order-1',
        provider: 'CASH_ON_DELIVERY',
        status: 'PENDING',
        initiationStatus: 'ESTABLISHED',
        amount: '100.00',
        currency: 'JMD',
        paidAt: null,
        createdAt: new Date(),
      }),
    };

    mockVendorPermissions = {
      assertSalesLimitNotExceeded: jest.fn().mockResolvedValue(undefined),
    };

    mockInventoryEventsRepo = {
      create: jest.fn().mockResolvedValue(undefined),
    };

    mockInventoryReservations = {
      release: jest.fn().mockResolvedValue(undefined),
    };

    mockEventEmitter = {
      emitAsync: jest.fn().mockResolvedValue([]),
    };

    mockSyncStateRepo = {
      advanceForClearedCart: jest.fn().mockResolvedValue(undefined),
    };
    mockMutationBarrier = {
      assertNotActive: jest.fn().mockResolvedValue(undefined),
    };

    mockQuoteService = {
      verifyQuote: jest.fn(),
      computeCartRevisionHash: jest.fn().mockReturnValue('mock-hash'),
    };

    mockWeightAdjustmentInit = {
      initializeSnapshot: jest.fn().mockResolvedValue(undefined),
    };

    mockConfigService = {
      get: jest.fn(),
      getOrThrow: jest.fn().mockReturnValue('secret-key-32-chars-long-minimum-secret'),
    };

    mockCheckoutAttemptRepo = {
      createOrGetByIdempotencyKey: jest.fn().mockImplementation(({ idempotencyKey, customerId, cartId }) => ({
        created: true,
        attempt: {
          id: 'attempt-1',
          idempotencyKey,
          cartId,
          customerId,
          status: 'PROCESSING',
        },
      })),
      markCommitted: jest.fn().mockResolvedValue(1),
    };

    ordersService = new OrdersService(
      mockPrisma as unknown as PrismaService,
      mockOrdersRepo as unknown as OrdersRepository,
      mockVendorOrdersRepo as unknown as VendorOrdersRepository,
      mockCartRepo as unknown as CartRepository,
      mockProductsRepo as unknown as ProductsRepository,
      mockVendorsRepo as unknown as VendorsRepository,
      mockPaymentsService as unknown as PaymentsService,
      mockVendorPermissions as unknown as VendorPermissionsService,
      mockInventoryEventsRepo as unknown as InventoryEventsRepository,
      mockInventoryReservations as unknown as InventoryReservationsService,
      mockEventEmitter as unknown as EventEmitter2,
      mockSyncStateRepo as unknown as CartReservationSyncStateRepository,
      mockMutationBarrier as unknown as CartMutationBarrierService,
      mockQuoteService as unknown as CheckoutQuoteService,
      mockWeightAdjustmentInit as unknown as WeightAdjustmentSnapshotInitializationService,
      mockConfigService as unknown as ConfigService,
      mockCheckoutAttemptRepo as unknown as CheckoutAttemptRepository,
      checkoutStateService,
    );
  });

  afterEach(async () => {
    await cleanupKeys(client, createdKeys);
  });

  async function seedRawActiveReservation(
    cartId: string,
    productId: string,
    customerId: string,
    quantity: number,
    rollingTtlMs = 900_000,
    absoluteTtlMs = 3_600_000,
  ): Promise<void> {
    const now = Date.now();
    const payload = JSON.stringify({
      version: 1,
      cartId,
      customerId,
      quantity,
      status: 'ACTIVE',
      createdAt: now,
      lastRenewedAt: now,
      expiresAt: now + rollingTtlMs,
      absoluteExpiresAt: now + absoluteTtlMs,
      checkoutIdempotencyKey: null,
      checkoutPendingAt: null,
      checkoutPendingExpiresAt: null,
    });

    createdKeys.add(reservationKey(cartId, productId));
    createdKeys.add(cartIndexKey(cartId));
    createdKeys.add(productIndexKey(productId));
    createdKeys.add(productTotalKey(productId));

    await client.set(reservationKey(cartId, productId), payload);
    await client.sadd(cartIndexKey(cartId), productId);
    await client.sadd(productIndexKey(productId), cartId);
    await client.incrby(productTotalKey(productId), quantity);
  }

  function setupCartWithProduct(
    cartId: string,
    customerId: string,
    productId: string,
    quantity = 2,
  ) {
    mockCartRepo.findOrCreateByCustomerId.mockResolvedValue({
      id: cartId,
      customerId,
      items: [
        {
          id: 'item-1',
          cartId,
          productId,
          quantity,
          product: {
            id: productId,
            name: 'Test Red Snapper',
            price: new Prisma.Decimal('25.00'),
            isActive: true,
            vendorId: 'vendor-1',
            lot: null,
          },
        },
      ],
    });
  }

  const validCheckoutDto = {
    deliveryAddressLine1: '123 Harbor View',
    deliveryParish: 'KINGSTON' as const,
    deliveryPhone: '+18765551234',
    paymentMethod: 'CASH_ON_DELIVERY' as const,
  };

  it('admits checkout and transitions reservation to CHECKOUT_PENDING when active reservation has sufficient headroom', async () => {
    const { cartId, customerId } = checkoutIds();
    const productId = `prod-${randomUUID()}`;

    // Seed valid active reservation with 15min rolling and 60min absolute TTL
    await seedRawActiveReservation(cartId, productId, customerId, 2, 900_000, 3_600_000);
    setupCartWithProduct(cartId, customerId, productId, 2);

    // Perform checkout
    await ordersService.checkout(customerId, validCheckoutDto);

    // Verify Redis state: transitioned to CHECKOUT_PENDING
    const fields = await getRawCheckoutFields(client, cartId, productId);
    expect(fields).not.toBeNull();
    expect(fields!.status).toBe('CHECKOUT_PENDING');
    expect(fields!.checkoutPendingExpiresAt).toBeGreaterThan(Date.now() + 100_000);

    // Verify PostgreSQL transaction was entered
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects competitor attempting checkout on an already-marked reservation (competitor exclusion)', async () => {
    const { cartId, customerId } = checkoutIds();
    const competitorId = randomUUID();
    const productId = `prod-${randomUUID()}`;

    // Seed reservation already marked CHECKOUT_PENDING by customerId
    const now = Date.now();
    const pendingPayload = JSON.stringify({
      version: 1,
      cartId,
      customerId,
      quantity: 2,
      status: 'CHECKOUT_PENDING',
      createdAt: now - 10_000,
      lastRenewedAt: now - 10_000,
      expiresAt: now + 900_000,
      absoluteExpiresAt: now + 3_600_000,
      checkoutIdempotencyKey: 'prior-checkout-attempt',
      checkoutPendingAt: now,
      checkoutPendingExpiresAt: now + 180_000,
    });

    createdKeys.add(reservationKey(cartId, productId));
    createdKeys.add(cartIndexKey(cartId));
    await client.set(reservationKey(cartId, productId), pendingPayload);
    await client.sadd(cartIndexKey(cartId), productId);

    setupCartWithProduct(cartId, competitorId, productId, 2);

    // Competitor attempts checkout
    await expect(
      ordersService.checkout(competitorId, validCheckoutDto),
    ).rejects.toThrow(ConflictException);

    // Verify DB transaction was never opened
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects admission when reservation lacks rolling TTL headroom (RESERVATION_EXPIRED)', async () => {
    const { cartId, customerId } = checkoutIds();
    const productId = `prod-${randomUUID()}`;

    // Seed active reservation with only 60s rolling TTL remaining (< 180s initial lease)
    await seedRawActiveReservation(cartId, productId, customerId, 2, 60_000, 3_600_000);
    setupCartWithProduct(cartId, customerId, productId, 2);

    const promise = ordersService.checkout(customerId, validCheckoutDto);

    await expect(promise).rejects.toThrow(ConflictException);
    await expect(promise).rejects.toThrow(/RESERVATION_EXPIRED/);

    // Verify reservation was NOT marked CHECKOUT_PENDING
    const fields = await getRawCheckoutFields(client, cartId, productId);
    expect(fields!.status).toBe('ACTIVE');

    // DB transaction was never opened
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects admission when reservation lacks absolute TTL headroom (RESERVATION_ABSOLUTE_EXPIRED)', async () => {
    const { cartId, customerId } = checkoutIds();
    const productId = `prod-${randomUUID()}`;

    // Seed active reservation with plenty rolling TTL (900s) but only 60s absolute TTL remaining (< 180s)
    await seedRawActiveReservation(cartId, productId, customerId, 2, 900_000, 60_000);
    setupCartWithProduct(cartId, customerId, productId, 2);

    const promise = ordersService.checkout(customerId, validCheckoutDto);

    await expect(promise).rejects.toThrow(ConflictException);
    await expect(promise).rejects.toThrow(/RESERVATION_ABSOLUTE_EXPIRED/);

    // Verify reservation was NOT marked CHECKOUT_PENDING
    const fields = await getRawCheckoutFields(client, cartId, productId);
    expect(fields!.status).toBe('ACTIVE');

    // DB transaction was never opened
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails closed when Redis is unavailable or disconnected during admission gate', async () => {
    const { cartId, customerId } = checkoutIds();
    const productId = `prod-${randomUUID()}`;

    // Create a broken RedisService that rejects on eval to simulate network partition / Redis outage
    const brokenRedisService = {
      eval: jest.fn().mockRejectedValue(new Error('Redis connection lost: ECONNREFUSED')),
    } as unknown as RedisService;
    const brokenStateService = new CheckoutReservationStateService(brokenRedisService);

    const brokenOrdersService = new OrdersService(
      mockPrisma as unknown as PrismaService,
      mockOrdersRepo as unknown as OrdersRepository,
      mockVendorOrdersRepo as unknown as VendorOrdersRepository,
      mockCartRepo as unknown as CartRepository,
      mockProductsRepo as unknown as ProductsRepository,
      mockVendorsRepo as unknown as VendorsRepository,
      mockPaymentsService as unknown as PaymentsService,
      mockVendorPermissions as unknown as VendorPermissionsService,
      mockInventoryEventsRepo as unknown as InventoryEventsRepository,
      mockInventoryReservations as unknown as InventoryReservationsService,
      mockEventEmitter as unknown as EventEmitter2,
      mockSyncStateRepo as unknown as CartReservationSyncStateRepository,
      mockMutationBarrier as unknown as CartMutationBarrierService,
      mockQuoteService as unknown as CheckoutQuoteService,
      mockWeightAdjustmentInit as unknown as WeightAdjustmentSnapshotInitializationService,
      mockConfigService as unknown as ConfigService,
      mockCheckoutAttemptRepo as unknown as CheckoutAttemptRepository,
      brokenStateService,
    );

    setupCartWithProduct(cartId, customerId, productId, 2);

    // Checkout must fail and NOT open database transaction
    await expect(
      brokenOrdersService.checkout(customerId, validCheckoutDto),
    ).rejects.toThrow(/ECONNREFUSED/);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
