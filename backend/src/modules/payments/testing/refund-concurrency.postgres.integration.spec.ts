import { createHash, randomUUID } from 'crypto';
import { BadRequestException, ConflictException, NotImplementedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CatalogueLifecycleStatus,
  FoodSafetyStatus,
  ListingLifecycleStatus,
  ListingPhotoModerationStatus,
  Order,
  Payment,
  PaymentInitiationStatus,
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  Product,
  ProductUnit,
  Refund,
  RefundStatus,
  Role,
  RoleName,
  SeafoodCatalogueItem,
  SeafoodLot,
  SeafoodStorageType,
  User,
  Vendor,
  VendorDailyListing,
  VendorOrder,
  VendorOrderStatus,
  WeightUnit,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { OrdersService } from '../../orders/services/orders.service';
import { PaymentsRepository } from '../repositories/payments.repository';
import { RefundsRepository } from '../repositories/refunds.repository';
import { PaymentSettlementRepository } from '../repositories/payment-settlement.repository';
import { PaymentsService } from '../services/payments.service';
import { PaymentRefundResult, PaymentProviderAdapter } from '../interfaces/payment-provider.interface';
import { WiPayAdapter } from '../providers/wipay.adapter';
import { CashOnDeliveryAdapter } from '../providers/cash-on-delivery.adapter';
import { SettlementDisposition, SettlementEvidenceProvenance } from '@prisma/client';

jest.setTimeout(120_000);

describe('Concurrent Refund Safety & Blocker B-02 Correction (PostgreSQL Integration Suite)', () => {
  let prisma: PrismaService;
  let ordersRepo: OrdersRepository;
  let vendorOrdersRepo: VendorOrdersRepository;
  let productsRepo: ProductsRepository;
  let vendorsRepo: VendorsRepository;
  let inventoryEventsRepo: InventoryEventsRepository;
  let settlementRepo: PaymentSettlementRepository;
  let refundsRepo: RefundsRepository;
  let paymentsRepo: PaymentsRepository;
  let ordersService: OrdersService;
  let eventEmitter: EventEmitter2;

  let customerUser: User;
  let vendorUser: User;
  let vendor: Vendor;
  let category: { id: string; name: string; slug: string };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    ordersRepo = new OrdersRepository(prisma);
    vendorOrdersRepo = new VendorOrdersRepository(prisma);
    productsRepo = new ProductsRepository(prisma);
    vendorsRepo = new VendorsRepository(prisma);
    inventoryEventsRepo = new InventoryEventsRepository(prisma);
    settlementRepo = new PaymentSettlementRepository(prisma);
    refundsRepo = new RefundsRepository(prisma);
    paymentsRepo = new PaymentsRepository(prisma);
    eventEmitter = new EventEmitter2();

    const mockPaymentsServiceForOrders: any = {
      getByOrderId: jest.fn().mockImplementation(async (orderId: string) => {
        const payment = await prisma.payment.findUnique({ where: { orderId } });
        if (!payment) return null;
        return {
          id: payment.id,
          orderId: payment.orderId,
          provider: payment.provider,
          status: payment.status,
          initiationStatus: payment.initiationStatus,
          amount: payment.amount.toString(),
          currency: payment.currency,
          paidAt: payment.paidAt,
          createdAt: payment.createdAt,
        };
      }),
      refundOrder: jest.fn().mockResolvedValue(undefined),
      refundForOrder: jest.fn().mockResolvedValue(undefined),
    };

    ordersService = new OrdersService(
      prisma,
      ordersRepo,
      vendorOrdersRepo,
      {} as any,
      productsRepo,
      vendorsRepo,
      mockPaymentsServiceForOrders,
      {} as any,
      inventoryEventsRepo,
      {} as any,
      eventEmitter,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    // Setup base users & roles
    const timestamp = Date.now();
    const customerRole = await prisma.role.upsert({
      where: { name: RoleName.CUSTOMER },
      update: {},
      create: { name: RoleName.CUSTOMER },
    });
    const vendorRole = await prisma.role.upsert({
      where: { name: RoleName.VENDOR },
      update: {},
      create: { name: RoleName.VENDOR },
    });

    customerUser = await prisma.user.create({
      data: {
        email: `refund_customer_${timestamp}_${randomUUID()}@example.com`,
        passwordHash: 'dummy-hash',
        firstName: 'Refund',
        lastName: 'Customer',
        phone: '+18765550001',
        roles: { create: { roleId: customerRole.id } },
      },
    });

    vendorUser = await prisma.user.create({
      data: {
        email: `refund_vendor_${timestamp}_${randomUUID()}@example.com`,
        passwordHash: 'dummy-hash',
        firstName: 'Refund',
        lastName: 'Vendor',
        phone: '+18765550002',
        roles: { create: { roleId: vendorRole.id } },
      },
    });

    vendor = await prisma.vendor.create({
      data: {
        userId: vendorUser.id,
        businessName: `Refund Fishery ${timestamp}`,
        parish: 'KINGSTON' as any,
        termsAcceptedAt: new Date(),
        status: 'APPROVED' as any,
      },
    });

    category = await prisma.category.create({
      data: {
        name: `Refund Category ${timestamp}`,
        slug: `refund-category-${timestamp}-${randomUUID().slice(0, 8)}`,
      },
    });
  });

  afterAll(async () => {
    try {
      await prisma.paymentSettlementReceipt.deleteMany({});
      await prisma.paymentSettlementEvent.deleteMany({});
      await prisma.paymentOutbox.deleteMany({});
      await prisma.refund.deleteMany({});
      await prisma.payment.deleteMany({});
      await prisma.checkoutAttempt.deleteMany({});
      await prisma.inventoryEvent.deleteMany({});
      await prisma.orderItem.deleteMany({});
      await prisma.vendorOrder.deleteMany({});
      await prisma.order.deleteMany({});
      await prisma.listingPhoto.deleteMany({});
      await prisma.vendorDailyListing.deleteMany({});
      await prisma.product.deleteMany({});
      await prisma.seafoodLot.deleteMany({});
      await prisma.seafoodCatalogueItem.deleteMany({});
      await prisma.category.deleteMany({});
      await prisma.vendor.deleteMany({});
      await prisma.userRole.deleteMany({});
      await prisma.user.deleteMany({});
    } catch {
      // ignore
    } finally {
      await prisma.$disconnect();
    }
  });

  async function createTestProduct(vendorId: string, name: string) {
    const catalogueItem = await prisma.seafoodCatalogueItem.create({
      data: {
        name: `Seafood ${randomUUID()}`,
        commonName: 'Snapper',
        categoryId: category.id,
        lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
      },
    });

    const lot = await prisma.seafoodLot.create({
      data: {
        lotNumber: `LOT-${randomUUID()}`,
        vendorId,
        species: 'Snapper',
        storageType: SeafoodStorageType.FRESH,
        catchDate: new Date(),
        weight: new Prisma.Decimal('100.00'),
        weightUnit: WeightUnit.POUNDS,
        foodSafetyStatus: FoodSafetyStatus.SAFE,
      },
    });

    const product = await prisma.product.create({
      data: {
        vendorId,
        categoryId: category.id,
        lotId: lot.id,
        catalogueItemId: catalogueItem.id,
        name,
        description: 'Fresh seafood product',
        unit: ProductUnit.PER_POUND,
        price: new Prisma.Decimal('50.00'),
        quantityAvailable: 50,
        imageUrl: 'https://example.com/fish.jpg',
      },
    });

    const listing = await prisma.vendorDailyListing.create({
      data: {
        vendorId,
        productId: product.id,
        catalogueItemId: catalogueItem.id,
        lotId: lot.id,
        listingTitle: `Listing ${name}`,
        catchDate: new Date(),
        expiresAt: new Date(Date.now() + 86400_000),
        unit: ProductUnit.PER_POUND,
        price: new Prisma.Decimal('50.00'),
        quantityUploaded: new Prisma.Decimal('50.00'),
        quantityAvailable: new Prisma.Decimal('20.00'),
        quantityReserved: new Prisma.Decimal('0.00'),
        quantitySold: new Prisma.Decimal('0.00'),
        status: ListingLifecycleStatus.PUBLISHED,
      },
    });

    return { product, listing, lot, catalogueItem };
  }

  async function createTestOrderWithPayment(options: {
    amount: number | Prisma.Decimal | string;
    paymentStatus?: PaymentStatus;
    initiationStatus?: PaymentInitiationStatus;
    provider?: PaymentProviderName;
    subtotals?: Array<number | Prisma.Decimal | string>;
    providerReference?: string | null;
  }) {
    const subtotals = options.subtotals ?? [options.amount];
    const totalAmount = new Prisma.Decimal(options.amount);

    const order = await prisma.order.create({
      data: {
        customerId: customerUser.id,
        deliveryAddressLine1: '123 Harbor View',
        deliveryParish: 'KINGSTON' as any,
        deliveryPhone: '+18765550001',
        currency: 'JMD',
      },
    });

    const vendorOrders: VendorOrder[] = [];
    for (let i = 0; i < subtotals.length; i++) {
      const sub = new Prisma.Decimal(subtotals[i]!);
      const { product, listing } = await createTestProduct(vendor.id, `Product ${i + 1}`);

      const vo = await prisma.vendorOrder.create({
        data: {
          orderId: order.id,
          vendorId: vendor.id,
          subtotal: sub,
          status: VendorOrderStatus.PENDING,
          items: {
            create: [
              {
                productId: product.id,
                productName: product.name,
                unit: product.unit,
                originalListingId: listing.id,
                quantity: 1,
                unitPrice: sub,
                subtotal: sub,
              },
            ],
          },
        },
      });
      vendorOrders.push(vo);
    }

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: options.provider ?? PaymentProviderName.CASH_ON_DELIVERY,
        status: options.paymentStatus ?? PaymentStatus.PAID,
        initiationStatus: options.initiationStatus ?? PaymentInitiationStatus.ESTABLISHED,
        amount: totalAmount,
        currency: 'JMD',
        paidAt: options.paymentStatus === PaymentStatus.PAID ? new Date() : null,
        providerReference: options.providerReference ?? null,
      },
    });

    return { order, vendorOrders, payment };
  }

  // =========================================================================
  // SCENARIO 1: Two simultaneous refund requests cannot over-reserve
  // =========================================================================
  it('Scenario 1: Two simultaneous refund requests cannot over-reserve', async () => {
    const { payment } = await createTestOrderWithPayment({ amount: '100.00' });

    // Request A asks for $60, Request B asks for $60 (total $120 > $100)
    const [resA, resB] = await Promise.all([
      refundsRepo.reserveRefund({
        paymentId: payment.id,
        amount: '60.00',
        reason: 'Concurrent request A',
        idempotencyKey: `scen1_req_a_${randomUUID()}`,
      }),
      refundsRepo.reserveRefund({
        paymentId: payment.id,
        amount: '60.00',
        reason: 'Concurrent request B',
        idempotencyKey: `scen1_req_b_${randomUUID()}`,
      }),
    ]);

    const statuses = [resA.status, resB.status];
    expect(statuses).toContain('RESERVED');
    expect(statuses).toContain('EXCEEDS_BALANCE');

    const refundsInDb = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    expect(refundsInDb.length).toBe(1);
    expect(new Prisma.Decimal(refundsInDb[0]!.amount).equals(new Prisma.Decimal('60.00'))).toBe(true);
    expect(refundsInDb[0]!.status).toBe(RefundStatus.PROCESSING);
  });

  // =========================================================================
  // SCENARIO 2: Ten simultaneous refund requests remain bounded by payment amount
  // =========================================================================
  it('Scenario 2: Ten simultaneous refund requests remain bounded by payment amount', async () => {
    const { payment } = await createTestOrderWithPayment({ amount: '100.00' });

    // 10 concurrent requests of $20 each (total $200 requested, only 5 can succeed)
    const requests = Array.from({ length: 10 }, (_, i) =>
      refundsRepo.reserveRefund({
        paymentId: payment.id,
        amount: '20.00',
        reason: `Concurrent stress test ${i + 1}`,
        idempotencyKey: `scen2_req_${i + 1}_${randomUUID()}`,
      }),
    );

    const results = await Promise.all(requests);
    const reservedCount = results.filter((r) => r.status === 'RESERVED').length;
    const rejectedCount = results.filter((r) => r.status === 'EXCEEDS_BALANCE').length;

    expect(reservedCount).toBe(5);
    expect(rejectedCount).toBe(5);

    const refundsInDb = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    expect(refundsInDb.length).toBe(5);

    const totalReserved = refundsInDb.reduce(
      (sum, r) => sum.add(r.amount),
      new Prisma.Decimal(0),
    );
    expect(new Prisma.Decimal(totalReserved).equals(new Prisma.Decimal('100.00'))).toBe(true);
  });

  // =========================================================================
  // SCENARIO 3: Repeated idempotency key reuses the existing reservation
  // =========================================================================
  it('Scenario 3: Repeated idempotency key reuses the existing reservation', async () => {
    const { payment } = await createTestOrderWithPayment({ amount: '100.00' });
    const idemKey = `scen3_idem_${randomUUID()}`;

    // Call 1: initial reservation
    const res1 = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '40.00',
      reason: 'First attempt',
      idempotencyKey: idemKey,
    });
    expect(res1.status).toBe('RESERVED');
    expect(res1.refund).toBeDefined();

    // Call 2: repeated call under same key while in flight
    const res2 = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '40.00',
      reason: 'Retry while in flight',
      idempotencyKey: idemKey,
    });
    expect(res2.status).toBe('IN_FLIGHT');
    expect(res2.refund?.id).toBe(res1.refund!.id);

    // Finalize Call 1
    await refundsRepo.finalizeRefund({
      refundId: res1.refund!.id,
      paymentId: payment.id,
      status: RefundStatus.COMPLETED,
      providerReference: 'gw-ref-3',
      expectedAmount: '40.00',
    });

    // Call 3: repeated call after completion
    const res3 = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '40.00',
      reason: 'Retry after completion',
      idempotencyKey: idemKey,
    });
    expect(res3.status).toBe('ALREADY_COMPLETED');
    expect(res3.refund?.id).toBe(res1.refund!.id);

    const allRefunds = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    expect(allRefunds.length).toBe(1);
  });

  // =========================================================================
  // SCENARIO 4: Different keys cannot reserve overlapping funds
  // =========================================================================
  it('Scenario 4: Different keys cannot reserve overlapping funds', async () => {
    const { payment } = await createTestOrderWithPayment({ amount: '100.00' });

    const keyA = `scen4_key_a_${randomUUID()}`;
    const keyB = `scen4_key_b_${randomUUID()}`;
    const keyC = `scen4_key_c_${randomUUID()}`;

    const resA = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '70.00',
      reason: 'Key A',
      idempotencyKey: keyA,
    });
    expect(resA.status).toBe('RESERVED');

    // Key B tries to reserve $40 when only $30 remains
    const resB = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '40.00',
      reason: 'Key B',
      idempotencyKey: keyB,
    });
    expect(resB.status).toBe('EXCEEDS_BALANCE');

    // Key C tries to reserve remaining $30
    const resC = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '30.00',
      reason: 'Key C',
      idempotencyKey: keyC,
    });
    expect(resC.status).toBe('RESERVED');

    const totalActive = await refundsRepo.sumActiveByPaymentId(payment.id);
    expect(new Prisma.Decimal(totalActive).equals(new Prisma.Decimal('100.00'))).toBe(true);
  });

  // =========================================================================
  // SCENARIO 5: REQUIRED obligations reduce available balance
  // =========================================================================
  it('Scenario 5: REQUIRED obligations reduce available balance', async () => {
    const { payment } = await createTestOrderWithPayment({ amount: '100.00' });

    // Pre-create a REQUIRED obligation (as if from paid order cancellation)
    await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('60.00'),
        reason: 'Prior cancellation obligation',
        status: RefundStatus.REQUIRED,
        idempotencyKey: `cancel_oblig_${randomUUID()}`,
      },
    });

    // Attempt to reserve $50 under a new key (available is $40)
    const resExceed = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '50.00',
      reason: 'New refund',
      idempotencyKey: `new_req_${randomUUID()}`,
    });
    expect(resExceed.status).toBe('EXCEEDS_BALANCE');

    // Attempt to reserve $40 (exact available)
    const resExact = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '40.00',
      reason: 'Exact remaining',
      idempotencyKey: `new_req_exact_${randomUUID()}`,
    });
    expect(resExact.status).toBe('RESERVED');
  });

  // =========================================================================
  // SCENARIO 6: PROCESSING obligations reduce available balance
  // =========================================================================
  it('Scenario 6: PROCESSING obligations reduce available balance', async () => {
    const { payment } = await createTestOrderWithPayment({ amount: '100.00' });

    await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('45.00'),
        reason: 'In-flight processing',
        status: RefundStatus.PROCESSING,
        idempotencyKey: `proc_oblig_${randomUUID()}`,
      },
    });

    const res = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '60.00',
      reason: 'Exceeding test',
      idempotencyKey: `proc_test_${randomUUID()}`,
    });
    expect(res.status).toBe('EXCEEDS_BALANCE');

    const resOk = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '55.00',
      reason: 'Fitting test',
      idempotencyKey: `proc_test_ok_${randomUUID()}`,
    });
    expect(resOk.status).toBe('RESERVED');
  });

  // =========================================================================
  // SCENARIO 7: COMPLETED refunds reduce available balance
  // =========================================================================
  it('Scenario 7: COMPLETED refunds reduce available balance', async () => {
    const { payment } = await createTestOrderWithPayment({
      amount: '100.00',
      paymentStatus: PaymentStatus.PARTIALLY_REFUNDED,
    });

    await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('35.00'),
        reason: 'Prior completed refund',
        status: RefundStatus.COMPLETED,
        providerReference: 'gw-prior-35',
      },
    });

    const resFail = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '70.00',
      reason: 'Exceeds remaining 65',
      idempotencyKey: `comp_fail_${randomUUID()}`,
    });
    expect(resFail.status).toBe('EXCEEDS_BALANCE');

    const resOk = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '65.00',
      reason: 'Exact remaining 65',
      idempotencyKey: `comp_ok_${randomUUID()}`,
    });
    expect(resOk.status).toBe('RESERVED');
  });

  // =========================================================================
  // SCENARIO 8: FAILED refund attempt retains obligation capacity until retried on same obligation or voided via dual control
  // =========================================================================
  it('Scenario 8: FAILED attempt retains obligation capacity, allows correlated replacement, and blocks unrelated keys until voided', async () => {
    const { payment } = await createTestOrderWithPayment({ amount: '100.00' });
    const idemKey = `scen8_fail_${randomUUID()}`;

    const res1 = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '100.00',
      reason: 'Will fail at gateway',
      idempotencyKey: idemKey,
    });
    expect(res1.status).toBe('RESERVED');
    expect(res1.obligation).toBeDefined();

    await refundsRepo.finalizeRefund({
      refundId: res1.refund!.id,
      paymentId: payment.id,
      status: RefundStatus.FAILED,
      providerReference: 'gw-declined-card',
      expectedAmount: '100.00',
    });

    // Obligation remains OPEN holding $100 capacity so an unrelated refund key is blocked
    const resUnrelated = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '100.00',
      reason: 'Unrelated key must not steal obligated capacity',
      idempotencyKey: `scen8_new_${randomUUID()}`,
    });
    expect(resUnrelated.status).toBe('EXCEEDS_BALANCE');

    // Correlated replacement retry against the SAME obligation supersedes R1 without needing extra payment balance
    const resRetry = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '100.00',
      reason: 'Correlated replacement retry',
      idempotencyKey: idemKey,
      obligationId: res1.obligation!.id,
      allowReplacementRetry: true,
    });
    expect(resRetry.status).toBe('RESERVED');
    expect(resRetry.refund?.supersedesRefundId).toBe(res1.refund!.id);
    expect(resRetry.refund?.obligationId).toBe(res1.obligation!.id);
  });

  // =========================================================================
  // SCENARIO 9: Uncertain provider outcome preserves the reservation
  // =========================================================================
  it('Scenario 9: Uncertain provider outcome preserves the reservation', async () => {
    const { payment } = await createTestOrderWithPayment({ amount: '100.00' });
    const idemKey = `scen9_timeout_${randomUUID()}`;

    const res1 = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '75.00',
      reason: 'Times out',
      idempotencyKey: idemKey,
    });
    expect(res1.status).toBe('RESERVED');

    // Update to RECONCILE_REQUIRED due to gateway timeout
    await refundsRepo.updateStatus(res1.refund!.id, RefundStatus.RECONCILE_REQUIRED);

    // Active balance includes RECONCILE_REQUIRED, so remaining is only $25
    const resExceed = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '30.00',
      reason: 'Attempt while uncertain',
      idempotencyKey: `scen9_exceed_${randomUUID()}`,
    });
    expect(resExceed.status).toBe('EXCEEDS_BALANCE');

    const resOk = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '25.00',
      reason: 'Remaining available',
      idempotencyKey: `scen9_ok_${randomUUID()}`,
    });
    expect(resOk.status).toBe('RESERVED');
  });

  // =========================================================================
  // SCENARIO 10: Timeout cannot trigger a second provider dispatch
  // =========================================================================
  it('Scenario 10: Timeout cannot trigger a second provider dispatch', async () => {
    const { payment } = await createTestOrderWithPayment({ amount: '100.00' });

    let dispatchCount = 0;
    const mockTimeoutAdapter: PaymentProviderAdapter = {
      name: PaymentProviderName.CASH_ON_DELIVERY,
      createPayment: jest.fn(),
      verifyPayment: jest.fn(),
      refundPayment: jest.fn().mockImplementation(() => {
        dispatchCount++;
        throw new Error('Connection reset by peer / gateway timeout');
      }),
    };

    const mockPaymentsRepo: any = {
      findById: jest.fn().mockResolvedValue({
        id: payment.id,
        orderId: payment.orderId,
        provider: PaymentProviderName.CASH_ON_DELIVERY,
        status: PaymentStatus.PAID,
        amount: new Prisma.Decimal('100.00'),
        order: { customerId: customerUser.id },
      }),
      findByOrderId: jest.fn(),
    };

    const serviceWithTimeout = new PaymentsService(
      mockPaymentsRepo,
      refundsRepo,
      new WiPayAdapter(null as any),
      mockTimeoutAdapter as any,
      eventEmitter,
    );

    const idemKey = `scen10_dispatch_${randomUUID()}`;

    // First call: throws timeout and updates status to RECONCILE_REQUIRED
    await expect(
      serviceWithTimeout.refundByPaymentId(payment.id, 50, 'Timeout call', idemKey),
    ).rejects.toThrow('Connection reset by peer');
    expect(dispatchCount).toBe(1);

    // Verify persisted state is RECONCILE_REQUIRED
    const savedRefund = await prisma.refund.findUnique({ where: { idempotencyKey: idemKey } });
    expect(savedRefund?.status).toBe(RefundStatus.RECONCILE_REQUIRED);

    // Second call with same idempotency key: detects RECONCILE_REQUIRED and does NOT re-dispatch
    const retryResult = await serviceWithTimeout.refundByPaymentId(
      payment.id,
      50,
      'Timeout retry',
      idemKey,
    );
    expect(retryResult.status).toBe(RefundStatus.RECONCILE_REQUIRED);
    expect(dispatchCount).toBe(1); // Zero second dispatch!
  });

  // =========================================================================
  // SCENARIO 11: Definitive provider rejection is handled safely
  // =========================================================================
  it('Scenario 11: Definitive provider rejection is handled safely', async () => {
    const { payment } = await createTestOrderWithPayment({ amount: '100.00' });

    const mockRejectAdapter: PaymentProviderAdapter = {
      name: PaymentProviderName.CASH_ON_DELIVERY,
      createPayment: jest.fn(),
      verifyPayment: jest.fn(),
      refundPayment: jest.fn().mockResolvedValue({
        providerReference: 'gw-declined-card',
        status: 'FAILED',
      }),
    };

    const mockPaymentsRepo: any = {
      findById: jest.fn().mockResolvedValue({
        id: payment.id,
        orderId: payment.orderId,
        provider: PaymentProviderName.CASH_ON_DELIVERY,
        status: PaymentStatus.PAID,
        amount: new Prisma.Decimal('100.00'),
        order: { customerId: customerUser.id },
      }),
    };

    let emittedEvent: any = null;
    const testEmitter = new EventEmitter2();
    testEmitter.on('refund.status_changed', (ev) => {
      emittedEvent = ev;
    });

    const serviceWithReject = new PaymentsService(
      mockPaymentsRepo,
      refundsRepo,
      new WiPayAdapter(null as any),
      mockRejectAdapter as any,
      testEmitter,
    );

    const idemKey = `scen11_reject_${randomUUID()}`;
    const result = await serviceWithReject.refundByPaymentId(
      payment.id,
      50,
      'Reject test',
      idemKey,
    );

    expect(result.status).toBe(RefundStatus.FAILED);

    const refundRow = await prisma.refund.findUnique({ where: { idempotencyKey: idemKey } });
    expect(refundRow?.status).toBe(RefundStatus.FAILED);
    expect(refundRow?.providerReference).toBe('gw-declined-card');

    // Payment remains PAID
    const paymentRow = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(paymentRow?.status).toBe(PaymentStatus.PAID);

    expect(emittedEvent).not.toBeNull();
    expect(emittedEvent.status).toBe(RefundStatus.FAILED);
  });

  // =========================================================================
  // SCENARIO 12: Conflicting completion evidence is rejected
  // =========================================================================
  it('Scenario 12: Conflicting completion evidence is rejected', async () => {
    const { payment } = await createTestOrderWithPayment({ amount: '100.00' });

    const res = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '50.00',
      reason: 'Conflict test',
      idempotencyKey: `scen12_${randomUUID()}`,
    });

    // Complete with reference gw-ref-original
    await refundsRepo.finalizeRefund({
      refundId: res.refund!.id,
      paymentId: payment.id,
      status: RefundStatus.COMPLETED,
      providerReference: 'gw-ref-original',
      expectedAmount: '50.00',
    });

    // Attempt completion with conflicting providerReference throws ConflictException
    await expect(
      refundsRepo.finalizeRefund({
        refundId: res.refund!.id,
        paymentId: payment.id,
        status: RefundStatus.COMPLETED,
        providerReference: 'gw-ref-conflicting',
        expectedAmount: '50.00',
      }),
    ).rejects.toThrow(ConflictException);

    // Attempt completion with mismatched expectedAmount throws ConflictException
    await expect(
      refundsRepo.finalizeRefund({
        refundId: res.refund!.id,
        paymentId: payment.id,
        status: RefundStatus.COMPLETED,
        providerReference: 'gw-ref-original',
        expectedAmount: '60.00',
      }),
    ).rejects.toThrow(ConflictException);
  });

  // =========================================================================
  // SCENARIO 13: Decimal amounts reconcile exactly
  // =========================================================================
  it('Scenario 13: Decimal amounts reconcile exactly', async () => {
    const { payment } = await createTestOrderWithPayment({ amount: '100.00' });

    const res1 = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '33.33',
      reason: 'Decimal split 1',
      idempotencyKey: `scen13_1_${randomUUID()}`,
    });
    expect(res1.status).toBe('RESERVED');
    expect(new Prisma.Decimal(res1.remainingBalance).equals(new Prisma.Decimal('66.67'))).toBe(true);

    const res2 = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '66.67',
      reason: 'Decimal split 2',
      idempotencyKey: `scen13_2_${randomUUID()}`,
    });
    expect(res2.status).toBe('RESERVED');
    expect(new Prisma.Decimal(res2.remainingBalance).equals(new Prisma.Decimal('0.00'))).toBe(true);

    // 0.01 overdraw is rejected
    const res3 = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '0.01',
      reason: 'Epsilon overdraw',
      idempotencyKey: `scen13_3_${randomUUID()}`,
    });
    expect(res3.status).toBe('EXCEEDS_BALANCE');
  });

  // =========================================================================
  // SCENARIO 14: Cancellation and refund reservation remain consistent
  // =========================================================================
  it('Scenario 14: Cancellation and refund reservation remain consistent', async () => {
    const { order, payment } = await createTestOrderWithPayment({
      amount: '100.00',
      subtotals: ['50.00', '50.00'],
    });

    // Step 1: Pre-existing refund reservation of $40 created
    const res = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '40.00',
      reason: 'Pre-cancellation partial refund',
      idempotencyKey: `scen14_res_${randomUUID()}`,
    });
    expect(res.status).toBe('RESERVED');

    // Step 2: Customer cancels the order
    await ordersService.cancelOrder(customerUser.id, order.id);

    // Verify cancellation created a REQUIRED refund obligation capped at remaining $60
    const cancelRefund = await prisma.refund.findUnique({
      where: { idempotencyKey: `refund_order_cancel_${payment.id}` },
    });
    expect(cancelRefund).not.toBeNull();
    expect(new Prisma.Decimal(cancelRefund?.amount!).equals(new Prisma.Decimal('60.00'))).toBe(true);
    expect(cancelRefund?.status).toBe(RefundStatus.REQUIRED);

    // Sum of all active refunds in database is exactly $100.00
    const totalActive = await refundsRepo.sumActiveByPaymentId(payment.id);
    expect(new Prisma.Decimal(totalActive).equals(new Prisma.Decimal('100.00'))).toBe(true);
  });

  // =========================================================================
  // SCENARIO 15: Late settlement and refund reservation remain consistent
  // =========================================================================
  it('Scenario 15: Late settlement and refund reservation remain consistent', async () => {
    const { order, payment } = await createTestOrderWithPayment({
      amount: '100.00',
      paymentStatus: PaymentStatus.PENDING,
      provider: PaymentProviderName.WIPAY,
    });

    // Cancel order while payment is PENDING (no refund obligation generated)
    await ordersService.cancelOrder(customerUser.id, order.id);

    const refundsBefore = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    expect(refundsBefore.length).toBe(0);

    // Late settlement arrives confirming payment success
    const rawPayload = { simulated: true, paymentId: payment.id };
    const payloadStr = JSON.stringify(rawPayload);
    const evidenceDigest = createHash('sha256').update(payloadStr, 'utf8').digest('hex');

    await settlementRepo.executeSettlementTransaction({
      orderId: order.id,
      paymentId: payment.id,
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId: `late-evt-${randomUUID()}`,
      gatewayTxnId: `gw-late-${randomUUID()}`,
      amount: new Prisma.Decimal('100.00'),
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.AUTHENTICATED_WEBHOOK,
        sourceIp: '127.0.0.1',
        rawPayload,
        evidenceDigest,
        signatureValid: true,
        eventTimestamp: new Date(),
      },
    });

    // Verify late settlement generated refund_post_cancel obligation
    const postCancelRefund = await prisma.refund.findUnique({
      where: { idempotencyKey: `refund_post_cancel_${payment.id}` },
    });
    expect(postCancelRefund).not.toBeNull();
    expect(postCancelRefund?.status).toBe(RefundStatus.REQUIRED);
    expect(new Prisma.Decimal(postCancelRefund?.amount!).equals(new Prisma.Decimal('100.00'))).toBe(true);

    // Attempt subsequent refund reservation: rejected because entire $100 is reserved
    const resBlocked = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '50.00',
      reason: 'Should be rejected after late settlement obligation',
      idempotencyKey: `scen15_block_${randomUUID()}`,
    });
    expect(resBlocked.status).toBe('EXCEEDS_BALANCE');
  });

  // =========================================================================
  // SCENARIO 16: Database rollback leaves no partial reservation
  // =========================================================================
  it('Scenario 16: Database rollback leaves no partial reservation', async () => {
    const { payment } = await createTestOrderWithPayment({ amount: '100.00' });
    const idemKey = `scen16_rollback_${randomUUID()}`;

    // Attempt a transaction that reserves a refund and then aborts
    await expect(
      prisma.$transaction(async (tx) => {
        await refundsRepo.reserveRefund(
          {
            paymentId: payment.id,
            amount: '50.00',
            reason: 'Rollback test',
            idempotencyKey: idemKey,
          },
          tx,
        );
        throw new Error('Forced transaction failure');
      }),
    ).rejects.toThrow('Forced transaction failure');

    // Verify nothing was persisted
    const rollbackRefund = await prisma.refund.findUnique({ where: { idempotencyKey: idemKey } });
    expect(rollbackRefund).toBeNull();

    const activeBalance = await refundsRepo.sumActiveByPaymentId(payment.id);
    expect(activeBalance.toString()).toBe('0');
  });

  // =========================================================================
  // SCENARIO 17: Existing B-01 tests remain passing
  // =========================================================================
  it('Scenario 17: Full paid order cancellation creates REQUIRED obligation compatible with new reservation logic', async () => {
    const { order, payment } = await createTestOrderWithPayment({ amount: '80.00' });

    // Cancel order
    const updated = await ordersService.cancelOrder(customerUser.id, order.id);
    expect(updated.vendorOrders.every((vo) => vo.status === VendorOrderStatus.CANCELLED)).toBe(true);

    const cancelOblig = await prisma.refund.findUnique({
      where: { idempotencyKey: `refund_order_cancel_${payment.id}` },
    });
    expect(cancelOblig?.status).toBe(RefundStatus.REQUIRED);
    expect(new Prisma.Decimal(cancelOblig?.amount!).equals(new Prisma.Decimal('80.00'))).toBe(true);

    // Executing the cancellation obligation through reserveRefund transitions it to PROCESSING
    const execRes = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '80.00',
      reason: 'Execute cancellation refund',
      idempotencyKey: `refund_order_cancel_${payment.id}`,
    });
    expect(execRes.status).toBe('RESERVED');
    expect(execRes.refund?.status).toBe(RefundStatus.PROCESSING);
  });

  // =========================================================================
  // SCENARIO 18: No live gateway is invoked
  // =========================================================================
  it('Scenario 18: No live gateway is invoked during test execution', async () => {
    // WiPay refunds throw NotImplementedException; CashOnDelivery uses local synthetic IDs
    const wipayAdapter = new WiPayAdapter(null as any);
    await expect(wipayAdapter.refundPayment('any', 100, 'reason')).rejects.toBeInstanceOf(
      NotImplementedException,
    );

    const codAdapter = new CashOnDeliveryAdapter();
    const result = await codAdapter.refundPayment('cod-ref-test', 50);
    expect(result.status).toBe('COMPLETED');
    expect(result.providerReference).toMatch(/^cod-refund-/);
  });
});
