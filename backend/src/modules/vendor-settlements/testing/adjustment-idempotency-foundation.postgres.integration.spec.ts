import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Category,
  Order,
  Payment,
  Parish,
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  Product,
  ProductUnit,
  Refund,
  RefundStatus,
  Role,
  RoleName,
  User,
  Vendor,
  VendorOrder,
  VendorOrderStatus,
  VendorSettlement,
  VendorSettlementAdjustment,
  VendorSettlementStatus,
} from '@prisma/client';

import { RefundStatusChangedEvent } from '../../../common/events/refund-status-changed.event';
import { PrismaService } from '../../../database/prisma.service';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { NotificationEventsListener } from '../../notifications/services/notification-events.listener';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { OrdersService } from '../../orders/services/orders.service';
import { PaymentsRepository } from '../../payments/repositories/payments.repository';
import { RefundsRepository } from '../../payments/repositories/refunds.repository';
import { PaymentsService } from '../../payments/services/payments.service';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CommissionRateConfigsRepository } from '../repositories/commission-rate-configs.repository';
import { VendorSettlementAdjustmentsRepository } from '../repositories/vendor-settlement-adjustments.repository';
import { VendorSettlementsRepository } from '../repositories/vendor-settlements.repository';
import { VendorSettlementsService } from '../services/vendor-settlements.service';

jest.setTimeout(120_000);

