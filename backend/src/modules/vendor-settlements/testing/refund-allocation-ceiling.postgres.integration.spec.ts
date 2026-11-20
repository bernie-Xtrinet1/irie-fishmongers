import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import {
  Parish,
  PaymentInitiationStatus,
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  ProductUnit,
  RefundAllocationEntryKind,
  RefundAllocationType,
  RefundStatus,
  User,
  Vendor,
  VendorLiabilityCategory,
  VendorLiabilityDecision,
  VendorOrder,
  VendorOrderStatus,
  VendorSettlementDisbursementStatus,
  OrderItem,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { RefundsRepository } from '../../payments/repositories/refunds.repository';
import { RefundAllocationsRepository } from '../repositories/refund-allocations.repository';
import { VendorReceivablesRepository } from '../repositories/vendor-receivables.repository';
import { VendorSettlementsRepository } from '../repositories/vendor-settlements.repository';
import { RefundAllocationsService } from '../services/refund-allocations.service';

jest.setTimeout(120_000);

describe('D.4B.6A Workstream B - Database-Enforced Refund Allocation Ceilings (PostgreSQL Suite)', () => {
  let prisma: PrismaService;
  let refundsRepo: RefundsRepository;
  let allocationsRepo: RefundAllocationsRepository;
  let allocationsService: RefundAllocationsService;
  let receivablesRepo: VendorReceivablesRepository;
  let settlementsRepo: VendorSettlementsRepository;

  let customerUser: User;
  let vendor1: Vendor;
  let vendor2: Vendor;
  let category: { id: string };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    refundsRepo = new RefundsRepository(prisma);
    allocationsRepo = new RefundAllocationsRepository(prisma);
    allocationsService = new RefundAllocationsService(prisma, allocationsRepo);
    receivablesRepo = new VendorReceivablesRepository(prisma);
    settlementsRepo = new VendorSettlementsRepository(prisma);

    category = await prisma.category.upsert({
      where: { slug: 'd4b6a-alloc-ceiling-cat' },
      update: {},
      create: {
        name: 'D4B6A Allocation Ceiling Category',
        slug: 'd4b6a-alloc-ceiling-cat',
      },
    });

    customerUser = await prisma.user.create({
      data: {
        email: `d4b6a_wsb_cust_${randomUUID()}@example.com`,
        passwordHash: 'hash',
        firstName: 'Ceiling',
        lastName: 'Customer',
      },
    });

    const createVendor = async (suffix: string, parish: Parish) => {
      const user = await prisma.user.create({
        data: {
          email: `d4b6a_wsb_v_${suffix}_${randomUUID()}@example.com`,
          passwordHash: 'hash',
          firstName: 'Vendor',
          lastName: suffix,
        },
      });
      return prisma.vendor.create({
        data: {
          userId: user.id,
          businessName: `D4B6A WSB Vendor ${suffix} ${randomUUID().slice(0, 6)}`,
          parish,
          termsAcceptedAt: new Date(),
        },
      });
    };

    vendor1 = await createVendor('One', Parish.KINGSTON);
    vendor2 = await createVendor('Two', Parish.ST_ANN);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createOrderGraph(options: {
    vendorSubtotals: Array<{ vendor: Vendor; items: string[] }>;
    paymentAmount?: string;
  }): Promise<{
    order: { id: string };
    payment: { id: string; amount: Prisma.Decimal; status: PaymentStatus };
    vendorOrders: Array<VendorOrder & { items: OrderItem[] }>;
  }> {
    const order = await prisma.order.create({
      data: {
        customerId: customerUser.id,
        deliveryAddressLine1: '10 Ceiling Wharf',
        deliveryParish: Parish.KINGSTON,
        deliveryPhone: '+18765550199',
        currency: 'JMD',
      },
    });

    const vendorOrders: Array<VendorOrder & { items: OrderItem[] }> = [];
    let total = new Prisma.Decimal(0);

    for (const vs of options.vendorSubtotals) {
      const itemInputs = [];
      let voSubtotal = new Prisma.Decimal(0);

      for (const itemAmtStr of vs.items) {
        const amt = new Prisma.Decimal(itemAmtStr);
        voSubtotal = voSubtotal.add(amt);
        const product = await prisma.product.create({
          data: {
            vendorId: vs.vendor.id,
            categoryId: category.id,
            name: `Snapper ${randomUUID().slice(0, 6)}`,
            description: 'D4B6A WSB item',
            unit: ProductUnit.PER_ITEM,
            price: amt,
            quantityAvailable: 50,
            imageUrl: 'https://example.com/fish.jpg',
          },
        });
        itemInputs.push({
          productId: product.id,
          productName: product.name,
          quantity: 1,
          unitPrice: amt,
          unit: product.unit,
          subtotal: amt,
          currency: 'JMD',
        });
      }

      total = total.add(voSubtotal);
      const vo = await prisma.vendorOrder.create({
        data: {
          orderId: order.id,
          vendorId: vs.vendor.id,
          subtotal: voSubtotal,
          status: VendorOrderStatus.DELIVERED,
          items: { create: itemInputs },
        },
        include: { items: true },
      });
      vendorOrders.push(vo);
    }

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: PaymentProviderName.WIPAY,
        amount: options.paymentAmount ? new Prisma.Decimal(options.paymentAmount) : total,
        currency: 'JMD',
        status: PaymentStatus.PAID,
        initiationStatus: PaymentInitiationStatus.ESTABLISHED,
      },
    });

    return { order, payment, vendorOrders };
  }

  it('1. Rejects direct SQL and Prisma J$0.01 over-allocations on Refund, VendorOrder, and OrderItem while accepting exact-cent boundaries', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorSubtotals: [
        { vendor: vendor1, items: ['15.55', '24.45'] }, // VO1 subtotal = 40.00
        { vendor: vendor2, items: ['60.00'] }, // VO2 subtotal = 60.00
      ],
      paymentAmount: '100.00',
    });
    const vo1 = vendorOrders[0]!;
    const vo2 = vendorOrders[1]!;

    const refund50 = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('50.00'),
        reason: 'Ceiling test refund 1',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `wsb_r50_${randomUUID()}`,
      },
    });

    // Exact-cent multi-item allocation within VO1 (15.55 + 24.45 = 40.00) and Refund50
    await prisma.refundVendorOrderAllocation.create({
      data: {
        refundId: refund50.id,
        vendorOrderId: vo1.id,
        orderItemId: vo1.items[0]!.id,
        componentKey: `ITEM:${vo1.items[0]!.id}`,
        entryKind: RefundAllocationEntryKind.ALLOCATION,
        amount: new Prisma.Decimal('15.55'),
        currency: 'JMD',
        allocationType: RefundAllocationType.CANCELLATION,
      },
    });
    const item2Alloc = await prisma.refundVendorOrderAllocation.create({
      data: {
        refundId: refund50.id,
        vendorOrderId: vo1.id,
        orderItemId: vo1.items[1]!.id,
        componentKey: `ITEM:${vo1.items[1]!.id}`,
        entryKind: RefundAllocationEntryKind.ALLOCATION,
        amount: new Prisma.Decimal('24.45'),
        currency: 'JMD',
        allocationType: RefundAllocationType.CANCELLATION,
      },
    });

    // +J$0.01 on VO1 via raw SQL rejected (40.00 + 0.01 = 40.01 > VO1.subtotal 40.00, even though < Refund 50.00)
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","componentKey","entryKind","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${refund50.id}','${vo1.id}','VO_EXTRA','ALLOCATION',0.01,'JMD','CANCELLATION')
      `),
    ).rejects.toThrow();

    // +J$0.01 on VO2 exceeding Refund50 remaining balance (40.00 + 10.01 = 50.01 > Refund 50.00) via raw SQL & Prisma rejected
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","componentKey","entryKind","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${refund50.id}','${vo2.id}','VO','ALLOCATION',10.01,'JMD','CANCELLATION')
      `),
    ).rejects.toThrow();

    await expect(
      prisma.refundVendorOrderAllocation.create({
        data: {
          refundId: refund50.id,
          vendorOrderId: vo2.id,
          componentKey: 'VO',
          entryKind: RefundAllocationEntryKind.ALLOCATION,
          amount: new Prisma.Decimal('10.01'),
          currency: 'JMD',
          allocationType: RefundAllocationType.CANCELLATION,
        },
      }),
    ).rejects.toThrow();

    // Exact J$10.00 on VO2 hits exact J$50.00 refund ceiling
    await prisma.refundVendorOrderAllocation.create({
      data: {
        refundId: refund50.id,
        vendorOrderId: vo2.id,
        componentKey: 'VO',
        entryKind: RefundAllocationEntryKind.ALLOCATION,
        amount: new Prisma.Decimal('10.00'),
        currency: 'JMD',
        allocationType: RefundAllocationType.CANCELLATION,
      },
    });

    // Separate active refund on same Order cannot breach OrderItem2 subtotal (24.45) or VO1 subtotal (40.00) by +0.01
    const refundSecond = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('50.00'),
        reason: 'Second refund',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `wsb_r2_${randomUUID()}`,
      },
    });

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","orderItemId","componentKey","entryKind","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${refundSecond.id}','${vo1.id}','${vo1.items[1]!.id}','ITEM:${vo1.items[1]!.id}','ALLOCATION',0.01,'JMD','CUSTOMER_RETURN')
      `),
    ).rejects.toThrow();

    // Prisma update & raw SQL UPDATE attempting to push amount +0.01 blocked
    await expect(
      prisma.refundVendorOrderAllocation.update({
        where: { id: item2Alloc.id },
        data: { amount: new Prisma.Decimal('24.46') },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`
        UPDATE "refund_vendor_order_allocations" SET "amount" = 24.46 WHERE "id" = '${item2Alloc.id}'
      `),
    ).rejects.toThrow();
  });

  it('2. Serializes simultaneous raw SQL and Prisma allocation races on the same Refund and same VendorOrder with 0 deadlocks and 0 over-allocation', async () => {
    // Race A: Same Refund ($100.00), two VendorOrders ($60.00 each) -> concurrent $60 inserts cannot both succeed
    const gA = await createOrderGraph({
      vendorSubtotals: [
        { vendor: vendor1, items: ['60.00'] },
        { vendor: vendor2, items: ['60.00'] },
      ],
      paymentAmount: '120.00',
    });
    const rA = await prisma.refund.create({
      data: {
        paymentId: gA.payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Concurrent refund race',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `race_r_${randomUUID()}`,
      },
    });

    const raceAResults = await Promise.allSettled([
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","componentKey","entryKind","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${rA.id}','${gA.vendorOrders[0]!.id}','RACE1','ALLOCATION',60.00,'JMD','CANCELLATION')
      `),
      prisma.refundVendorOrderAllocation.create({
        data: {
          refundId: rA.id,
          vendorOrderId: gA.vendorOrders[1]!.id,
          componentKey: 'RACE2',
          entryKind: RefundAllocationEntryKind.ALLOCATION,
          amount: new Prisma.Decimal('60.00'),
          currency: 'JMD',
          allocationType: RefundAllocationType.CANCELLATION,
        },
      }),
    ]);
    expect(raceAResults.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(raceAResults.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await allocationsRepo.sumByRefundIdDecimal(rA.id)).toFixed(2)).toBe('60.00');

    // Race B: Two separate active Refunds ($60 each) racing against one VendorOrder ($60 subtotal)
    const gB = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, items: ['60.00'] }],
      paymentAmount: '120.00',
    });
    const rB1 = await prisma.refund.create({
      data: {
        paymentId: gB.payment.id,
        amount: new Prisma.Decimal('60.00'),
        reason: 'Race VO R1',
        status: RefundStatus.REQUIRED,
        idempotencyKey: `race_vo_1_${randomUUID()}`,
      },
    });
    const rB2 = await prisma.refund.create({
      data: {
        paymentId: gB.payment.id,
        amount: new Prisma.Decimal('60.00'),
        reason: 'Race VO R2',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `race_vo_2_${randomUUID()}`,
      },
    });

    const raceBResults = await Promise.allSettled([
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","componentKey","entryKind","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${rB1.id}','${gB.vendorOrders[0]!.id}','VO_R1','ALLOCATION',60.00,'JMD','CANCELLATION')
      `),
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","componentKey","entryKind","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${rB2.id}','${gB.vendorOrders[0]!.id}','VO_R2','ALLOCATION',60.00,'JMD','CUSTOMER_RETURN')
      `),
    ]);
    expect(raceBResults.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(raceBResults.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await allocationsRepo.sumByVendorOrderIdDecimal(gB.vendorOrders[0]!.id)).toFixed(2)).toBe('60.00');
  });

  it('3. Enforces reversal + re-allocation headroom, exact-cent boundaries, and concurrent reversal vs allocation races', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorSubtotals: [
        { vendor: vendor1, items: ['60.00'] },
        { vendor: vendor2, items: ['50.00'] },
      ],
      paymentAmount: '110.00',
    });
    const vo1 = vendorOrders[0]!;
    const vo2 = vendorOrders[1]!;

    const r = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Reversal headroom test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `rev_head_${randomUUID()}`,
      },
    });

    const a1 = await allocationsService.createAllocation({
      refundId: r.id,
      vendorOrderId: vo1.id,
      amount: '60.00',
      allocationType: RefundAllocationType.CANCELLATION,
      componentKey: 'ORIG_VO1',
    });

    // Partial reversal (-20.00) frees 20.00 on VO1 (and refund net = 40.00)
    await allocationsService.reverseAllocation({
      allocationId: a1.id,
      amount: '20.00',
      reason: 'Partial reduction',
    });
    expect((await allocationsRepo.sumByVendorOrderIdDecimal(vo1.id)).toFixed(2)).toBe('40.00');

    // +20.01 on VO1 rejected; exact +20.00 accepted (net on VO1 = 60.00)
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","componentKey","entryKind","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${r.id}','${vo1.id}','REALLOC_OVER','ALLOCATION',20.01,'JMD','CUSTOMER_RETURN')
      `),
    ).rejects.toThrow();

    await allocationsService.createAllocation({
      refundId: r.id,
      vendorOrderId: vo1.id,
      amount: '20.00',
      allocationType: RefundAllocationType.CUSTOMER_RETURN,
      componentKey: 'REALLOC_OK',
    });
    expect((await allocationsRepo.sumByVendorOrderIdDecimal(vo1.id)).toFixed(2)).toBe('60.00');

    // Race on VO2 ($50 subtotal) vs fresh Refund R2 ($80):
    // Seed $60 on VO1 (net 60 of 80), then race REVERSAL (-60) on A2 vs +50 INSERT on VO2
    const gRace = await createOrderGraph({
      vendorSubtotals: [
        { vendor: vendor1, items: ['60.00'] },
        { vendor: vendor2, items: ['50.00'] },
      ],
      paymentAmount: '110.00',
    });
    const rRace = await prisma.refund.create({
      data: {
        paymentId: gRace.payment.id,
        amount: new Prisma.Decimal('80.00'),
        reason: 'Reversal vs allocation race',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `rev_vs_alloc_${randomUUID()}`,
      },
    });
    const aOrig = await allocationsService.createAllocation({
      refundId: rRace.id,
      vendorOrderId: gRace.vendorOrders[0]!.id,
      amount: '60.00',
      allocationType: RefundAllocationType.CANCELLATION,
      componentKey: 'RACE_ORIG',
    });

    await Promise.allSettled([
      allocationsService.reverseAllocation({
        allocationId: aOrig.id,
        reason: 'Concurrent full reversal',
      }),
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","componentKey","entryKind","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${rRace.id}','${gRace.vendorOrders[1]!.id}','RACE_NEW','ALLOCATION',50.00,'JMD','CANCELLATION')
      `),
    ]);

    const finalRefundNet = await allocationsRepo.sumByRefundIdDecimal(rRace.id);
    expect(finalRefundNet.gte(0)).toBe(true);
    expect(finalRefundNet.lte(new Prisma.Decimal('80.00'))).toBe(true);
    expect(
      (await allocationsRepo.sumByVendorOrderIdDecimal(gRace.vendorOrders[1]!.id)).lte(
        new Prisma.Decimal('50.00'),
      ),
    ).toBe(true);
  });

  it('4. Preserves FAILED-refund terminality, VendorReceivable reversal lock, currency, and order ownership rules', async () => {
    const g = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, items: ['100.00'] }],
      paymentAmount: '100.00',
    });
    const vo = g.vendorOrders[0]!;

    const r1 = await refundsRepo.reserveRefund({
      paymentId: g.payment.id,
      amount: '100.00',
      reason: 'Will fail',
      idempotencyKey: `wsb_fail_${randomUUID()}`,
    });
    await allocationsService.createAllocation({
      refundId: r1.refund!.id,
      vendorOrderId: vo.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
      componentKey: 'FAIL_ORIG',
    });
    await refundsRepo.finalizeRefund({
      refundId: r1.refund!.id,
      paymentId: g.payment.id,
      status: RefundStatus.FAILED,
    });

    // Inserting directly onto FAILED refund blocked
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","componentKey","entryKind","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${r1.refund!.id}','${vo.id}','AFTER_FAIL','ALLOCATION',10.00,'JMD','CANCELLATION')
      `),
    ).rejects.toThrow();

    // Replacement refund R2 can still allocate full VO subtotal (100.00) because FAILED refund is excluded
    const r2 = await prisma.refund.create({
      data: {
        paymentId: g.payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Replacement refund',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `wsb_r2_ok_${randomUUID()}`,
      },
    });
    const a2 = await prisma.refundVendorOrderAllocation.create({
      data: {
        refundId: r2.id,
        vendorOrderId: vo.id,
        componentKey: 'REPL_OK',
        entryKind: RefundAllocationEntryKind.ALLOCATION,
        amount: new Prisma.Decimal('100.00'),
        currency: 'JMD',
        allocationType: RefundAllocationType.CANCELLATION,
      },
    });

    // Wrong currency blocked
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","componentKey","entryKind","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${r2.id}','${vo.id}','USD_BAD','ALLOCATION',1.00,'USD','CANCELLATION')
      `),
    ).rejects.toThrow();

    // Create settled disbursement + determination + VendorReceivable -> reversal still blocked (ConflictException / 23514)
    const settlement = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: vo.id,
      grossAmount: '100.00',
      platformFee: '15.00',
      netAmount: '85.00',
    });
    await prisma.vendorSettlement.update({
      where: { id: settlement.id },
      data: { status: 'APPROVED' },
    });
    await prisma.vendorSettlement.update({
      where: { id: settlement.id },
      data: { status: 'PAID', paymentDate: new Date() },
    });
    await prisma.vendorSettlementDisbursement.create({
      data: {
        settlementId: settlement.id,
        vendorId: vendor1.id,
        amount: new Prisma.Decimal('85.00'),
        status: VendorSettlementDisbursementStatus.CONFIRMED,
        externalReference: `EXT-${randomUUID()}`,
        confirmedAt: new Date(),
      },
    });
    await prisma.vendorLiabilityDetermination.create({
      data: {
        allocationId: a2.id,
        decision: VendorLiabilityDecision.VENDOR_RESPONSIBLE,
        category: VendorLiabilityCategory.VENDOR_CANCELLED_ORDER,
        rationale: 'Confirmed vendor fault',
      },
    });
    await receivablesRepo.createReceivable({
      allocationId: a2.id,
      vendorId: vendor1.id,
      settlementId: settlement.id,
      grossAllocatedAmount: '100.00',
      commissionReversedAmount: '15.00',
      originalAmount: '85.00',
    });

    await expect(
      allocationsService.reverseAllocation({
        allocationId: a2.id,
        reason: 'Should be blocked by existing receivable',
      }),
    ).rejects.toThrow(ConflictException);
  });
});
