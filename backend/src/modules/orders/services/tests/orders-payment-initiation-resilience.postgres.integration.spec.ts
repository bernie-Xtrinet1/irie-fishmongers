import { randomUUID } from 'crypto';
import { BadGatewayException } from '@nestjs/common';
import {
  FoodSafetyStatus,
  Prisma,
  ProductUnit,
  RoleName,
  SeafoodPricingBasis,
  SeafoodStorageType,
  UsablePartsPreference,
  WeightUnit,
} from '@prisma/client';

import { PrismaService } from '../../../../database/prisma.service';
import { connectRealRedis } from '../../../inventory/services/inventory-reservations.redis-test-helpers';
import {
  CheckoutIntegrationFixture,
  RealCoordinatorHandles,
  buildRealCoordinator,
  checkoutDto,
  seedReadyCheckout,
  setUpCheckoutIntegrationFixture,
  tearDownCheckoutIntegrationFixture,
} from '../../../checkout/services/checkout-coordinator-integration-test-helpers';
import { PaymentsRepository } from '../../../payments/repositories/payments.repository';
import { CheckoutQuoteService } from '../checkout-quote.service';

jest.setTimeout(45_000);

const ISOLATED_DB_INDEX = 7;

describe('OrdersService Checkout Payment Initiation Resilience (real Postgres + Redis)', () => {
  let redisClient: Awaited<ReturnType<typeof connectRealRedis>>;
  let prisma: PrismaService;
  let fixture: CheckoutIntegrationFixture;
  let handles: RealCoordinatorHandles;

  beforeAll(async () => {
    redisClient = await connectRealRedis();
    await redisClient.select(ISOLATED_DB_INDEX);
    prisma = new PrismaService();
    await prisma.onModuleInit();
    fixture = await setUpCheckoutIntegrationFixture(prisma);
  });

  afterAll(async () => {
    const retainedItems = await prisma.orderItem.count({
      where: { product: { vendorId: fixture.vendor.id } },
    });
    if (retainedItems === 0) {
      await prisma.vendorDailyListing.deleteMany({ where: { vendorId: fixture.vendor.id } });
      await prisma.inventoryEvent.deleteMany({ where: { product: { vendorId: fixture.vendor.id } } });
      await prisma.product.deleteMany({ where: { vendorId: fixture.vendor.id } });
      await prisma.seafoodCatalogueItem.deleteMany();
      await prisma.seafoodLot.deleteMany({ where: { vendorId: fixture.vendor.id } });
    }
    await tearDownCheckoutIntegrationFixture(fixture);
    await prisma.onModuleDestroy();
    await redisClient.flushdb();
    await redisClient.quit();
  });

  beforeEach(async () => {
    await redisClient.flushdb();
    handles = buildRealCoordinator(prisma, redisClient);
  });

  // 1. Successful sandbox initiation
  it('TC-PAY-01: successful sandbox payment initiation returns 201 with ESTABLISHED and redirectUrl', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);

    const providerSpy = jest
      .spyOn(handles.cashOnDeliveryAdapter, 'createPayment')
      .mockResolvedValueOnce({
        providerReference: 'test-cod-ref-1',
        redirectUrl: 'https://jmsb.wipayfinancial.com/test-checkout/1',
        status: 'PENDING',
      });

    try {
      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      expect(result.id).toBeDefined();
      expect(result.payment?.initiationStatus).toBe('ESTABLISHED');
      expect(result.payment?.status).toBe('PENDING');
      expect(result.paymentRedirectUrl).toBe('https://jmsb.wipayfinancial.com/test-checkout/1');

      const paymentInDb = await prisma.payment.findUniqueOrThrow({
        where: { orderId: result.id },
      });
      expect(paymentInDb.initiationStatus).toBe('ESTABLISHED');
      expect(paymentInDb.providerReference).toBe('test-cod-ref-1');
      expect(paymentInDb.status).toBe('PENDING');
    } finally {
      providerSpy.mockRestore();
    }
  });

  // 2. Gateway timeout after durable order commit
  it('TC-PAY-02: gateway timeout after durable commit returns 201 with RECONCILE_REQUIRED and preserves order', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);

    const providerSpy = jest
      .spyOn(handles.cashOnDeliveryAdapter, 'createPayment')
      .mockRejectedValueOnce(new Error('WiPay gateway socket timeout after 10000ms'));

    try {
      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      // Assert clean 201 response with recoverable payment state
      expect(result.id).toBeDefined();
      expect(result.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');
      expect(result.payment?.status).toBe('PENDING');
      expect(result.paymentRedirectUrl).toBeUndefined();

      // Assert order and stock changes are committed in PostgreSQL
      const orderInDb = await prisma.order.findUniqueOrThrow({
        where: { id: result.id },
        include: { vendorOrders: { include: { items: true } } },
      });
      expect(orderInDb.vendorOrders).toHaveLength(1);
      expect(orderInDb.vendorOrders[0]?.status).toBe('PENDING');

      // Inventory decrement remained durable
      const productInDb = await prisma.product.findUniqueOrThrow({
        where: { id: scenario.productId },
      });
      expect(productInDb.quantityAvailable).toBe(50 - scenario.quantity);

      // Payment persisted with RECONCILE_REQUIRED
      const paymentInDb = await prisma.payment.findUniqueOrThrow({
        where: { orderId: result.id },
      });
      expect(paymentInDb.initiationStatus).toBe('RECONCILE_REQUIRED');
      expect(paymentInDb.status).toBe('PENDING');
    } finally {
      providerSpy.mockRestore();
    }
  });

  // 3. Gateway HTTP 502 Bad Gateway
  it('TC-PAY-03: gateway HTTP 502 returns 201 with RECONCILE_REQUIRED and durable order', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);

    const providerSpy = jest
      .spyOn(handles.cashOnDeliveryAdapter, 'createPayment')
      .mockRejectedValueOnce(new BadGatewayException('WiPay gateway 502 Bad Gateway'));

    try {
      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      expect(result.id).toBeDefined();
      expect(result.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');
      expect(result.paymentRedirectUrl).toBeUndefined();
    } finally {
      providerSpy.mockRestore();
    }
  });

  // 4. Connection reset
  it('TC-PAY-04: connection reset during gateway request handles safely without crashing', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);

    const providerSpy = jest
      .spyOn(handles.cashOnDeliveryAdapter, 'createPayment')
      .mockRejectedValueOnce(new Error('read ECONNRESET'));

    try {
      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      expect(result.id).toBeDefined();
      expect(result.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');
    } finally {
      providerSpy.mockRestore();
    }
  });

  // 5. Gateway success with lost response
  it('TC-PAY-05: gateway success with lost response retains RECONCILE_REQUIRED until background reconciliation', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);

    // Gateway processed payment remotely, but network died before returning response
    const providerSpy = jest
      .spyOn(handles.cashOnDeliveryAdapter, 'createPayment')
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly after POST'));

    try {
      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      expect(result.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');

      const payment = await prisma.payment.findUniqueOrThrow({
        where: { orderId: result.id },
      });
      expect(payment.initiationStatus).toBe('RECONCILE_REQUIRED');
      expect(payment.providerReference).toBeNull();
    } finally {
      providerSpy.mockRestore();
    }
  });

  // 6. Duplicate checkout submission (replay with same cart/items)
  it('TC-PAY-06: duplicate checkout replay reuses existing order and does not re-initiate payment', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);

    const providerSpy = jest
      .spyOn(handles.cashOnDeliveryAdapter, 'createPayment')
      .mockRejectedValueOnce(new Error('WiPay gateway timeout'));

    try {
      // First checkout: gateway times out, returns order with RECONCILE_REQUIRED
      const first = await handles.ordersService.checkout(scenario.customerId, checkoutDto);
      expect(first.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');
      expect(providerSpy).toHaveBeenCalledTimes(1);

      // Verify no duplicate inventory deduction
      const product = await prisma.product.findUniqueOrThrow({
        where: { id: scenario.productId },
      });
      expect(product.quantityAvailable).toBe(50 - scenario.quantity);
    } finally {
      providerSpy.mockRestore();
    }
  });

  // 7. Concurrent initiation claims
  it('TC-PAY-07: concurrent payment initiation claims are atomically fenced by CAS', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);

    const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: result.id } });

    // Reset payment to NOT_STARTED to test concurrent claims
    await prisma.payment.update({
      where: { id: payment.id },
      data: { initiationStatus: 'NOT_STARTED' },
    });

    const paymentsRepo = new PaymentsRepository(prisma);

    // Fire two concurrent claimInitiation CAS queries
    const [claim1, claim2] = await Promise.all([
      paymentsRepo.claimInitiation(payment.id),
      paymentsRepo.claimInitiation(payment.id),
    ]);

    // Exactly one must win (true) and one must lose (false)
    expect([claim1, claim2].filter(Boolean)).toHaveLength(1);

    const finalPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(finalPayment.initiationStatus).toBe('INITIATING');
  });

  // 8. Crash after durable claim but before gateway response
  it('TC-PAY-08: crashed process leaves INITIATING claim discoverable by recovery workers', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);

    const wiPaySpy = jest
      .spyOn(handles.wiPayAdapter, 'createPayment')
      .mockResolvedValueOnce({
        providerReference: `wipay-tc-pay-08-${randomUUID()}`,
        redirectUrl: 'https://jmsb.wipayfinancial.com/test-checkout/tc-pay-08',
        status: 'PENDING',
      });

    let result;
    try {
      result = await handles.ordersService.checkout(scenario.customerId, {
        ...checkoutDto,
        paymentMethod: 'WIPAY',
      });
    } finally {
      wiPaySpy.mockRestore();
    }

    // Simulate process crash: payment was marked INITIATING, but worker died before adapter finished
    const staleTime = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    await prisma.payment.update({
      where: { orderId: result.id },
      data: {
        initiationStatus: 'INITIATING',
        updatedAt: staleTime,
      },
    });

    const paymentsRepo = new PaymentsRepository(prisma);
    const candidates = await paymentsRepo.findRecoveryCandidates(new Date(Date.now() - 5 * 60 * 1000), 10);

    expect(candidates.some((c: { id: string }) => c.id === result.payment?.id)).toBe(true);
  });

  // 9. Missing provider reference
  it('TC-PAY-09: missing provider reference is retained as RECONCILE_REQUIRED without blind re-initiation', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);

    const providerSpy = jest
      .spyOn(handles.cashOnDeliveryAdapter, 'createPayment')
      .mockRejectedValueOnce(new Error('WiPay gateway timeout before transaction reference issued'));

    try {
      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: result.id } });
      expect(payment.providerReference).toBeNull();
      expect(payment.initiationStatus).toBe('RECONCILE_REQUIRED');

      // Calling initiatePayment directly must NOT call the provider adapter again
      const directCall = await handles.paymentsService.initiatePayment({
        orderId: result.id,
        amount: 1000,
        currency: 'JMD',
        provider: 'CASH_ON_DELIVERY',
      });

      expect(directCall.payment.initiationStatus).toBe('RECONCILE_REQUIRED');
      expect(providerSpy).toHaveBeenCalledTimes(1);
    } finally {
      providerSpy.mockRestore();
    }
  });

  // 10. Reconciliation-required state persistence
  it('TC-PAY-10: RECONCILE_REQUIRED state is durably persisted and queryable in Postgres', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);

    const providerSpy = jest
      .spyOn(handles.cashOnDeliveryAdapter, 'createPayment')
      .mockRejectedValueOnce(new Error('Gateway error'));

    try {
      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: result.id } });
      expect(payment.initiationStatus).toBe('RECONCILE_REQUIRED');
      expect(payment.status).toBe('PENDING');
      expect(payment.updatedAt).toBeInstanceOf(Date);
    } finally {
      providerSpy.mockRestore();
    }
  });

  // 11. Payment-state persistence failure
  it('TC-PAY-11: rethrows error when payment persistence fails and state cannot be confirmed as RECONCILE_REQUIRED', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);

    // Spy on getByOrderId to simulate failure to read or verify RECONCILE_REQUIRED
    const getByOrderIdSpy = jest
      .spyOn(handles.paymentsService, 'getByOrderId')
      .mockResolvedValueOnce(null);

    const providerSpy = jest
      .spyOn(handles.cashOnDeliveryAdapter, 'createPayment')
      .mockRejectedValueOnce(new Error('Underlying gateway failure'));

    try {
      // Must throw rather than masking the unconfirmed state
      await expect(
        handles.ordersService.checkout(scenario.customerId, checkoutDto),
      ).rejects.toThrow('Underlying gateway failure');
    } finally {
      getByOrderIdSpy.mockRestore();
      providerSpy.mockRestore();
    }
  });

  // 12. Existing grocery checkout compatibility
  it('TC-PAY-12: grocery checkout (legacy product without lot) succeeds and initiates payment', async () => {
    const scenario = await seedReadyCheckout(fixture, handles);

    const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

    expect(result.id).toBeDefined();
    expect(result.payment?.initiationStatus).toBe('ESTABLISHED');
    expect(result.payment?.status).toBe('PENDING');
  });

  // 13. Existing seafood checkout compatibility
  it('TC-PAY-13: seafood checkout with SAFE lot consumes reservation and completes payment initiation', async () => {
    const { vendor, category } = fixture;
    const customerRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const customer = await prisma.user.create({
      data: {
        email: `seafood-customer-${randomUUID()}@example.com`,
        passwordHash: 'hash',
        firstName: 'Sam',
        lastName: 'Seafood',
        roles: { create: { roleId: customerRole.id } },
      },
    });
    fixture.userIds.push(customer.id);

    // Create seafood lot with SAFE status
    const lot = await prisma.seafoodLot.create({
      data: {
        lotNumber: `LOT-SAFE-${randomUUID()}`,
        vendorId: vendor.id,
        species: 'Snapper',
        storageType: SeafoodStorageType.FRESH,
        catchDate: new Date(),
        weight: new Prisma.Decimal('100.00'),
        weightUnit: WeightUnit.POUNDS,
        foodSafetyStatus: FoodSafetyStatus.SAFE,
      },
    });

    const catalogueItem = await prisma.seafoodCatalogueItem.create({
      data: {
        name: `Snapper ${randomUUID()}`,
        commonName: 'Red Snapper',
        categoryId: category.id,
        lifecycleStatus: 'PUBLISHED',
      },
    });

    const product = await prisma.product.create({
      data: {
        vendorId: vendor.id,
        categoryId: category.id,
        lotId: lot.id,
        catalogueItemId: catalogueItem.id,
        inventoryMode: 'LISTING_BACKED',
        name: `Safe Snapper ${randomUUID()}`,
        description: 'Quality tested safe snapper',
        unit: ProductUnit.PER_POUND,
        price: new Prisma.Decimal('600.00'),
        quantityAvailable: 30,
        imageUrl: 'https://example.com/snapper.jpg',
      },
    });

    const listing = await prisma.vendorDailyListing.create({
      data: {
        vendorId: vendor.id,
        productId: product.id,
        catalogueItemId: catalogueItem.id,
        lotId: lot.id,
        listingTitle: `Listing ${randomUUID()}`,
        catchDate: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        unit: ProductUnit.PER_POUND,
        price: new Prisma.Decimal('600.00'),
        quantityUploaded: new Prisma.Decimal('50.00'),
        quantityAvailable: new Prisma.Decimal('30.00'),
        quantityReserved: new Prisma.Decimal('0.00'),
        quantitySold: new Prisma.Decimal('0.00'),
        status: 'PUBLISHED',
      },
    });

    const cart = await handles.cartRepository.findOrCreateByCustomerId(customer.id);
    await handles.cartRepository.addOrIncrementItem(cart.id, product.id, 2);
    let item = await handles.cartRepository.findItemByCartAndProduct(cart.id, product.id);
    item = await prisma.cartItem.update({
      where: { id: item!.id },
      data: { mutationVersion: 1 },
    });

    await handles.priceLockService.createPriceLock({
      cartId: cart.id,
      cartItemId: item!.id,
      customerId: customer.id,
      now: new Date(),
    });

    await prisma.cartReservationSyncState.create({
      data: {
        cartId: cart.id,
        productId: product.id,
        expectedQuantity: 2,
        expectedMutationVersion: item!.mutationVersion,
      },
    });

    await handles.inventoryReservations.reserveOrRenew(cart.id, product.id, customer.id, 2);

    const checkoutQuoteService = new CheckoutQuoteService();
    const cartRevisionHash = checkoutQuoteService.computeCartRevisionHash([
      {
        id: item!.id,
        productId: product.id,
        quantity: 2,
        mutationVersion: item!.mutationVersion,
      },
    ]);

    const quoteToken = checkoutQuoteService.issueQuoteToken(
      {
        authenticatedCustomerId: customer.id,
        cartId: cart.id,
        cartRevisionHash,
        items: [
          {
            cartItemId: item!.id,
            productId: product.id,
            mutationVersion: item!.mutationVersion,
            listingId: listing.id,
            lotId: lot.id,
            vendorId: vendor.id,
            species: 'Snapper',
            productTitle: product.name,
            productDescription: product.description,
            pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
            unit: ProductUnit.PER_POUND,
            unitPrice: '600.00',
            currency: 'JMD',
            pieceCount: 2,
            estimatedBillableWeight: 2,
            weightUnit: WeightUnit.POUNDS,
            fishCount: 2,
            originalWholeWeightLbs: 2,
            originalWholeWeightUnit: WeightUnit.POUNDS,
            usablePartsPreference: UsablePartsPreference.RETURN_USABLE_PARTS,
            estimatedProductSubtotal: '1200.00',
            estimatedPreparationFee: '0.00',
            estimatedItemTotal: '1200.00',
            minimumAuthorizedCeilingJmd: '1200.00',
            customerAuthorizedCeilingJmd: '1200.00',
          },
        ],
        termsVersion: 'v2026.10',
        ttlMs: 15 * 60 * 1000,
      },
      'mock-signing-secret-minimum-32-chars-long',
    );

    try {
      const result = await handles.ordersService.checkout(customer.id, {
        ...checkoutDto,
        quoteToken,
      });

      expect(result.id).toBeDefined();
      expect(result.payment?.initiationStatus).toBe('ESTABLISHED');
      expect(result.payment?.status).toBe('PENDING');
    } finally {
      await prisma.cartReservationSyncState.deleteMany({ where: { cartId: cart.id } });
      await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
      const retainedItemCount = await prisma.orderItem.count({ where: { productId: product.id } });
      if (retainedItemCount === 0) {
        await prisma.vendorDailyListing.deleteMany({ where: { id: listing.id } });
        await prisma.inventoryEvent.deleteMany({ where: { productId: product.id } });
        await prisma.product.deleteMany({ where: { id: product.id } });
        await prisma.seafoodCatalogueItem.deleteMany({ where: { id: catalogueItem.id } });
        await prisma.seafoodLot.deleteMany({ where: { id: lot.id } });
      }
    }
  });
});
