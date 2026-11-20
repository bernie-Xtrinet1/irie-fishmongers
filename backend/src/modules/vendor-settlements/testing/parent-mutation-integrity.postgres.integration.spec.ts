import { randomUUID } from 'crypto';
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
  VendorOrder,
  VendorOrderStatus,
  VendorSettlementStatus,
  OrderItem,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { RefundsRepository } from '../../payments/repositories/refunds.repository';
import { RefundAllocationsRepository } from '../repositories/refund-allocations.repository';
import { VendorSettlementAdjustmentsRepository } from '../repositories/vendor-settlement-adjustments.repository';
import { VendorSettlementsRepository } from '../repositories/vendor-settlements.repository';
import { RefundAllocationsService } from '../services/refund-allocations.service';

jest.setTimeout(120_000);

describe('D.4B.6C Phase 1 - Parent Mutation Integrity & Duplicate Trigger Cleanup (PostgreSQL Suite)', () => {
  let prisma: PrismaService;
  let refundsRepo: RefundsRepository;
  let allocationsRepo: RefundAllocationsRepository;
  let allocationsService: RefundAllocationsService;
  let settlementsRepo: VendorSettlementsRepository;
  let adjustmentsRepo: VendorSettlementAdjustmentsRepository;

  let customerUser: User;
  let otherCustomerUser: User;
  let vendor1: Vendor;
  let vendor2: Vendor;
  let category: { id: string };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    refundsRepo = new RefundsRepository(prisma);
    allocationsRepo = new RefundAllocationsRepository(prisma);
    allocationsService = new RefundAllocationsService(prisma, allocationsRepo);
    settlementsRepo = new VendorSettlementsRepository(prisma);
    adjustmentsRepo = new VendorSettlementAdjustmentsRepository(prisma);

    category = await prisma.category.upsert({
      where: { slug: 'd4b6c-parent-mut-cat' },
      update: {},
      create: {
        name: 'D4B6C Parent Mutation Category',
        slug: 'd4b6c-parent-mut-cat',
      },
    });

    const createCust = (label: string) =>
      prisma.user.create({
        data: {
          email: `d4b6c_${label}_${randomUUID()}@example.com`,
          passwordHash: 'hash',
          firstName: label,
          lastName: 'Customer',
        },
      });
    customerUser = await createCust('main');
    otherCustomerUser = await createCust('other');

    const createVendor = async (suffix: string, parish: Parish) => {
      const user = await prisma.user.create({
        data: {
          email: `d4b6c_v_${suffix}_${randomUUID()}@example.com`,
          passwordHash: 'hash',
          firstName: 'Vendor',
          lastName: suffix,
        },
      });
      return prisma.vendor.create({
        data: {
          userId: user.id,
          businessName: `D4B6C Vendor ${suffix} ${randomUUID().slice(0, 6)}`,
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
    paymentStatus?: PaymentStatus;
  }): Promise<{
    order: { id: string };
    payment: { id: string; amount: Prisma.Decimal; status: PaymentStatus };
    vendorOrders: Array<VendorOrder & { items: OrderItem[] }>;
  }> {
    const order = await prisma.order.create({
      data: {
        customerId: customerUser.id,
        deliveryAddressLine1: '20 Parent Integrity Rd',
        deliveryParish: Parish.KINGSTON,
        deliveryPhone: '+18765550177',
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
            description: 'D4B6C test item',
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
        status: options.paymentStatus ?? PaymentStatus.PAID,
        initiationStatus: PaymentInitiationStatus.ESTABLISHED,
      },
    });

    return { order, payment, vendorOrders };
  }

  it('1. Rejects OrderItem subtotal reduction, vendorOrderId reassignment, and financial delete via SQL and Prisma while preserving productName updates', async () => {
    const { order, payment, vendorOrders } = await createOrderGraph({
      vendorSubtotals: [
        { vendor: vendor1, items: ['50.00', '30.00'] },
        { vendor: vendor2, items: ['40.00'] },
      ],
      paymentAmount: '120.00',
    });
    const vo1 = vendorOrders[0]!;
    const vo2 = vendorOrders[1]!;
    const item1 = vo1.items[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('80.00'),
        reason: 'Parent mutation resistance test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `pmi_oi_${randomUUID()}`,
      },
    });

    await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo1.id,
      orderItemId: item1.id,
      amount: '50.00',
      allocationType: RefundAllocationType.ITEM_DEFECT,
    });

    // Direct SQL and Prisma attempts to reduce OrderItem.subtotal below active allocation must fail
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "order_items" SET "subtotal" = 10.00 WHERE "id" = '${item1.id}'`),
    ).rejects.toThrow();

    await expect(
      prisma.orderItem.update({
        where: { id: item1.id },
        data: { subtotal: new Prisma.Decimal('49.99') },
      }),
    ).rejects.toThrow();

    // Direct SQL and Prisma attempts to reassign OrderItem.vendorOrderId across VendorOrders must fail
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "order_items" SET "vendorOrderId" = '${vo2.id}' WHERE "id" = '${item1.id}'`,
      ),
    ).rejects.toThrow();

    await expect(
      prisma.orderItem.update({
        where: { id: item1.id },
        data: { vendorOrderId: vo2.id },
      }),
    ).rejects.toThrow();

    // Quantity and financial delete are also blocked once payment/allocation exists
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "order_items" SET "quantity" = 5 WHERE "id" = '${item1.id}'`),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "order_items" WHERE "id" = '${item1.id}'`),
    ).rejects.toThrow();

    // Non-financial productName update still permitted (provenance compatibility)
    const renamed = await prisma.orderItem.update({
      where: { id: item1.id },
      data: { productName: 'Renamed Snapper' },
    });
    expect(renamed.productName).toBe('Renamed Snapper');

    // Transaction rollback atomicity when OrderItem mutation triggers failure
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: { deliveryPhone: '+18765559999' },
        });
        await tx.$executeRawUnsafe(`UPDATE "order_items" SET "subtotal" = 1.00 WHERE "id" = '${item1.id}'`);
      }),
    ).rejects.toThrow();

    const reloadedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloadedOrder.deliveryPhone).toBe('+18765550177');
    const reloadedItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: item1.id } });
    expect(reloadedItem.subtotal.toFixed(2)).toBe('50.00');
    expect(reloadedItem.vendorOrderId).toBe(vo1.id);
  });

  it('2. Protects Orders, VendorOrders, Payments, and Refunds against parent amount/ownership/status invalidation', async () => {
    const { order, payment, vendorOrders } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, items: ['100.00'] }],
    });
    const vo1 = vendorOrders[0]!;

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "orders" SET "customerId" = '${otherCustomerUser.id}' WHERE "id" = '${order.id}'`,
      ),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "orders" SET "currency" = 'USD' WHERE "id" = '${order.id}'`),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "orders" WHERE "id" = '${order.id}'`),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "vendor_orders" SET "subtotal" = 10.00 WHERE "id" = '${vo1.id}'`),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "payments" SET "status" = 'FAILED' WHERE "id" = '${payment.id}'`),
    ).rejects.toThrow();

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('60.00'),
        reason: 'Refund immutability',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `pmi_ref_${randomUUID()}`,
      },
    });
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "refunds" SET "amount" = 10.00 WHERE "id" = '${refund.id}'`),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "refunds" SET "status" = 'FAILED' WHERE "id" = '${refund.id}'`),
    ).rejects.toThrow();
  });

  it('3. Blocks FAILED refund transitions when downstream VendorSettlementAdjustments exist while preserving unconsumed provisional FAILED flow', async () => {
    const g1 = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, items: ['100.00'] }] });
    const vo1 = g1.vendorOrders[0]!;
    const settlement = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: vo1.id,
      grossAmount: '100.00',
      platformFee: '10.00',
      netAmount: '90.00',
    });

    // Provisional refund WITH unreversed allocation and NO adjustment CAN transition PROCESSING -> FAILED
    const provFail = await refundsRepo.reserveRefund({
      paymentId: g1.payment.id,
      amount: '40.00',
      reason: 'Unconsumed provisional',
      idempotencyKey: `pmi_prov_${randomUUID()}`,
    });
    await allocationsService.createAllocation({
      refundId: provFail.refund!.id,
      vendorOrderId: vo1.id,
      amount: '40.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    const failedOk = await refundsRepo.finalizeRefund({
      refundId: provFail.refund!.id,
      paymentId: g1.payment.id,
      status: RefundStatus.FAILED,
    });
    expect(failedOk.refund.status).toBe(RefundStatus.FAILED);

    // Provisional refund BOUND to a negative VendorSettlementAdjustment MUST NOT transition to FAILED
    const provAdj = await refundsRepo.reserveRefund({
      paymentId: g1.payment.id,
      amount: '50.00',
      reason: 'Bound to settlement adjustment',
      idempotencyKey: `pmi_adj_${randomUUID()}`,
    });
    const boundAlloc = await allocationsService.createAllocation({
      refundId: provAdj.refund!.id,
      vendorOrderId: vo1.id,
      amount: '50.00',
      allocationType: RefundAllocationType.ITEM_DEFECT,
    });
    await adjustmentsRepo.create({
      settlementId: settlement.id,
      amount: '-45.00',
      reason: 'Pending offset clawback',
      idempotencyKey: `pmi_sadj_${randomUUID()}`,
      refundId: provAdj.refund!.id,
      allocationId: boundAlloc.id,
    });

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "refunds" SET "status" = 'FAILED' WHERE "id" = '${provAdj.refund!.id}'`),
    ).rejects.toThrow();
    await expect(
      refundsRepo.finalizeRefund({
        refundId: provAdj.refund!.id,
        paymentId: g1.payment.id,
        status: RefundStatus.FAILED,
      }),
    ).rejects.toThrow();

    const persistedRefund = await prisma.refund.findUniqueOrThrow({ where: { id: provAdj.refund!.id } });
    expect(persistedRefund.status).toBe(RefundStatus.PROCESSING);
  });

  it('4. Serializes concurrent refund-to-FAILED vs settlement-adjustment and concurrent parent-mutation vs allocation inserts with 0 deadlocks', async () => {
    // 4A. Concurrent finalizeRefund(FAILED) vs adjustmentsRepo.create (never commits both FAILED + adjustment)
    for (let i = 0; i < 6; i++) {
      const g = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, items: ['100.00'] }] });
      const vo = g.vendorOrders[0]!;
      const settlement = await settlementsRepo.create({
        vendorId: vendor1.id,
        vendorOrderId: vo.id,
        grossAmount: '100.00',
        platformFee: '10.00',
        netAmount: '90.00',
      });
      const r = await refundsRepo.reserveRefund({
        paymentId: g.payment.id,
        amount: '50.00',
        reason: `Race ${i}`,
        idempotencyKey: `pmi_race_${i}_${randomUUID()}`,
      });
      const a = await allocationsService.createAllocation({
        refundId: r.refund!.id,
        vendorOrderId: vo.id,
        amount: '50.00',
        allocationType: RefundAllocationType.CANCELLATION,
      });

      const results = await Promise.allSettled([
        prisma.$executeRawUnsafe(`UPDATE "refunds" SET "status" = 'FAILED' WHERE "id" = '${r.refund!.id}'`),
        prisma.$executeRawUnsafe(`
          INSERT INTO "vendor_settlement_adjustments" ("id","settlementId","refundId","allocationId","amount","reason","idempotencyKey")
          VALUES ('${randomUUID()}','${settlement.id}','${r.refund!.id}','${a.id}',-45.00,'Concurrent adj','cadj_${i}_${randomUUID()}')
        `),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);

      const finalRefund = await prisma.refund.findUniqueOrThrow({ where: { id: r.refund!.id } });
      const adjCount = await prisma.vendorSettlementAdjustment.count({ where: { refundId: r.refund!.id } });
      expect((finalRefund.status === RefundStatus.FAILED && adjCount === 0) || (finalRefund.status !== RefundStatus.FAILED && adjCount === 1)).toBe(true);
    }

    // 4B. Concurrent OrderItem subtotal mutation vs exact-ceiling OrderItem allocation insert (0 deadlocks)
    const g2 = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, items: ['80.00'] }] });
    const vo2 = g2.vendorOrders[0]!;
    const item2 = vo2.items[0]!;
    const r2 = await prisma.refund.create({
      data: {
        paymentId: g2.payment.id,
        amount: new Prisma.Decimal('80.00'),
        reason: 'Item race',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `pmi_ir_${randomUUID()}`,
      },
    });
    const [mutRes, allocRes] = await Promise.allSettled([
      prisma.$executeRawUnsafe(`UPDATE "order_items" SET "subtotal" = 10.00 WHERE "id" = '${item2.id}'`),
      prisma.refundVendorOrderAllocation.create({
        data: {
          refundId: r2.id,
          vendorOrderId: vo2.id,
          orderItemId: item2.id,
          componentKey: `ITEM:${item2.id}`,
          entryKind: RefundAllocationEntryKind.ALLOCATION,
          amount: new Prisma.Decimal('80.00'),
          currency: 'JMD',
          allocationType: RefundAllocationType.CANCELLATION,
        },
      }),
    ]);
    expect(mutRes.status).toBe('rejected');
    expect(allocRes.status).toBe('fulfilled');
  });

  it('5. Verifies duplicate allocation trigger was removed and single integrity trigger + parent guards are registered', async () => {
    const allocTriggers = await prisma.$queryRawUnsafe<Array<{ tgname: string }>>(`
      SELECT t."tgname"
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'refund_vendor_order_allocations'
        AND NOT t.tgisinternal
      ORDER BY t."tgname" ASC
    `);
    expect(allocTriggers.map((t) => t.tgname)).toEqual([
      'refund_allocation_reversal_integrity_guard',
      'refund_allocations_immutable_guard',
    ]);

    const itemTriggers = await prisma.$queryRawUnsafe<Array<{ tgname: string }>>(`
      SELECT t."tgname"
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'order_items'
        AND NOT t.tgisinternal
      ORDER BY t."tgname" ASC
    `);
    expect(itemTriggers.map((t) => t.tgname)).toEqual([
      'order_items_financial_immutable_guard',
      'trg_prevent_order_item_provenance_mutation',
    ]);

    const orderTriggers = await prisma.$queryRawUnsafe<Array<{ tgname: string }>>(`
      SELECT t."tgname"
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'orders'
        AND NOT t.tgisinternal
      ORDER BY t."tgname" ASC
    `);
    expect(orderTriggers.map((t) => t.tgname)).toEqual([
      'orders_financial_immutable_guard',
    ]);
  });
});
