import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Category,
  Order,
  Payment,
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
  VendorSettlementStatus,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { OrdersService } from '../../orders/services/orders.service';
import { PaymentsRepository } from '../../payments/repositories/payments.repository';
import { RefundsRepository } from '../../payments/repositories/refunds.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CommissionRateConfigsRepository } from '../repositories/commission-rate-configs.repository';
import { VendorSettlementAdjustmentsRepository } from '../repositories/vendor-settlement-adjustments.repository';
import { VendorSettlementsRepository } from '../repositories/vendor-settlements.repository';
import { VendorSettlementsService } from '../services/vendor-settlements.service';

jest.setTimeout(120_000);

describe('Vendor Decimal Integrity & Financial Precision (PostgreSQL Integration Suite)', () => {
  let prisma: PrismaService;
  let settlementsRepo: VendorSettlementsRepository;
  let adjustmentsRepo: VendorSettlementAdjustmentsRepository;
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
  let eventEmitter: EventEmitter2;

  let customerUser: User;
  let vendorUser1: User;
  let vendorUser2: User;
  let vendor1: Vendor;
  let vendor2: Vendor;
  let category: Category;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    settlementsRepo = new VendorSettlementsRepository(prisma);
    adjustmentsRepo = new VendorSettlementAdjustmentsRepository(prisma);
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
        email: `decimal-customer-${randomUUID()}@example.com`,
        passwordHash: 'dummy_hash',
        firstName: 'Decimal',
        lastName: 'Customer',
        roles: { create: { roleId: customerRole.id } },
      },
    });

    vendorUser1 = await prisma.user.create({
      data: {
        email: `decimal-vendor1-${randomUUID()}@example.com`,
        passwordHash: 'dummy_hash',
        firstName: 'Vendor',
        lastName: 'One',
        roles: { create: { roleId: vendorRole.id } },
      },
    });

    vendor1 = await prisma.vendor.create({
      data: {
        userId: vendorUser1.id,
        businessName: `Decimal Vendor One ${randomUUID()}`,
        parish: 'KINGSTON',
        termsAcceptedAt: new Date(),
        status: 'APPROVED',
      },
    });

    vendorUser2 = await prisma.user.create({
      data: {
        email: `decimal-vendor2-${randomUUID()}@example.com`,
        passwordHash: 'dummy_hash',
        firstName: 'Vendor',
        lastName: 'Two',
        roles: { create: { roleId: vendorRole.id } },
      },
    });

    vendor2 = await prisma.vendor.create({
      data: {
        userId: vendorUser2.id,
        businessName: `Decimal Vendor Two ${randomUUID()}`,
        parish: 'KINGSTON',
        termsAcceptedAt: new Date(),
        status: 'APPROVED',
      },
    });

    category = await prisma.category.create({
      data: {
        name: `Decimal Test Category ${randomUUID()}`,
        slug: `decimal-cat-${randomUUID()}`,
      },
    });
  });

  afterAll(async () => {
    try {
      await prisma.vendorSettlementAdjustment.deleteMany({});
      await prisma.vendorSettlement.deleteMany({});
      await prisma.platformCommissionConfig.deleteMany({});
      await prisma.refund.deleteMany({});
      await prisma.payment.deleteMany({});
      await prisma.inventoryEvent.deleteMany({});
      await prisma.orderItem.deleteMany({});
      await prisma.vendorOrder.deleteMany({});
      await prisma.order.deleteMany({});
      await prisma.product.deleteMany({});
      await prisma.category.deleteMany({});
      await prisma.vendor.deleteMany({});
      await prisma.userRole.deleteMany({});
      await prisma.user.deleteMany({});
    } catch {
      // ignore
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  async function createDeliveredAndPaidOrder(options: {
    subtotal: Prisma.Decimal | number | string;
    vendorId?: string;
    productName?: string;
    vendorOrderStatus?: 'PENDING' | 'DELIVERED';
  }): Promise<{ order: Order; vendorOrder: VendorOrder; payment: Payment }> {
    const subtotal = new Prisma.Decimal(options.subtotal);
    const targetVendorId = options.vendorId ?? vendor1.id;

    const product = await productsRepo.create({
      vendorId: targetVendorId,
      categoryId: category.id,
      name: options.productName ?? `Decimal Product ${randomUUID()}`,
      description: 'Decimal integrity test product',
      unit: ProductUnit.PER_ITEM,
      price: Number(subtotal),
      quantityAvailable: 100,
      imageUrl: 'https://example.com/product.jpg',
    });

    const order = await ordersRepo.create({
      customerId: customerUser.id,
      deliveryAddressLine1: '12 Ocean Boulevard',
      deliveryParish: 'KINGSTON',
      deliveryPhone: '+18765550000',
      currency: 'JMD',
      vendorOrders: [
        {
          vendorId: targetVendorId,
          subtotal,
          items: [
            {
              productId: product.id,
              productName: product.name,
              unitPrice: subtotal,
              unit: ProductUnit.PER_ITEM,
              quantity: 1,
              subtotal,
              currency: 'JMD',
            },
          ],
        },
      ],
    });

    const vendorOrderId = order.vendorOrders[0]!.id;
    if (options.vendorOrderStatus !== 'PENDING') {
      await vendorOrdersRepo.updateStatus(vendorOrderId, 'DELIVERED');
    }

    const payment = await paymentsRepo.create({
      orderId: order.id,
      provider: PaymentProviderName.CASH_ON_DELIVERY,
      amount: Number(subtotal),
      currency: 'JMD',
    });

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.PAID,
        paidAt: new Date(),
        providerReference: `prov-ref-${randomUUID()}`,
      },
    });

    const refreshedVendorOrder = await prisma.vendorOrder.findUniqueOrThrow({
      where: { id: vendorOrderId },
    });
    const refreshedOrder = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { vendorOrders: true },
    });
    const refreshedPayment = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });

    return {
      order: refreshedOrder,
      vendorOrder: refreshedVendorOrder,
      payment: refreshedPayment,
    };
  }

  // ---------------------------------------------------------------------------
  // SCENARIO 1: Decimal gross amount persistence
  // ---------------------------------------------------------------------------
  describe('Scenario 1: Decimal gross amount persistence', () => {
    it('persists exact decimal gross amount for vendor order subtotal 123.45', async () => {
      await commissionRepo.create(0.1000);
      const { vendorOrder } = await createDeliveredAndPaidOrder({ subtotal: '123.45' });

      const result = await settlementsService.generateSettlements();
      expect(result.settlementsCreated).toBeGreaterThanOrEqual(1);

      const settlement = await prisma.vendorSettlement.findUniqueOrThrow({
        where: { vendorOrderId: vendorOrder.id },
      });

      expect(settlement.grossAmount.toString()).toBe('123.45');
      expect(settlement.grossAmount.toFixed(2)).toBe('123.45');
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 14: Decimal persistence without number conversion
  // ---------------------------------------------------------------------------
  describe('Scenario 14: Decimal persistence without number conversion', () => {
    it('retrieves decimal persistence from database as Prisma.Decimal without numeric conversion', async () => {
      await commissionRepo.create(0.1000);
      const { vendorOrder } = await createDeliveredAndPaidOrder({ subtotal: '456.78' });

      await settlementsService.generateSettlements();

      const settlement = await prisma.vendorSettlement.findUniqueOrThrow({
        where: { vendorOrderId: vendorOrder.id },
      });

      expect(settlement.grossAmount).toBeInstanceOf(Prisma.Decimal);
      expect(typeof settlement.grossAmount).not.toBe('number');
      expect(settlement.grossAmount.toString()).toBe('456.78');
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 2: Exact commission calculation
  // ---------------------------------------------------------------------------
  describe('Scenario 2: Exact commission calculation', () => {
    it('computes exact 15% platform fee and net amount on 100.00 subtotal', async () => {
      await commissionRepo.create(0.1500);
      const { vendorOrder } = await createDeliveredAndPaidOrder({ subtotal: '100.00' });

      await settlementsService.generateSettlements();

      const settlement = await prisma.vendorSettlement.findUniqueOrThrow({
        where: { vendorOrderId: vendorOrder.id },
      });

      expect(settlement.grossAmount.toFixed(2)).toBe('100.00');
      expect(settlement.platformFee.toFixed(2)).toBe('15.00');
      expect(settlement.netAmount.toFixed(2)).toBe('85.00');
      expect(settlement.grossAmount.equals(settlement.platformFee.add(settlement.netAmount))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 3: Half-up rounding boundaries
  // ---------------------------------------------------------------------------
  describe('Scenario 3: Half-up rounding boundaries', () => {
    it('rounds 15.0075 up to 15.01 and 15.0045 down to 15.00 with exact net adjustment', async () => {
      await commissionRepo.create(0.1500);

      // Boundary A: 100.05 * 0.15 = 15.0075 -> rounds up to 15.01
      const fixtureUp = await createDeliveredAndPaidOrder({ subtotal: '100.05' });
      // Boundary B: 100.03 * 0.15 = 15.0045 -> rounds down to 15.00
      const fixtureDown = await createDeliveredAndPaidOrder({ subtotal: '100.03' });

      await settlementsService.generateSettlements();

      const settlementUp = await prisma.vendorSettlement.findUniqueOrThrow({
        where: { vendorOrderId: fixtureUp.vendorOrder.id },
      });
      const settlementDown = await prisma.vendorSettlement.findUniqueOrThrow({
        where: { vendorOrderId: fixtureDown.vendorOrder.id },
      });

      // Boundary A assertion
      expect(settlementUp.grossAmount.toFixed(2)).toBe('100.05');
      expect(settlementUp.platformFee.toFixed(2)).toBe('15.01');
      expect(settlementUp.netAmount.toFixed(2)).toBe('85.04');
      expect(settlementUp.grossAmount.equals(settlementUp.platformFee.add(settlementUp.netAmount))).toBe(true);

      // Boundary B assertion
      expect(settlementDown.grossAmount.toFixed(2)).toBe('100.03');
      expect(settlementDown.platformFee.toFixed(2)).toBe('15.00');
      expect(settlementDown.netAmount.toFixed(2)).toBe('85.03');
      expect(settlementDown.grossAmount.equals(settlementDown.platformFee.add(settlementDown.netAmount))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 4: Gross = platform fee + net amount mathematical identity
  // ---------------------------------------------------------------------------
  describe('Scenario 4: Mathematical identity grossAmount === platformFee + netAmount', () => {
    it('strictly preserves gross = fee + net across diverse difficult decimal fractions', async () => {
      await commissionRepo.create(0.1500);

      const testValues = ['19.99', '33.33', '49.95', '77.77', '99.99', '123.45', '250.55'];
      const fixtures = await Promise.all(
        testValues.map((val) => createDeliveredAndPaidOrder({ subtotal: val })),
      );

      await settlementsService.generateSettlements();

      for (const fix of fixtures) {
        const settlement = await prisma.vendorSettlement.findUniqueOrThrow({
          where: { vendorOrderId: fix.vendorOrder.id },
        });

        const gross = settlement.grossAmount;
        const fee = settlement.platformFee;
        const net = settlement.netAmount;

        expect(gross.equals(fee.add(net))).toBe(true);
        expect(Number(gross.toString())).toBeCloseTo(
          Number(fee.toString()) + Number(net.toString()),
          2,
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 5: Zero commission rate (0.0000)
  // ---------------------------------------------------------------------------
  describe('Scenario 5: Zero commission rate', () => {
    it('sets platformFee to 0.00 and netAmount equal to grossAmount when commission is 0%', async () => {
      await commissionRepo.create(0.0000);
      const { vendorOrder } = await createDeliveredAndPaidOrder({ subtotal: '150.75' });

      await settlementsService.generateSettlements();

      const settlement = await prisma.vendorSettlement.findUniqueOrThrow({
        where: { vendorOrderId: vendorOrder.id },
      });

      expect(settlement.grossAmount.toFixed(2)).toBe('150.75');
      expect(settlement.platformFee.toFixed(2)).toBe('0.00');
      expect(settlement.netAmount.toFixed(2)).toBe('150.75');
      expect(settlement.netAmount.equals(settlement.grossAmount)).toBe(true);
      expect(settlement.grossAmount.equals(settlement.platformFee.add(settlement.netAmount))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 6: Fractional commission rates (0.1250, 0.1333)
  // ---------------------------------------------------------------------------
  describe('Scenario 6: Fractional commission rates', () => {
    it('calculates exact figures for 12.5% and recurring 13.33% rates', async () => {
      // Rate 1: 0.1250 (12.5%) on 80.00 -> 10.00 fee, 70.00 net
      await commissionRepo.create(0.1250);
      const fix1 = await createDeliveredAndPaidOrder({ subtotal: '80.00' });
      await settlementsService.generateSettlements();

      const set1 = await prisma.vendorSettlement.findUniqueOrThrow({
        where: { vendorOrderId: fix1.vendorOrder.id },
      });
      expect(set1.platformFee.toFixed(2)).toBe('10.00');
      expect(set1.netAmount.toFixed(2)).toBe('70.00');
      expect(set1.grossAmount.equals(set1.platformFee.add(set1.netAmount))).toBe(true);

      // Rate 2: 0.1333 on 99.95: 99.95 * 0.1333 = 13.323335 -> 13.32 fee, 86.63 net
      await commissionRepo.create(0.1333);
      const fix2 = await createDeliveredAndPaidOrder({ subtotal: '99.95' });
      await settlementsService.generateSettlements();

      const set2 = await prisma.vendorSettlement.findUniqueOrThrow({
        where: { vendorOrderId: fix2.vendorOrder.id },
      });
      expect(set2.platformFee.toFixed(2)).toBe('13.32');
      expect(set2.netAmount.toFixed(2)).toBe('86.63');
      expect(set2.grossAmount.equals(set2.platformFee.add(set2.netAmount))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 7: Small financial amounts ($0.05, $0.01)
  // ---------------------------------------------------------------------------
  describe('Scenario 7: Small financial amounts', () => {
    it('handles small cent values without rounding underflow or negative amounts', async () => {
      await commissionRepo.create(0.1000);

      // 0.01 * 0.10 = 0.001 -> rounds down to 0.00 fee, 0.01 net
      const fix1Cent = await createDeliveredAndPaidOrder({ subtotal: '0.01' });
      // 0.05 * 0.10 = 0.005 -> rounds up to 0.01 fee, 0.04 net
      const fix5Cent = await createDeliveredAndPaidOrder({ subtotal: '0.05' });

      await settlementsService.generateSettlements();

      const set1Cent = await prisma.vendorSettlement.findUniqueOrThrow({
        where: { vendorOrderId: fix1Cent.vendorOrder.id },
      });
      expect(set1Cent.platformFee.toFixed(2)).toBe('0.00');
      expect(set1Cent.netAmount.toFixed(2)).toBe('0.01');
      expect(set1Cent.grossAmount.equals(set1Cent.platformFee.add(set1Cent.netAmount))).toBe(true);

      const set5Cent = await prisma.vendorSettlement.findUniqueOrThrow({
        where: { vendorOrderId: fix5Cent.vendorOrder.id },
      });
      expect(set5Cent.platformFee.toFixed(2)).toBe('0.01');
      expect(set5Cent.netAmount.toFixed(2)).toBe('0.04');
      expect(set5Cent.grossAmount.equals(set5Cent.platformFee.add(set5Cent.netAmount))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 8: Large supported financial amounts ($999,999.99)
  // ---------------------------------------------------------------------------
  describe('Scenario 8: Large supported financial amounts', () => {
    it('processes maximum 6-digit currency figure without numeric overflow', async () => {
      await commissionRepo.create(0.1500);

      // 999999.99 * 0.15 = 149999.9985 -> rounds up to 150000.00 fee, 849999.99 net
      const fixLarge = await createDeliveredAndPaidOrder({ subtotal: '999999.99' });
      await settlementsService.generateSettlements();

      const setLarge = await prisma.vendorSettlement.findUniqueOrThrow({
        where: { vendorOrderId: fixLarge.vendorOrder.id },
      });

      expect(setLarge.grossAmount.toFixed(2)).toBe('999999.99');
      expect(setLarge.platformFee.toFixed(2)).toBe('150000.00');
      expect(setLarge.netAmount.toFixed(2)).toBe('849999.99');
      expect(setLarge.grossAmount.equals(setLarge.platformFee.add(setLarge.netAmount))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 9: Multiple vendor settlements batch generation
  // ---------------------------------------------------------------------------
  describe('Scenario 9: Multiple vendor settlements batch generation', () => {
    it('creates independent exact settlements for multiple orders across different vendors', async () => {
      await commissionRepo.create(0.1000);

      const fixA = await createDeliveredAndPaidOrder({ subtotal: '200.00', vendorId: vendor1.id });
      const fixB = await createDeliveredAndPaidOrder({ subtotal: '350.50', vendorId: vendor2.id });
      const fixC = await createDeliveredAndPaidOrder({ subtotal: '500.25', vendorId: vendor1.id });

      const batchResult = await settlementsService.generateSettlements();
      expect(batchResult.settlementsCreated).toBe(3);

      const setA = await prisma.vendorSettlement.findUniqueOrThrow({ where: { vendorOrderId: fixA.vendorOrder.id } });
      const setB = await prisma.vendorSettlement.findUniqueOrThrow({ where: { vendorOrderId: fixB.vendorOrder.id } });
      const setC = await prisma.vendorSettlement.findUniqueOrThrow({ where: { vendorOrderId: fixC.vendorOrder.id } });

      expect(setA.platformFee.toFixed(2)).toBe('20.00');
      expect(setA.netAmount.toFixed(2)).toBe('180.00');
      expect(setB.platformFee.toFixed(2)).toBe('35.05');
      expect(setB.netAmount.toFixed(2)).toBe('315.45');
      expect(setC.platformFee.toFixed(2)).toBe('50.03'); // 500.25 * 0.10 = 50.025 -> 50.03
      expect(setC.netAmount.toFixed(2)).toBe('450.22');
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 10: Legacy repository number inputs normalization
  // ---------------------------------------------------------------------------
  describe('Scenario 10: Legacy repository number inputs normalization', () => {
    it('normalizes JS primitive numbers to 2 decimal places using half-up rounding', async () => {
      const fix = await createDeliveredAndPaidOrder({ subtotal: '123.46' });

      const created = await settlementsRepo.create({
        vendorId: vendor1.id,
        vendorOrderId: fix.vendorOrder.id,
        grossAmount: 123.456,
        platformFee: 18.518,
        netAmount: 104.938,
      });

      expect(created.grossAmount).toBeInstanceOf(Prisma.Decimal);
      expect(created.grossAmount.toString()).toBe('123.46');
      expect(created.platformFee.toString()).toBe('18.52');
      expect(created.netAmount.toString()).toBe('104.94');
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 11: Decimal repository inputs preservation
  // ---------------------------------------------------------------------------
  describe('Scenario 11: Decimal repository inputs preservation', () => {
    it('preserves exact Prisma.Decimal instances when passed directly to repository', async () => {
      const fix = await createDeliveredAndPaidOrder({ subtotal: '250.75' });

      const created = await settlementsRepo.create({
        vendorId: vendor1.id,
        vendorOrderId: fix.vendorOrder.id,
        grossAmount: new Prisma.Decimal('250.75'),
        platformFee: new Prisma.Decimal('37.61'),
        netAmount: new Prisma.Decimal('213.14'),
      });

      expect(created.grossAmount.toString()).toBe('250.75');
      expect(created.platformFee.toString()).toBe('37.61');
      expect(created.netAmount.toString()).toBe('213.14');
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 12: String decimal repository inputs normalization
  // ---------------------------------------------------------------------------
  describe('Scenario 12: String decimal repository inputs normalization', () => {
    it('normalizes string decimal inputs to exact Prisma.Decimal values', async () => {
      const fix = await createDeliveredAndPaidOrder({ subtotal: '350.50' });

      const created = await settlementsRepo.create({
        vendorId: vendor1.id,
        vendorOrderId: fix.vendorOrder.id,
        grossAmount: '350.50',
        platformFee: '52.58',
        netAmount: '297.92',
      });

      expect(created.grossAmount.toFixed(2)).toBe('350.50');
      expect(created.platformFee.toFixed(2)).toBe('52.58');
      expect(created.netAmount.toFixed(2)).toBe('297.92');
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 13: Invalid input rejection
  // ---------------------------------------------------------------------------
  describe('Scenario 13: Invalid input rejection', () => {
    it('rejects NaN, Infinity, non-numeric strings, and null/undefined with BadRequestException', async () => {
      const fix = await createDeliveredAndPaidOrder({ subtotal: '100.00' });

      // NaN
      await expect(
        settlementsRepo.create({
          vendorId: vendor1.id,
          vendorOrderId: fix.vendorOrder.id,
          grossAmount: NaN,
          platformFee: 15,
          netAmount: 85,
        }),
      ).rejects.toThrow(BadRequestException);

      // Infinity
      await expect(
        settlementsRepo.create({
          vendorId: vendor1.id,
          vendorOrderId: fix.vendorOrder.id,
          grossAmount: Infinity,
          platformFee: 15,
          netAmount: 85,
        }),
      ).rejects.toThrow(BadRequestException);

      // Non-numeric string
      await expect(
        settlementsRepo.create({
          vendorId: vendor1.id,
          vendorOrderId: fix.vendorOrder.id,
          grossAmount: 'not-a-number',
          platformFee: 15,
          netAmount: 85,
        }),
      ).rejects.toThrow(BadRequestException);

      // Undefined
      await expect(
        settlementsRepo.create({
          vendorId: vendor1.id,
          vendorOrderId: fix.vendorOrder.id,
          grossAmount: undefined as any,
          platformFee: 15,
          netAmount: 85,
        }),
      ).rejects.toThrow(BadRequestException);

      // Adjustments repository validation
      await expect(
        adjustmentsRepo.create({
          settlementId: randomUUID(),
          amount: NaN,
          reason: 'Invalid adjustment test',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 15: Non-seafood subtotal preservation on VendorOrder (m-01)
  // ---------------------------------------------------------------------------
  describe('Scenario 15: Non-seafood subtotal decimal preservation (m-01)', () => {
    it('persists exact non-integer decimal subtotal on VendorOrder without float conversion', async () => {
      const subtotalDecimal = new Prisma.Decimal('47.85');

      const product = await productsRepo.create({
        vendorId: vendor1.id,
        categoryId: category.id,
        name: `Non-Seafood Sauce ${randomUUID()}`,
        description: 'Non-seafood grocery item',
        unit: ProductUnit.PER_ITEM,
        price: 47.85,
        quantityAvailable: 50,
        imageUrl: 'https://example.com/sauce.jpg',
      });

      const order = await ordersRepo.create({
        customerId: customerUser.id,
        deliveryAddressLine1: '45 Spice Way',
        deliveryParish: 'KINGSTON',
        deliveryPhone: '+18765551111',
        currency: 'JMD',
        vendorOrders: [
          {
            vendorId: vendor1.id,
            subtotal: subtotalDecimal,
            items: [
              {
                productId: product.id,
                productName: product.name,
                unitPrice: subtotalDecimal,
                unit: ProductUnit.PER_ITEM,
                quantity: 1,
                subtotal: subtotalDecimal,
                currency: 'JMD',
              },
            ],
          },
        ],
      });

      const storedVendorOrder = await prisma.vendorOrder.findUniqueOrThrow({
        where: { id: order.vendorOrders[0]!.id },
      });

      expect(storedVendorOrder.subtotal).toBeInstanceOf(Prisma.Decimal);
      expect(storedVendorOrder.subtotal.toString()).toBe('47.85');
      expect(typeof storedVendorOrder.subtotal).not.toBe('number');
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 16: Multiple non-seafood order items subtotal sum
  // ---------------------------------------------------------------------------
  describe('Scenario 16: Multiple non-seafood order items exact decimal sum', () => {
    it('correctly aggregates multiple non-seafood line items into exact decimal subtotal', async () => {
      const item1Price = new Prisma.Decimal('15.25');
      const item1Subtotal = item1Price.mul(2); // 30.50

      const item2Price = new Prisma.Decimal('12.33');
      const item2Subtotal = item2Price.mul(3); // 36.99

      const totalSubtotal = item1Subtotal.add(item2Subtotal); // 67.49

      const prod1 = await productsRepo.create({
        vendorId: vendor1.id,
        categoryId: category.id,
        name: `Seasoning Pack ${randomUUID()}`,
        description: 'Seasoning item',
        unit: ProductUnit.PER_ITEM,
        price: 15.25,
        quantityAvailable: 100,
        imageUrl: 'https://example.com/seasoning.jpg',
      });

      const prod2 = await productsRepo.create({
        vendorId: vendor1.id,
        categoryId: category.id,
        name: `Marinade Bottle ${randomUUID()}`,
        description: 'Marinade item',
        unit: ProductUnit.PER_ITEM,
        price: 12.33,
        quantityAvailable: 100,
        imageUrl: 'https://example.com/marinade.jpg',
      });

      const order = await ordersRepo.create({
        customerId: customerUser.id,
        deliveryAddressLine1: '88 Market Street',
        deliveryParish: 'KINGSTON',
        deliveryPhone: '+18765552222',
        currency: 'JMD',
        vendorOrders: [
          {
            vendorId: vendor1.id,
            subtotal: totalSubtotal,
            items: [
              {
                productId: prod1.id,
                productName: prod1.name,
                unitPrice: item1Price,
                unit: ProductUnit.PER_ITEM,
                quantity: 2,
                subtotal: item1Subtotal,
                currency: 'JMD',
              },
              {
                productId: prod2.id,
                productName: prod2.name,
                unitPrice: item2Price,
                unit: ProductUnit.PER_ITEM,
                quantity: 3,
                subtotal: item2Subtotal,
                currency: 'JMD',
              },
            ],
          },
        ],
      });

      const storedVendorOrder = await prisma.vendorOrder.findUniqueOrThrow({
        where: { id: order.vendorOrders[0]!.id },
      });

      expect(storedVendorOrder.subtotal.toString()).toBe('67.49');
      expect(storedVendorOrder.subtotal.equals(new Prisma.Decimal('67.49'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 17: Mixed seafood and non-seafood subtotals
  // ---------------------------------------------------------------------------
  describe('Scenario 17: Mixed seafood and non-seafood order subtotals', () => {
    it('maintains distinct exact decimal subtotals across multiple vendor orders', async () => {
      const seafoodSubtotal = new Prisma.Decimal('185.50');
      const nonSeafoodSubtotal = new Prisma.Decimal('64.25');

      const seafoodProduct = await productsRepo.create({
        vendorId: vendor1.id,
        categoryId: category.id,
        name: `Red Snapper ${randomUUID()}`,
        description: 'Fresh seafood item',
        unit: ProductUnit.PER_POUND,
        price: 92.75,
        quantityAvailable: 50,
        imageUrl: 'https://example.com/snapper.jpg',
      });

      const nonSeafoodProduct = await productsRepo.create({
        vendorId: vendor2.id,
        categoryId: category.id,
        name: `Plantain Chips ${randomUUID()}`,
        description: 'Packaged snack item',
        unit: ProductUnit.PER_ITEM,
        price: 64.25,
        quantityAvailable: 50,
        imageUrl: 'https://example.com/chips.jpg',
      });

      const order = await ordersRepo.create({
        customerId: customerUser.id,
        deliveryAddressLine1: '99 Coastal Way',
        deliveryParish: 'KINGSTON',
        deliveryPhone: '+18765553333',
        currency: 'JMD',
        vendorOrders: [
          {
            vendorId: vendor1.id,
            subtotal: seafoodSubtotal,
            items: [
              {
                productId: seafoodProduct.id,
                productName: seafoodProduct.name,
                unitPrice: new Prisma.Decimal('92.75'),
                unit: ProductUnit.PER_POUND,
                quantity: 2,
                subtotal: seafoodSubtotal,
                currency: 'JMD',
              },
            ],
          },
          {
            vendorId: vendor2.id,
            subtotal: nonSeafoodSubtotal,
            items: [
              {
                productId: nonSeafoodProduct.id,
                productName: nonSeafoodProduct.name,
                unitPrice: nonSeafoodSubtotal,
                unit: ProductUnit.PER_ITEM,
                quantity: 1,
                subtotal: nonSeafoodSubtotal,
                currency: 'JMD',
              },
            ],
          },
        ],
      });

      const vo1 = await prisma.vendorOrder.findUniqueOrThrow({
        where: { id: order.vendorOrders[0]!.id },
      });
      const vo2 = await prisma.vendorOrder.findUniqueOrThrow({
        where: { id: order.vendorOrders[1]!.id },
      });

      expect(vo1.subtotal.toFixed(2)).toBe('185.50');
      expect(vo2.subtotal.toFixed(2)).toBe('64.25');
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 18: B-01 cancellation behavior preservation
  // ---------------------------------------------------------------------------
  describe('Scenario 18: Existing B-01 cancellation behavior preservation', () => {
    it('creates atomic PENDING refund obligation when a paid order is cancelled', async () => {
      const { order, payment } = await createDeliveredAndPaidOrder({
        subtotal: '75.00',
        vendorOrderStatus: 'PENDING',
      });

      // Cancel through OrdersService
      const cancelled = await ordersService.cancelOrder(customerUser.id, order.id);

      expect(cancelled.vendorOrders.every((vo) => vo.status === 'CANCELLED')).toBe(true);

      const dbVendorOrders = await prisma.vendorOrder.findMany({
        where: { orderId: order.id },
      });
      expect(dbVendorOrders.every((vo) => vo.status === 'CANCELLED')).toBe(true);

      const refund = await prisma.refund.findFirstOrThrow({
        where: { paymentId: payment.id },
      });

      expect(refund.status).toBe(RefundStatus.REQUIRED);
      expect(refund.amount.toFixed(2)).toBe('75.00');
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 19: B-02 refund reservation behavior preservation
  // ---------------------------------------------------------------------------
  describe('Scenario 19: Existing B-02 refund reservation behavior preservation', () => {
    it('atomically reserves refund in PROCESSING status and rejects overdraw', async () => {
      const { payment } = await createDeliveredAndPaidOrder({ subtotal: '100.00' });

      // First reservation of 60.00
      const res1 = await refundsRepo.reserveRefund({
        paymentId: payment.id,
        amount: '60.00',
        reason: 'Partial refund reservation',
        idempotencyKey: `decimal_res_a_${randomUUID()}`,
      });

      expect(res1.status).toBe('RESERVED');
      expect(res1.refund?.status).toBe(RefundStatus.PROCESSING);
      expect(res1.refund?.amount.toFixed(2)).toBe('60.00');

      // Second reservation of 50.00 (exceeds 40.00 remaining) -> must be rejected
      const res2 = await refundsRepo.reserveRefund({
        paymentId: payment.id,
        amount: '50.00',
        reason: 'Excess refund reservation',
        idempotencyKey: `decimal_res_b_${randomUUID()}`,
      });

      expect(res2.status).toBe('EXCEEDS_BALANCE');
    });
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 20: Transaction rollback after persistence failure
  // ---------------------------------------------------------------------------
  describe('Scenario 20: Transaction rollback after persistence failure', () => {
    it('rolls back settlement creation atomically when an error occurs inside transaction', async () => {
      const { vendorOrder } = await createDeliveredAndPaidOrder({ subtotal: '120.00' });

      await expect(
        prisma.$transaction(async (tx) => {
          await settlementsRepo.create(
            {
              vendorId: vendor1.id,
              vendorOrderId: vendorOrder.id,
              grossAmount: new Prisma.Decimal('120.00'),
              platformFee: new Prisma.Decimal('18.00'),
              netAmount: new Prisma.Decimal('102.00'),
            },
            tx,
          );

          // Force failure inside transaction
          throw new Error('Simulated atomic persistence rollback failure');
        }),
      ).rejects.toThrow('Simulated atomic persistence rollback failure');

      // Verify no orphaned row was persisted
      const settlement = await prisma.vendorSettlement.findUnique({
        where: { vendorOrderId: vendorOrder.id },
      });
      expect(settlement).toBeNull();
    });
  });
});
