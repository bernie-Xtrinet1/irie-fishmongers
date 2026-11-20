import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  CatalogueLifecycleStatus,
  FoodSafetyStatus,
  Parish,
  PaymentInitiationStatus,
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  PrismaClient,
  Product,
  ProductUnit,
  Refund,
  RefundAllocationType,
  RefundStatus,
  SeafoodStorageType,
  User,
  Vendor,
  VendorDailyListing,
  VendorOrder,
  VendorOrderStatus,
  VendorSettlement,
  VendorSettlementStatus,
  WeightUnit,
} from '@prisma/client';
import { randomUUID } from 'crypto';

import { PrismaService } from '../../../database/prisma.service';
import { RefundAllocationsRepository } from '../repositories/refund-allocations.repository';
import { VendorSettlementAdjustmentsRepository } from '../repositories/vendor-settlement-adjustments.repository';
import { VendorSettlementsRepository } from '../repositories/vendor-settlements.repository';
import { RefundAllocationsService } from '../services/refund-allocations.service';

describe('Refund Allocation, Retention and Idempotency Foundation (PostgreSQL Integration Suite)', () => {
  let prisma: PrismaService;
  let allocationsRepo: RefundAllocationsRepository;
  let allocationsService: RefundAllocationsService;
  let adjustmentsRepo: VendorSettlementAdjustmentsRepository;
  let settlementsRepo: VendorSettlementsRepository;

  let customerUser: User;
  let vendorUser1: User;
  let vendorUser2: User;
  let vendor1: Vendor;
  let vendor2: Vendor;
  let category: { id: string; name: string; slug: string };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    allocationsRepo = new RefundAllocationsRepository(prisma);
    allocationsService = new RefundAllocationsService(prisma, allocationsRepo);
    adjustmentsRepo = new VendorSettlementAdjustmentsRepository(prisma);
    settlementsRepo = new VendorSettlementsRepository(prisma);

    // Seed master category
    category = await prisma.category.upsert({
      where: { slug: 'foundation-fish-cat' },
      update: {},
      create: {
        name: 'Foundation Fish Cat',
        slug: 'foundation-fish-cat',
      },
    });

    // Customer user
    const custEmail = `cust_${randomUUID()}@example.com`;
    customerUser = await prisma.user.create({
      data: {
        email: custEmail,
        passwordHash: 'dummy_hash',
        firstName: 'Test',
        lastName: 'Customer',
        phone: '+18765550001',
      },
    });

    // Vendor user 1
    const vEmail1 = `v1_${randomUUID()}@example.com`;
    vendorUser1 = await prisma.user.create({
      data: {
        email: vEmail1,
        passwordHash: 'dummy_hash',
        firstName: 'Vendor',
        lastName: 'One',
        phone: '+18765550002',
      },
    });

    vendor1 = await prisma.vendor.create({
      data: {
        userId: vendorUser1.id,
        businessName: `Vendor One ${randomUUID().slice(0, 6)}`,
        parish: Parish.KINGSTON,
        termsAcceptedAt: new Date(),
      },
    });

    // Vendor user 2
    const vEmail2 = `v2_${randomUUID()}@example.com`;
    vendorUser2 = await prisma.user.create({
      data: {
        email: vEmail2,
        passwordHash: 'dummy_hash',
        firstName: 'Vendor',
        lastName: 'Two',
        phone: '+18765550003',
      },
    });

    vendor2 = await prisma.vendor.create({
      data: {
        userId: vendorUser2.id,
        businessName: `Vendor Two ${randomUUID().slice(0, 6)}`,
        parish: Parish.ST_JAMES,
        termsAcceptedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Helper to create an order graph with payments, vendor orders, and optional settlement
  async function createOrderGraph(options: {
    vendorGroups: Array<{ vendor: Vendor; subtotal: string }>;
    paymentStatus?: PaymentStatus;
    currency?: string;
    createSettlements?: boolean;
    vendorOrderStatus?: VendorOrderStatus;
  }): Promise<{
    order: any;
    payment: any;
    vendorOrders: VendorOrder[];
    settlements: VendorSettlement[];
  }> {
    const currency = options.currency ?? 'JMD';
    const voStatus = options.vendorOrderStatus ?? VendorOrderStatus.DELIVERED;
    const paymentStatus = options.paymentStatus ?? PaymentStatus.PAID;

    const totalOrderAmount = options.vendorGroups.reduce(
      (sum, vg) => sum.add(new Prisma.Decimal(vg.subtotal)),
      new Prisma.Decimal(0),
    );

    const order = await prisma.order.create({
      data: {
        customerId: customerUser.id,
        deliveryAddressLine1: '123 Harbour View Road',
        deliveryParish: Parish.KINGSTON,
        deliveryPhone: '+18765550001',
        currency,
      },
    });

    const vendorOrders: VendorOrder[] = [];
    const settlements: VendorSettlement[] = [];

    for (const vg of options.vendorGroups) {
      const product = await prisma.product.create({
        data: {
          vendorId: vg.vendor.id,
          categoryId: category.id,
          name: `Prod ${randomUUID().slice(0, 8)}`,
          description: 'Seafood item',
          unit: ProductUnit.PER_ITEM,
          price: new Prisma.Decimal(vg.subtotal),
          quantityAvailable: 50,
          imageUrl: 'https://example.com/p.jpg',
        },
      });

      const vo = await prisma.vendorOrder.create({
        data: {
          orderId: order.id,
          vendorId: vg.vendor.id,
          subtotal: new Prisma.Decimal(vg.subtotal),
          status: voStatus,
          items: {
            create: {
              productId: product.id,
              productName: product.name,
              quantity: 1,
              unitPrice: new Prisma.Decimal(vg.subtotal),
              unit: product.unit,
              subtotal: new Prisma.Decimal(vg.subtotal),
              currency,
            },
          },
        },
      });
      vendorOrders.push(vo);

      if (options.createSettlements) {
        const grossAmount = new Prisma.Decimal(vg.subtotal);
        const commissionRate = new Prisma.Decimal('0.1500');
        const platformFee = grossAmount.mul(commissionRate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        const netAmount = grossAmount.sub(platformFee);

        const settlement = await settlementsRepo.create({
          vendorId: vg.vendor.id,
          vendorOrderId: vo.id,
          grossAmount,
          platformFee,
          netAmount,
        });
        settlements.push(settlement);
      }
    }

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: PaymentProviderName.WIPAY,
        merchantAccountId: 'default',
        status: paymentStatus,
        initiationStatus: PaymentInitiationStatus.ESTABLISHED,
        amount: totalOrderAmount,
        currency,
        providerReference: `prov_${randomUUID()}`,
      },
    });

    return { order, payment, vendorOrders, settlements };
  }

  // -------------------------------------------------------------------------
  // Scenario 1: Allocation table migration
  // -------------------------------------------------------------------------
  it('Scenario 1: applies migration and verifies refund_vendor_order_allocations schema', async () => {
    const columns: Array<{ column_name: string; is_nullable: string; data_type: string }> =
      await prisma.$queryRaw`
        SELECT column_name, is_nullable, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'refund_vendor_order_allocations'
        ORDER BY column_name ASC;
      `;

    const columnNames = columns.map((c) => c.column_name);
    expect(columnNames).toContain('id');
    expect(columnNames).toContain('refundId');
    expect(columnNames).toContain('vendorOrderId');
    expect(columnNames).toContain('amount');
    expect(columnNames).toContain('currency');
    expect(columnNames).toContain('allocationType');
    expect(columnNames).toContain('reason');
    expect(columnNames).toContain('createdAt');
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Existing adjustment row compatibility
  // -------------------------------------------------------------------------
  it('Scenario 2: allows legacy adjustment rows created without idempotencyKey or refundId', async () => {
    const { settlements } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '100.00' }],
      createSettlements: true,
    });
    const settlement = settlements[0]!;

    const legacyAdj = await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: -15.00,
      reason: 'Legacy manual fee correction',
    });

    expect(legacyAdj.idempotencyKey).toBeNull();
    expect(legacyAdj.refundId).toBeNull();

    const fetched = await adjustmentsRepo.findById(legacyAdj.id);
    expect(fetched?.amount.toFixed(2)).toBe('-15.00');
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Valid single-vendor allocation
  // -------------------------------------------------------------------------
  it('Scenario 3: successfully creates valid single-vendor allocation linking refund to vendor order', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '80.00' }],
    });
    const vo = vendorOrders[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('80.00'),
        reason: 'Full order return',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    const allocation = await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '80.00',
      allocationType: RefundAllocationType.CANCELLATION,
      reason: 'Single vendor full cancellation',
    });

    expect(allocation.id).toBeDefined();
    expect(allocation.refundId).toBe(refund.id);
    expect(allocation.vendorOrderId).toBe(vo.id);
    expect(new Prisma.Decimal(allocation.amount).toFixed(2)).toBe('80.00');
    expect(allocation.currency).toBe('JMD');
    expect(allocation.allocationType).toBe(RefundAllocationType.CANCELLATION);
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Valid multi-vendor allocation
  // -------------------------------------------------------------------------
  it('Scenario 4: creates independent allocations for distinct vendor orders under same order', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorGroups: [
        { vendor: vendor1, subtotal: '45.00' },
        { vendor: vendor2, subtotal: '55.00' },
      ],
    });
    const vo1 = vendorOrders[0]!;
    const vo2 = vendorOrders[1]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Entire multi-vendor order refund',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    const alloc1 = await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo1.id,
      amount: '45.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    const alloc2 = await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo2.id,
      amount: '55.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    expect(alloc1.vendorOrderId).toBe(vo1.id);
    expect(alloc2.vendorOrderId).toBe(vo2.id);

    const refundAllocations = await allocationsRepo.findByRefundId(refund.id);
    expect(refundAllocations).toHaveLength(2);

    const sum = await allocationsRepo.sumByRefundIdDecimal(refund.id);
    expect(sum.toFixed(2)).toBe('100.00');
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Partial refund allocation
  // -------------------------------------------------------------------------
  it('Scenario 5: creates allocation for partial refund strictly bounded by refund amount', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '120.00' }],
    });
    const vo = vendorOrders[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('30.00'),
        reason: 'Partial compensation',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    const allocation = await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '30.00',
      allocationType: RefundAllocationType.ITEM_DEFECT,
    });

    expect(new Prisma.Decimal(allocation.amount).toFixed(2)).toBe('30.00');
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Multiple allocations for one refund
  // -------------------------------------------------------------------------
  it('Scenario 6: allows multiple allocations for one refund with distinct types or target vendor orders', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '150.00' }],
    });
    const vo = vendorOrders[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('60.00'),
        reason: 'Multi-item adjustment',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    const alloc1 = await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '20.00',
      allocationType: RefundAllocationType.ITEM_DEFECT,
    });

    const alloc2 = await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '40.00',
      allocationType: RefundAllocationType.CUSTOMER_RETURN,
    });

    expect(alloc1.id).not.toBe(alloc2.id);
    const sum = await allocationsRepo.sumByRefundIdDecimal(refund.id);
    expect(sum.toFixed(2)).toBe('60.00');
  });

  // -------------------------------------------------------------------------
  // Scenario 7: Duplicate allocation rejection
  // -------------------------------------------------------------------------
  it('Scenario 7: rejects duplicate allocation with identical (refundId, vendorOrderId, allocationType) with P2002', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '100.00' }],
    });
    const vo = vendorOrders[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('50.00'),
        reason: 'Duplicate test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '20.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    let caughtError: any = null;
    try {
      await allocationsService.createAllocation({
        refundId: refund.id,
        vendorOrderId: vo.id,
        amount: '20.00',
        allocationType: RefundAllocationType.CANCELLATION,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError.code).toBe('P2002');
  });

  // -------------------------------------------------------------------------
  // Scenario 8: Concurrent duplicate allocations
  // -------------------------------------------------------------------------
  it('Scenario 8: parallel duplicate allocation attempts yield exactly 1 success and 1 unique constraint rejection', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '100.00' }],
    });
    const vo = vendorOrders[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('50.00'),
        reason: 'Concurrent duplicate test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    const results = await Promise.allSettled([
      allocationsService.createAllocation({
        refundId: refund.id,
        vendorOrderId: vo.id,
        amount: '25.00',
        allocationType: RefundAllocationType.ITEM_DEFECT,
      }),
      allocationsService.createAllocation({
        refundId: refund.id,
        vendorOrderId: vo.id,
        amount: '25.00',
        allocationType: RefundAllocationType.ITEM_DEFECT,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Scenario 9: Concurrent aggregate over-allocation attempts
  // -------------------------------------------------------------------------
  it('Scenario 9: serializes concurrent allocations to strictly prevent exceeding the refund ceiling', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '100.00' }],
    });
    const vo = vendorOrders[0]!;

    // Total refund is 50.00
    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('50.00'),
        reason: 'Ceiling test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    // Two parallel requests attempt 30.00 each (sum 60.00 > 50.00) with DIFFERENT allocation types
    const results = await Promise.allSettled([
      allocationsService.createAllocation({
        refundId: refund.id,
        vendorOrderId: vo.id,
        amount: '30.00',
        allocationType: RefundAllocationType.CANCELLATION,
      }),
      allocationsService.createAllocation({
        refundId: refund.id,
        vendorOrderId: vo.id,
        amount: '30.00',
        allocationType: RefundAllocationType.ITEM_DEFECT,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const totalAllocated = await allocationsRepo.sumByRefundIdDecimal(refund.id);
    expect(totalAllocated.lte(new Prisma.Decimal('50.00'))).toBe(true);
    expect(totalAllocated.toFixed(2)).toBe('30.00');
  });

  // -------------------------------------------------------------------------
  // Scenario 10: Cross-order vendor-order rejection
  // -------------------------------------------------------------------------
  it('Scenario 10: rejects allocation when VendorOrder belongs to a different order than Refund', async () => {
    const graphA = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '60.00' }],
    });
    const graphB = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '70.00' }],
    });

    const refundA = await prisma.refund.create({
      data: {
        paymentId: graphA.payment.id,
        amount: new Prisma.Decimal('60.00'),
        reason: 'Order A refund',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    let caughtError: any = null;
    try {
      await allocationsService.createAllocation({
        refundId: refundA.id,
        vendorOrderId: graphB.vendorOrders[0]!.id, // VendorOrder from Order B!
        amount: '60.00',
        allocationType: RefundAllocationType.CANCELLATION,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(BadRequestException);
    expect(caughtError.message).toContain('do not belong to the same Order');
  });

  // -------------------------------------------------------------------------
  // Scenario 11: Currency mismatch rejection
  // -------------------------------------------------------------------------
  it('Scenario 11: rejects allocation when specified currency does not match payment currency', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '50.00' }],
      currency: 'JMD',
    });
    const vo = vendorOrders[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('50.00'),
        reason: 'Currency test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    let caughtError: any = null;
    try {
      await allocationsService.createAllocation({
        refundId: refund.id,
        vendorOrderId: vo.id,
        amount: '50.00',
        allocationType: RefundAllocationType.CANCELLATION,
        currency: 'USD', // Mismatch!
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(BadRequestException);
    expect(caughtError.message).toContain('does not match payment currency');
  });

  // -------------------------------------------------------------------------
  // Scenario 12: Invalid negative amount rejection
  // -------------------------------------------------------------------------
  it('Scenario 12: rejects negative or zero allocation amounts with BadRequestException', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '50.00' }],
    });
    const vo = vendorOrders[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('50.00'),
        reason: 'Negative test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    await expect(
      allocationsService.createAllocation({
        refundId: refund.id,
        vendorOrderId: vo.id,
        amount: '-10.00',
        allocationType: RefundAllocationType.CANCELLATION,
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      allocationsService.createAllocation({
        refundId: refund.id,
        vendorOrderId: vo.id,
        amount: '0.00',
        allocationType: RefundAllocationType.CANCELLATION,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // -------------------------------------------------------------------------
  // Scenario 13: Decimal precision
  // -------------------------------------------------------------------------
  it('Scenario 13: maintains exact Decimal representation without floating-point precision loss', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '45.55' }],
    });
    const vo = vendorOrders[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('45.55'),
        reason: 'Decimal precision test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    const alloc = await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: new Prisma.Decimal('45.55'),
      allocationType: RefundAllocationType.CANCELLATION,
    });

    const fetched = await allocationsRepo.findById(alloc.id);
    expect(fetched?.amount).toBeInstanceOf(Prisma.Decimal);
    expect(fetched?.amount.toFixed(2)).toBe('45.55');
  });

  // -------------------------------------------------------------------------
  // Scenario 14: Platform-funded component exclusion
  // -------------------------------------------------------------------------
  it('Scenario 14: rejects allocation amount exceeding the vendor order subtotal ceiling', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '40.00' }],
    });
    const vo = vendorOrders[0]!;

    // Suppose refund is 50.00 (e.g. 40.00 vendor subtotal + 10.00 delivery fee)
    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('50.00'),
        reason: 'Full order with delivery fee refund',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    let caughtError: any = null;
    try {
      await allocationsService.createAllocation({
        refundId: refund.id,
        vendorOrderId: vo.id,
        amount: '50.00', // Exceeds vendor order subtotal of 40.00!
        allocationType: RefundAllocationType.CANCELLATION,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(BadRequestException);
    expect(caughtError.message).toContain('exceeds vendor order subtotal');
  });

  // -------------------------------------------------------------------------
  // Scenario 15: Allocation retrieval and aggregation
  // -------------------------------------------------------------------------
  it('Scenario 15: accurately aggregates allocations by refund and vendor order', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorGroups: [
        { vendor: vendor1, subtotal: '60.00' },
        { vendor: vendor2, subtotal: '40.00' },
      ],
    });
    const vo1 = vendorOrders[0]!;
    const vo2 = vendorOrders[1]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('70.00'),
        reason: 'Agg test refund',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo1.id,
      amount: '40.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo2.id,
      amount: '30.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    const sumRefund = await allocationsRepo.sumByRefundIdDecimal(refund.id);
    const sumVo1 = await allocationsRepo.sumByVendorOrderIdDecimal(vo1.id);
    const sumVo2 = await allocationsRepo.sumByVendorOrderIdDecimal(vo2.id);

    expect(sumRefund.toFixed(2)).toBe('70.00');
    expect(sumVo1.toFixed(2)).toBe('40.00');
    expect(sumVo2.toFixed(2)).toBe('30.00');
  });

  // -------------------------------------------------------------------------
  // Scenario 16: Refund deletion restriction
  // -------------------------------------------------------------------------
  it('Scenario 16: blocks deletion of Refund record when referenced by an allocation (ON DELETE RESTRICT)', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '50.00' }],
    });
    const vo = vendorOrders[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('50.00'),
        reason: 'Restriction test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '50.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    let deleteError: any = null;
    try {
      await prisma.refund.delete({ where: { id: refund.id } });
    } catch (err) {
      deleteError = err;
    }

    expect(deleteError).not.toBeNull();
    // Blocked by ON DELETE RESTRICT (P2003) or database immutability trigger
    expect(
      deleteError.code === 'P2003' ||
      String(deleteError).includes('cannot be deleted') ||
      String(deleteError).includes('immutable') ||
      String(deleteError).includes('23514'),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 17: Vendor-order deletion restriction
  // -------------------------------------------------------------------------
  it('Scenario 17: blocks deletion of VendorOrder record when referenced by an allocation (ON DELETE RESTRICT)', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '50.00' }],
    });
    const vo = vendorOrders[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('50.00'),
        reason: 'VO restriction test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '50.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    let deleteError: any = null;
    try {
      await prisma.vendorOrder.delete({ where: { id: vo.id } });
    } catch (err) {
      deleteError = err;
    }

    expect(deleteError).not.toBeNull();
    // Blocked by ON DELETE RESTRICT (P2003) or database immutability trigger
    expect(
      deleteError.code === 'P2003' ||
      String(deleteError).includes('cannot be deleted') ||
      String(deleteError).includes('immutable') ||
      String(deleteError).includes('23514'),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 18: Refund-linked NULL key rejection
  // -------------------------------------------------------------------------
  it('Scenario 18: rejects adjustment creation with non-null refundId and null idempotencyKey', async () => {
    const { payment, settlements } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '80.00' }],
      createSettlements: true,
    });
    const settlement = settlements[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('40.00'),
        reason: 'Null key test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    // 1. Repository-level rejection
    await expect(
      adjustmentsRepo.create({
        settlementId: settlement.id,
        amount: -40.00,
        reason: 'Clawback without key',
        refundId: refund.id,
        idempotencyKey: null,
      }),
    ).rejects.toThrow(BadRequestException);

    // 2. Database CHECK constraint rejection via raw SQL bypass
    let rawError: any = null;
    try {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_settlement_adjustments" ("id", "settlementId", "amount", "reason", "refundId", "idempotencyKey", "createdAt")
        VALUES ('${randomUUID()}', '${settlement.id}', -40.00, 'Raw bypass test', '${refund.id}', NULL, NOW())
      `);
    } catch (err) {
      rawError = err;
    }

    expect(rawError).not.toBeNull();
    expect(rawError.message).toContain('chk_refund_adjustment_idempotency');
  });

  // -------------------------------------------------------------------------
  // Scenario 19: Refund-linked empty key rejection
  // -------------------------------------------------------------------------
  it('Scenario 19: rejects adjustment creation with non-null refundId and empty string idempotencyKey', async () => {
    const { payment, settlements } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '80.00' }],
      createSettlements: true,
    });
    const settlement = settlements[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('30.00'),
        reason: 'Empty key test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    await expect(
      adjustmentsRepo.create({
        settlementId: settlement.id,
        amount: -30.00,
        reason: 'Clawback with empty key',
        refundId: refund.id,
        idempotencyKey: '',
      }),
    ).rejects.toThrow(BadRequestException);

    let rawError: any = null;
    try {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_settlement_adjustments" ("id", "settlementId", "amount", "reason", "refundId", "idempotencyKey", "createdAt")
        VALUES ('${randomUUID()}', '${settlement.id}', -30.00, 'Raw bypass empty key', '${refund.id}', '', NOW())
      `);
    } catch (err) {
      rawError = err;
    }

    expect(rawError).not.toBeNull();
    expect(rawError.message).toContain('chk_refund_adjustment_idempotency');
  });

  // -------------------------------------------------------------------------
  // Scenario 20: Refund-linked whitespace key rejection
  // -------------------------------------------------------------------------
  it('Scenario 20: rejects adjustment creation with non-null refundId and whitespace-only idempotencyKey', async () => {
    const { payment, settlements } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '80.00' }],
      createSettlements: true,
    });
    const settlement = settlements[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('25.00'),
        reason: 'Whitespace key test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    await expect(
      adjustmentsRepo.create({
        settlementId: settlement.id,
        amount: -25.00,
        reason: 'Clawback with whitespace key',
        refundId: refund.id,
        idempotencyKey: '    ',
      }),
    ).rejects.toThrow(BadRequestException);

    let rawError: any = null;
    try {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_settlement_adjustments" ("id", "settlementId", "amount", "reason", "refundId", "idempotencyKey", "createdAt")
        VALUES ('${randomUUID()}', '${settlement.id}', -25.00, 'Raw bypass whitespace', '${refund.id}', '   ', NOW())
      `);
    } catch (err) {
      rawError = err;
    }

    expect(rawError).not.toBeNull();
    expect(rawError.message).toContain('chk_refund_adjustment_idempotency');
  });

  // -------------------------------------------------------------------------
  // Scenario 21: Legacy manual adjustment compatibility
  // -------------------------------------------------------------------------
  it('Scenario 21: confirms legacy manual adjustment (refundId = null, idempotencyKey = null) succeeds and satisfies CHECK constraint', async () => {
    const { settlements } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '100.00' }],
      createSettlements: true,
    });
    const settlement = settlements[0]!;

    const adj = await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: 10.00,
      reason: 'Manual good performance bonus',
      refundId: null,
      idempotencyKey: null,
    });

    expect(adj.id).toBeDefined();
    expect(adj.refundId).toBeNull();
    expect(adj.idempotencyKey).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 22: Concurrent idempotency conflict
  // -------------------------------------------------------------------------
  it('Scenario 22: rejects duplicate adjustment insertions sharing the same idempotencyKey with P2002', async () => {
    const { payment, settlements } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '90.00' }],
      createSettlements: true,
    });
    const settlement = settlements[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('35.00'),
        reason: 'Concurrent idempotency test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    const key = `adj:refund:${refund.id}:settlement:${settlement.id}:CLAWBACK`;

    await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: -35.00,
      reason: 'Original clawback',
      refundId: refund.id,
      idempotencyKey: key,
    });

    let duplicateError: any = null;
    try {
      await adjustmentsRepo.create({
        settlementId: settlement.id,
        amount: -35.00,
        reason: 'Duplicate clawback attempt',
        refundId: refund.id,
        idempotencyKey: key,
      });
    } catch (err) {
      duplicateError = err;
    }

    expect(duplicateError).not.toBeNull();
    expect(duplicateError.code).toBe('P2002');
  });

  // -------------------------------------------------------------------------
  // Scenario 23: Transaction rollback
  // -------------------------------------------------------------------------
  it('Scenario 23: rolls back allocation creation cleanly when error occurs inside transaction', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '70.00' }],
    });
    const vo = vendorOrders[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('70.00'),
        reason: 'Rollback test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    try {
      await prisma.$transaction(async (tx) => {
        await allocationsService.createAllocation(
          {
            refundId: refund.id,
            vendorOrderId: vo.id,
            amount: '35.00',
            allocationType: RefundAllocationType.CANCELLATION,
          },
          tx,
        );

        // Force intentional transaction failure
        throw new Error('Simulated transactional failure');
      });
    } catch {
      // Expected
    }

    const allocations = await allocationsRepo.findByRefundId(refund.id);
    expect(allocations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 24: No automatic clawback creation
  // -------------------------------------------------------------------------
  it('Scenario 24: verifies creating a refund allocation does NOT create any settlement adjustments in this foundation batch', async () => {
    const { payment, vendorOrders, settlements } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '100.00' }],
      createSettlements: true,
    });
    const vo = vendorOrders[0]!;
    const settlement = settlements[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('50.00'),
        reason: 'Passive allocation test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '50.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    const adjustments = await adjustmentsRepo.findBySettlementId(settlement.id);
    expect(adjustments).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 25: No payout or receivable mutation
  // -------------------------------------------------------------------------
  it('Scenario 25: verifies settlement status, netAmount, and adjustedNetAmount remain untouched after allocation creation', async () => {
    const { payment, vendorOrders, settlements } = await createOrderGraph({
      vendorGroups: [{ vendor: vendor1, subtotal: '100.00' }],
      createSettlements: true,
    });
    const vo = vendorOrders[0]!;
    const settlement = settlements[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('50.00'),
        reason: 'Status mutation test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '50.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    const storedSettlement = await settlementsRepo.findById(settlement.id);
    expect(storedSettlement?.status).toBe(VendorSettlementStatus.PENDING);
    expect(storedSettlement?.netAmount.toFixed(2)).toBe(settlement.netAmount.toFixed(2));

    const totalAdjustments = await adjustmentsRepo.sumBySettlementIdDecimal(settlement.id);
    expect(totalAdjustments.isZero()).toBe(true);
  });
});