describe('Refund Correlation & Adjustment Idempotency Foundation (PostgreSQL Integration Suite)', () => {
  let prisma: PrismaService;
  let adjustmentsRepo: VendorSettlementAdjustmentsRepository;
  let settlementsRepo: VendorSettlementsRepository;
  let commissionRepo: CommissionRateConfigsRepository;
  let vendorsRepo: VendorsRepository;
  let settlementsService: VendorSettlementsService;

  let ordersRepo: OrdersRepository;
  let vendorOrdersRepo: VendorOrdersRepository;
  let productsRepo: ProductsRepository;
  let paymentsRepo: PaymentsRepository;
  let refundsRepo: RefundsRepository;
  let inventoryEventsRepo: InventoryEventsRepository;
  let ordersService: OrdersService;
  let paymentsService: PaymentsService;
  let eventEmitter: EventEmitter2;
  let notificationListener: NotificationEventsListener;
  let mockNotificationsService: { notify: jest.Mock };

  let customerUser: User;
  let vendorUser1: User;
  let vendorUser2: User;
  let vendor1: Vendor;
  let vendor2: Vendor;
  let category: Category;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    adjustmentsRepo = new VendorSettlementAdjustmentsRepository(prisma);
    settlementsRepo = new VendorSettlementsRepository(prisma);
    commissionRepo = new CommissionRateConfigsRepository(prisma);
    vendorsRepo = new VendorsRepository(prisma);
    settlementsService = new VendorSettlementsService(
      settlementsRepo,
      adjustmentsRepo,
      commissionRepo,
      vendorsRepo,
    );

    ordersRepo = new OrdersRepository(prisma);
    vendorOrdersRepo = new VendorOrdersRepository(prisma);
    productsRepo = new ProductsRepository(prisma);
    paymentsRepo = new PaymentsRepository(prisma);
    refundsRepo = new RefundsRepository(prisma);
    inventoryEventsRepo = new InventoryEventsRepository(prisma);
    eventEmitter = new EventEmitter2();

    mockNotificationsService = {
      notify: jest.fn().mockResolvedValue({ id: 'notif-1' }),
    };
    notificationListener = new NotificationEventsListener(
      mockNotificationsService as unknown as NotificationsService,
    );

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

    const mockProviderAdapter: any = {
      initiatePayment: jest.fn(),
      verifyPayment: jest.fn(),
      refundPayment: jest.fn().mockImplementation(async (ref: string, amount: number) => {
        return { status: 'COMPLETED', providerReference: `ref_ack_${randomUUID()}` };
      }),
    };

    paymentsService = new PaymentsService(
      paymentsRepo,
      refundsRepo,
      mockProviderAdapter, // WiPay
      mockProviderAdapter, // COD
      eventEmitter,
    );

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
        email: `foundation-customer-${randomUUID()}@example.com`,
        passwordHash: 'dummy_hash',
        firstName: 'Foundation',
        lastName: 'Customer',
        roles: { create: { roleId: customerRole.id } },
      },
    });

    vendorUser1 = await prisma.user.create({
      data: {
        email: `foundation-vendor1-${randomUUID()}@example.com`,
        passwordHash: 'dummy_hash',
        firstName: 'Vendor',
        lastName: 'One',
        roles: { create: { roleId: vendorRole.id } },
      },
    });

    vendorUser2 = await prisma.user.create({
      data: {
        email: `foundation-vendor2-${randomUUID()}@example.com`,
        passwordHash: 'dummy_hash',
        firstName: 'Vendor',
        lastName: 'Two',
        roles: { create: { roleId: vendorRole.id } },
      },
    });

    vendor1 = await prisma.vendor.create({
      data: {
        userId: vendorUser1.id,
        businessName: `Foundation Seafood Co ${randomUUID()}`,
        parish: 'KINGSTON',
        termsAcceptedAt: new Date(),
        status: 'APPROVED',
      },
    });

    vendor2 = await prisma.vendor.create({
      data: {
        userId: vendorUser2.id,
        businessName: `Foundation Produce Market ${randomUUID()}`,
        parish: 'KINGSTON',
        termsAcceptedAt: new Date(),
        status: 'APPROVED',
      },
    });

    category = await prisma.category.create({
      data: {
        name: `Foundation Cat ${randomUUID()}`,
        slug: `foundation-cat-${randomUUID()}`,
      },
    });
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  async function createDeliveredOrderAndSettlement(opts: {
    vendorId?: string;
    subtotal: string;
    commissionRate?: number;
  }): Promise<{
    order: Order;
    vendorOrder: VendorOrder;
    payment: Payment;
    settlement: VendorSettlement;
  }> {
    const vId = opts.vendorId ?? vendor1.id;
    const subtotalDecimal = new Prisma.Decimal(opts.subtotal);

    const product = await prisma.product.create({
      data: {
        vendorId: vId,
        categoryId: category.id,
        name: `Item ${randomUUID()}`,
        description: 'Test product description',
        price: subtotalDecimal,
        unit: ProductUnit.PER_ITEM,
        imageUrl: 'http://example.com/item.jpg',
        quantityAvailable: 100,
      },
    });

    const order = await prisma.order.create({
      data: {
        customerId: customerUser.id,
                currency: 'JMD',
        deliveryAddressLine1: '123 Harbor View',
        deliveryParish: Parish.KINGSTON,
        deliveryPhone: '876-555-0100',
      },
    });

    const vendorOrder = await prisma.vendorOrder.create({
      data: {
        orderId: order.id,
        vendorId: vId,
        status: 'DELIVERED',
        subtotal: subtotalDecimal,
        items: {
          create: {
            productId: product.id,
            productName: product.name,
            quantity: 1,
            unitPrice: subtotalDecimal,
            unit: product.unit,
            subtotal: subtotalDecimal,
            currency: 'JMD',
          },
        },
      },
      include: { items: true },
    });

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: PaymentProviderName.WIPAY,
        amount: subtotalDecimal,
        currency: 'JMD',
        status: PaymentStatus.PAID,
      },
    });

    await commissionRepo.create(opts.commissionRate ?? 0.1000);
    await settlementsService.generateSettlements();

    const settlement = await prisma.vendorSettlement.findUniqueOrThrow({
      where: { vendorOrderId: vendorOrder.id },
    });

    return { order, vendorOrder, payment, settlement };
  }

  async function createRefundRecord(paymentId: string, amount: string): Promise<Refund> {
    return prisma.refund.create({
      data: {
        paymentId,
        amount: new Prisma.Decimal(amount),
        reason: 'Customer return refund',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_key_${randomUUID()}`,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Scenario 1: Migration on a fresh disposable database
  // -------------------------------------------------------------------------
  it('Scenario 1: applies migration and verifies new columns on vendor_settlement_adjustments', async () => {
    const columns: Array<{ column_name: string; is_nullable: string; data_type: string }> =
      await prisma.$queryRaw`
        SELECT column_name, is_nullable, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'vendor_settlement_adjustments'
          AND column_name IN ('idempotencyKey', 'refundId')
        ORDER BY column_name ASC;
      `;

    expect(columns).toHaveLength(2);
    expect(columns[0]!.column_name).toBe('idempotencyKey');
    expect(columns[0]!.is_nullable).toBe('YES');
    expect(columns[1]!.column_name).toBe('refundId');
    expect(columns[1]!.is_nullable).toBe('YES');
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Migration compatibility with representative legacy adjustment rows
  // -------------------------------------------------------------------------
  it('Scenario 2: allows legacy adjustment rows created without idempotencyKey or refundId', async () => {
    const { settlement } = await createDeliveredOrderAndSettlement({ subtotal: '100.00' });

    // Legacy row: only settlementId, amount, reason
    const legacyAdj = await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: -15.00,
      reason: 'Legacy manual adjustment',
    });

    expect(legacyAdj.idempotencyKey).toBeNull();
    expect(legacyAdj.refundId).toBeNull();
    expect(new Prisma.Decimal(legacyAdj.amount).toFixed(2)).toBe('-15.00');

    const fetched = await adjustmentsRepo.findById(legacyAdj.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.idempotencyKey).toBeNull();
    expect(fetched?.refundId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Multiple legacy NULL idempotency keys
  // -------------------------------------------------------------------------
  it('Scenario 3: allows multiple rows with NULL idempotencyKey without unique constraint violations', async () => {
    const { settlement } = await createDeliveredOrderAndSettlement({ subtotal: '150.00' });

    const adj1 = await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: -10.00,
      reason: 'First NULL key adjustment',
      idempotencyKey: null,
    });

    const adj2 = await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: -5.00,
      reason: 'Second NULL key adjustment',
      idempotencyKey: null,
    });

    expect(adj1.id).not.toBe(adj2.id);
    expect(adj1.idempotencyKey).toBeNull();
    expect(adj2.idempotencyKey).toBeNull();

    const adjustments = await adjustmentsRepo.findBySettlementId(settlement.id);
    expect(adjustments.length).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Unique populated idempotency keys
  // -------------------------------------------------------------------------
  it('Scenario 4: successfully stores unique populated idempotency keys', async () => {
    const { settlement } = await createDeliveredOrderAndSettlement({ subtotal: '200.00' });
    const key1 = `adj:refund:rf-1:settlement:${settlement.id}:CLAWBACK`;
    const key2 = `adj:refund:rf-2:settlement:${settlement.id}:CLAWBACK`;

    const adj1 = await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: -20.00,
      reason: 'Refund clawback 1',
      idempotencyKey: key1,
    });

    const adj2 = await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: -15.00,
      reason: 'Refund clawback 2',
      idempotencyKey: key2,
    });

    expect(adj1.idempotencyKey).toBe(key1);
    expect(adj2.idempotencyKey).toBe(key2);

    const found1 = await adjustmentsRepo.findByIdempotencyKey(key1);
    const found2 = await adjustmentsRepo.findByIdempotencyKey(key2);
    expect(found1?.id).toBe(adj1.id);
    expect(found2?.id).toBe(adj2.id);
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Concurrent insertion of identical keys
  // -------------------------------------------------------------------------
  it('Scenario 5: rejects duplicate insertion of the same idempotency key with database unique violation', async () => {
    const { settlement } = await createDeliveredOrderAndSettlement({ subtotal: '120.00' });
    const duplicateKey = `adj:duplicate_test_${randomUUID()}`;

    await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: -12.00,
      reason: 'First insertion',
      idempotencyKey: duplicateKey,
    });

    let caughtError: any = null;
    try {
      await adjustmentsRepo.create({
        settlementId: settlement.id,
        amount: -12.00,
        reason: 'Duplicate insertion attempt',
        idempotencyKey: duplicateKey,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).not.toBeNull();
    // Prisma unique constraint error code is P2002
    expect(caughtError.code).toBe('P2002');
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Different refunds against the same settlement
  // -------------------------------------------------------------------------
  it('Scenario 6: allows distinct adjustments for different refunds against the same settlement', async () => {
    const { payment, settlement } = await createDeliveredOrderAndSettlement({ subtotal: '300.00' });
    const refundA = await createRefundRecord(payment.id, '30.00');
    const refundB = await createRefundRecord(payment.id, '40.00');

    const keyA = `adj:refund:${refundA.id}:settlement:${settlement.id}:CLAWBACK`;
    const keyB = `adj:refund:${refundB.id}:settlement:${settlement.id}:CLAWBACK`;

    const adjA = await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: -30.00,
      reason: 'Clawback refund A',
      idempotencyKey: keyA,
      refundId: refundA.id,
    });

    const adjB = await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: -40.00,
      reason: 'Clawback refund B',
      idempotencyKey: keyB,
      refundId: refundB.id,
    });

    expect(adjA.refundId).toBe(refundA.id);
    expect(adjB.refundId).toBe(refundB.id);

    const bySettlement = await adjustmentsRepo.findBySettlementId(settlement.id);
    const adjIds = bySettlement.map((a) => a.id);
    expect(adjIds).toContain(adjA.id);
    expect(adjIds).toContain(adjB.id);
  });

  // -------------------------------------------------------------------------
  // Scenario 7: One refund associated with multiple settlements
  // -------------------------------------------------------------------------
  it('Scenario 7: allows one refund to associate distinct adjustments across multiple vendor settlements', async () => {
    const product1 = await prisma.product.create({
      data: {
        vendorId: vendor1.id,
        categoryId: category.id,
        name: `MultiItem1 ${randomUUID()}`,
        description: 'Multi-vendor product 1',
        price: new Prisma.Decimal('200.00'),
        unit: ProductUnit.PER_ITEM,
        imageUrl: 'http://example.com/item1.jpg',
        quantityAvailable: 100,
      },
    });
    const product2 = await prisma.product.create({
      data: {
        vendorId: vendor2.id,
        categoryId: category.id,
        name: `MultiItem2 ${randomUUID()}`,
        description: 'Multi-vendor product 2',
        price: new Prisma.Decimal('150.00'),
        unit: ProductUnit.PER_ITEM,
        imageUrl: 'http://example.com/item2.jpg',
        quantityAvailable: 100,
      },
    });

    const multiOrder = await prisma.order.create({
      data: {
        customerId: customerUser.id,
        currency: 'JMD',
        deliveryAddressLine1: '123 Harbor View',
        deliveryParish: Parish.KINGSTON,
        deliveryPhone: '876-555-0100',
      },
    });

    const vo1 = await prisma.vendorOrder.create({
      data: {
        orderId: multiOrder.id,
        vendorId: vendor1.id,
        status: 'DELIVERED',
        subtotal: new Prisma.Decimal('200.00'),
        items: {
          create: {
            productId: product1.id,
            productName: product1.name,
            quantity: 1,
            unitPrice: new Prisma.Decimal('200.00'),
            unit: product1.unit,
            subtotal: new Prisma.Decimal('200.00'),
            currency: 'JMD',
          },
        },
      },
    });
    const vo2 = await prisma.vendorOrder.create({
      data: {
        orderId: multiOrder.id,
        vendorId: vendor2.id,
        status: 'DELIVERED',
        subtotal: new Prisma.Decimal('150.00'),
        items: {
          create: {
            productId: product2.id,
            productName: product2.name,
            quantity: 1,
            unitPrice: new Prisma.Decimal('150.00'),
            unit: product2.unit,
            subtotal: new Prisma.Decimal('150.00'),
            currency: 'JMD',
          },
        },
      },
    });

    const payment = await prisma.payment.create({
      data: {
        orderId: multiOrder.id,
        provider: PaymentProviderName.WIPAY,
        amount: new Prisma.Decimal('350.00'),
        currency: 'JMD',
        status: PaymentStatus.PAID,
      },
    });

    await commissionRepo.create(0.1000);
    await settlementsService.generateSettlements();

    const settlement1 = await prisma.vendorSettlement.findUniqueOrThrow({
      where: { vendorOrderId: vo1.id },
    });
    const settlement2 = await prisma.vendorSettlement.findUniqueOrThrow({
      where: { vendorOrderId: vo2.id },
    });

    const sharedRefund = await createRefundRecord(payment.id, '50.00');

    const key1 = `adj:refund:${sharedRefund.id}:settlement:${settlement1.id}:CLAWBACK`;
    const key2 = `adj:refund:${sharedRefund.id}:settlement:${settlement2.id}:CLAWBACK`;

    const adj1 = await adjustmentsRepo.create({
      settlementId: settlement1.id,
      amount: -30.00,
      reason: 'Split refund clawback vendor 1',
      idempotencyKey: key1,
      refundId: sharedRefund.id,
    });

    const adj2 = await adjustmentsRepo.create({
      settlementId: settlement2.id,
      amount: -20.00,
      reason: 'Split refund clawback vendor 2',
      idempotencyKey: key2,
      refundId: sharedRefund.id,
    });

    expect(adj1.id).not.toBe(adj2.id);
    expect(adj1.refundId).toBe(sharedRefund.id);
    expect(adj2.refundId).toBe(sharedRefund.id);

    const refundAdjustments = await adjustmentsRepo.findByRefundId(sharedRefund.id);
    expect(refundAdjustments).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Scenario 8: Stable replay identity
  // -------------------------------------------------------------------------
  it('Scenario 8: returns existing adjustment on replay lookup by deterministic key', async () => {
    const { settlement } = await createDeliveredOrderAndSettlement({ subtotal: '180.00' });
    const deterministicKey = `adj:replay_test_${randomUUID()}`;

    const created = await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: -18.00,
      reason: 'Original adjustment',
      idempotencyKey: deterministicKey,
    });

    // Replay check
    const existing = await adjustmentsRepo.findByIdempotencyKey(deterministicKey);
    expect(existing).not.toBeNull();
    expect(existing?.id).toBe(created.id);
    expect(existing?.amount.toString()).toBe('-18');
  });

  // -------------------------------------------------------------------------
  // Scenario 9: Refund ID lookup
  // -------------------------------------------------------------------------
  it('Scenario 9: retrieves adjustments by authoritative refundId', async () => {
    const { payment, settlement } = await createDeliveredOrderAndSettlement({ subtotal: '95.00' });
    const refund = await createRefundRecord(payment.id, '25.00');

    await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: -25.00,
      reason: 'Clawback lookup test',
      refundId: refund.id,
      idempotencyKey: `key_${randomUUID()}`,
    });

    const found = await adjustmentsRepo.findByRefundId(refund.id);
    expect(found).toHaveLength(1);
    expect(found[0]?.refundId).toBe(refund.id);
    expect(found[0]?.settlementId).toBe(settlement.id);
  });

  // -------------------------------------------------------------------------
  // Scenario 10: Settlement ID lookup
  // -------------------------------------------------------------------------
  it('Scenario 10: retrieves adjustments by settlementId in chronological order', async () => {
    const { settlement } = await createDeliveredOrderAndSettlement({ subtotal: '220.00' });

    const adj1 = await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: -10.00,
      reason: 'First settlement adj',
    });

    const adj2 = await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: 5.00,
      reason: 'Second settlement adj (bonus)',
    });

    const list = await adjustmentsRepo.findBySettlementId(settlement.id);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0]?.id).toBe(adj1.id);
    expect(list[1]?.id).toBe(adj2.id);
  });

  // -------------------------------------------------------------------------
  // Scenario 11: Decimal amount preservation
  // -------------------------------------------------------------------------
  it('Scenario 11: preserves exact decimal amounts for negative adjustments', async () => {
    const { settlement } = await createDeliveredOrderAndSettlement({ subtotal: '100.00' });

    const adj = await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: new Prisma.Decimal('-45.50'),
      reason: 'Exact decimal deduction',
      idempotencyKey: `dec_key_${randomUUID()}`,
    });

    const fetched = await adjustmentsRepo.findById(adj.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.amount).toBeInstanceOf(Prisma.Decimal);
    expect(fetched?.amount.toFixed(2)).toBe('-45.50');

    const totalAdjustments = await adjustmentsRepo.sumBySettlementIdDecimal(settlement.id);
    expect(totalAdjustments.toFixed(2)).toBe('-45.50');
  });

  // -------------------------------------------------------------------------
  // Scenario 12: Event identifier population
  // -------------------------------------------------------------------------
  it('Scenario 12: populates authoritative orderId, paymentId, and refundId in RefundStatusChangedEvent', async () => {
    const { order, payment } = await createDeliveredOrderAndSettlement({ subtotal: '100.00' });

    let emittedEvent: any = null;
    eventEmitter.on(RefundStatusChangedEvent.eventName, (ev: RefundStatusChangedEvent) => {
      emittedEvent = ev;
    });

    const refund = await paymentsService.refundForOrder(order.id, 50.00, 'Customer partial return');

    expect(refund).not.toBeNull();
    expect(emittedEvent).not.toBeNull();
    expect(emittedEvent?.customerId).toBe(customerUser.id);
    expect(emittedEvent?.amount).toBe('50');
    expect(emittedEvent?.status).toBe(RefundStatus.COMPLETED);
    expect(emittedEvent?.orderId).toBe(order.id);
    expect(emittedEvent?.paymentId).toBe(payment.id);
    expect(emittedEvent?.refundId).toBe(refund?.id);
  });

  // -------------------------------------------------------------------------
  // Scenario 13: Event consumer compatibility
  // -------------------------------------------------------------------------
  it('Scenario 13: verifies notification event listener handles enriched RefundStatusChangedEvent without error', async () => {
    const enrichedEvent = new RefundStatusChangedEvent(
      customerUser.id,
      '75.00',
      'COMPLETED',
      'ord-123',
      'pay-456',
      'ref-789',
    );

    await notificationListener.onRefundStatusChanged(enrichedEvent);

    expect(mockNotificationsService.notify).toHaveBeenCalledWith({
      userId: customerUser.id,
      category: 'PAYMENT',
      eventType: 'REFUND_STATUS_CHANGED',
      priority: 'HIGH',
      variables: { amount: '75.00', status: 'COMPLETED' },
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 14: Persisted refund identity verification
  // -------------------------------------------------------------------------
  it('Scenario 14: verifies foreign key relation between refundId and refunds table', async () => {
    const { payment, settlement } = await createDeliveredOrderAndSettlement({ subtotal: '130.00' });
    const refund = await createRefundRecord(payment.id, '30.00');

    const adj = await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: -30.00,
      reason: 'FK verification adjustment',
      refundId: refund.id,
      idempotencyKey: `fk_key_${randomUUID()}`,
    });

    const adjustmentWithRefund = await prisma.vendorSettlementAdjustment.findUnique({
      where: { id: adj.id },
      include: { refund: true },
    });

    expect(adjustmentWithRefund?.refund).not.toBeNull();
    expect(adjustmentWithRefund?.refund?.id).toBe(refund.id);
    expect(adjustmentWithRefund?.refund?.amount.toFixed(2)).toBe('30.00');
  });

  // -------------------------------------------------------------------------
  // Scenario 15: No adjustment creation from a REQUIRED refund
  // -------------------------------------------------------------------------
  it('Scenario 15: ensures no adjustment is created when a refund is in REQUIRED status', async () => {
    const { payment, settlement } = await createDeliveredOrderAndSettlement({ subtotal: '100.00' });

    const requiredRefund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Order cancellation obligation',
        status: RefundStatus.REQUIRED,
        idempotencyKey: `req_${randomUUID()}`,
      },
    });

    const adjustments = await adjustmentsRepo.findByRefundId(requiredRefund.id);
    expect(adjustments).toHaveLength(0);

    const settlementAdjustments = await adjustmentsRepo.findBySettlementId(settlement.id);
    expect(settlementAdjustments).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 16: No adjustment creation from a PROCESSING refund
  // -------------------------------------------------------------------------
  it('Scenario 16: ensures no adjustment is created when a refund is in PROCESSING status', async () => {
    const { payment, settlement } = await createDeliveredOrderAndSettlement({ subtotal: '80.00' });

    const processingRefund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('40.00'),
        reason: 'In-flight refund',
        status: RefundStatus.PROCESSING,
        idempotencyKey: `proc_${randomUUID()}`,
      },
    });

    const adjustments = await adjustmentsRepo.findByRefundId(processingRefund.id);
    expect(adjustments).toHaveLength(0);

    const settlementAdjustments = await adjustmentsRepo.findBySettlementId(settlement.id);
    expect(settlementAdjustments).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 17: No adjustment creation from RECONCILE_REQUIRED
  // -------------------------------------------------------------------------
  it('Scenario 17: ensures no adjustment is created when a refund is in RECONCILE_REQUIRED status', async () => {
    const { payment, settlement } = await createDeliveredOrderAndSettlement({ subtotal: '110.00' });

    const reconcileRefund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('55.00'),
        reason: 'Ambiguous provider refund outcome',
        status: RefundStatus.RECONCILE_REQUIRED,
        idempotencyKey: `recon_${randomUUID()}`,
      },
    });

    const adjustments = await adjustmentsRepo.findByRefundId(reconcileRefund.id);
    expect(adjustments).toHaveLength(0);

    const settlementAdjustments = await adjustmentsRepo.findBySettlementId(settlement.id);
    expect(settlementAdjustments).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 18: No new adjustment creation from COMPLETED refunds in this foundation-only batch
  // -------------------------------------------------------------------------
  it('Scenario 18: confirms COMPLETED refund does NOT trigger automatic adjustment in D.3 foundation batch', async () => {
    const { order, settlement } = await createDeliveredOrderAndSettlement({ subtotal: '140.00' });

    // Execute completed refund
    const refund = await paymentsService.refundForOrder(order.id, 70.00, 'Partial customer refund');
    expect(refund?.status).toBe(RefundStatus.COMPLETED);

    // D.3 foundation batch does NOT implement clawback listener (deferred to D.4)
    const adjustments = await adjustmentsRepo.findByRefundId(refund!.id);
    expect(adjustments).toHaveLength(0);

    const settlementAdjustments = await adjustmentsRepo.findBySettlementId(settlement.id);
    expect(settlementAdjustments).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 19: B-01 cancellation regression
  // -------------------------------------------------------------------------
  it('Scenario 19: preserves B-01 cancellation behavior creating REQUIRED refund obligation', async () => {
    const product = await prisma.product.create({
      data: {
        vendorId: vendor1.id,
        categoryId: category.id,
        name: `B01 Regress Prod ${randomUUID()}`,
        description: 'Test description',
        price: new Prisma.Decimal('160.00'),
        unit: ProductUnit.PER_ITEM,
        imageUrl: 'http://example.com/b01.jpg',
        quantityAvailable: 50,
      },
    });

    const order = await prisma.order.create({
      data: {
        customerId: customerUser.id,
                currency: 'JMD',
        deliveryAddressLine1: '456 Ocean Way',
        deliveryParish: Parish.ST_JAMES,
        deliveryPhone: '876-555-0200',
      },
    });

    const vendorOrder = await prisma.vendorOrder.create({
      data: {
        orderId: order.id,
        vendorId: vendor1.id,
        status: 'PENDING',
        subtotal: new Prisma.Decimal('160.00'),
        items: {
          create: {
            productId: product.id,
            productName: product.name,
            quantity: 1,
            unitPrice: new Prisma.Decimal('160.00'),
            unit: product.unit,
            subtotal: new Prisma.Decimal('160.00'),
            currency: 'JMD',
          },
        },
      },
      include: { items: true },
    });

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: PaymentProviderName.WIPAY,
        amount: new Prisma.Decimal('160.00'),
        currency: 'JMD',
        status: PaymentStatus.PAID,
      },
    });

    await ordersService.cancelOrder(customerUser.id, order.id);

    const updatedVO = await prisma.vendorOrder.findUniqueOrThrow({ where: { id: vendorOrder.id } });
    expect(updatedVO.status).toBe(VendorOrderStatus.CANCELLED);

    const refund = await prisma.refund.findFirst({ where: { paymentId: payment.id } });
    expect(refund).not.toBeNull();
    expect(refund?.status).toBe(RefundStatus.REQUIRED);
    expect(refund?.amount.toFixed(2)).toBe('160.00');
  });

  // -------------------------------------------------------------------------
  // Scenario 20: B-02 refund concurrency regression
  // -------------------------------------------------------------------------
  it('Scenario 20: preserves B-02 refund reservation serialization and rejects overdraw', async () => {
    const { payment } = await createDeliveredOrderAndSettlement({ subtotal: '100.00' });

    const res1 = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: new Prisma.Decimal('70.00'),
      reason: 'First reservation',
    });
    expect(res1.status).toBe('RESERVED');
    expect(res1.refund?.status).toBe(RefundStatus.PROCESSING);

    // Attempt second reservation that exceeds balance: 70 + 40 = 110 > 100
    const res2 = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: new Prisma.Decimal('40.00'),
      reason: 'Second overdraw reservation',
    });
    expect(res2.status).toBe('EXCEEDS_BALANCE');
  });

  // -------------------------------------------------------------------------
  // Scenario 21: M-01 decimal regression
  // -------------------------------------------------------------------------
  it('Scenario 21: preserves M-01 exact decimal settlement arithmetic (gross == fee + net)', async () => {
    const { settlement } = await createDeliveredOrderAndSettlement({
      subtotal: '100.05',
      commissionRate: 0.1500,
    });

    expect(settlement.grossAmount.toFixed(2)).toBe('100.05');
    expect(settlement.platformFee.toFixed(2)).toBe('15.01'); // 15.0075 -> 15.01
    expect(settlement.netAmount.toFixed(2)).toBe('85.04');
    expect(settlement.grossAmount.equals(settlement.platformFee.add(settlement.netAmount))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 22: m-01 subtotal regression
  // -------------------------------------------------------------------------
  it('Scenario 22: preserves m-01 non-seafood subtotal exact Prisma.Decimal in database', async () => {
    const { vendorOrder } = await createDeliveredOrderAndSettlement({ subtotal: '59.99' });

    const fetchedVO = await prisma.vendorOrder.findUniqueOrThrow({ where: { id: vendorOrder.id } });
    expect(fetchedVO.subtotal).toBeInstanceOf(Prisma.Decimal);
    expect(fetchedVO.subtotal.toFixed(2)).toBe('59.99');
  });
});
