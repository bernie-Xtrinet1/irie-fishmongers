import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
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
  OrderItem,
} from '@prisma/client';
import { randomUUID } from 'crypto';

import { PrismaService } from '../../../database/prisma.service';
import { RefundsRepository } from '../../payments/repositories/refunds.repository';
import { RefundAllocationsRepository } from '../repositories/refund-allocations.repository';
import { RefundAllocationsService } from '../services/refund-allocations.service';
import { VendorSettlementsModule } from '../vendor-settlements.module';

jest.setTimeout(120_000);

describe('D.4B.3B FAILED Refund Terminality & Reversal Integrity Guard (PostgreSQL Suite)', () => {
  let prisma: PrismaService;
  let refundsRepo: RefundsRepository;
  let allocationsRepo: RefundAllocationsRepository;
  let allocationsService: RefundAllocationsService;

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

    category = await prisma.category.upsert({
      where: { slug: 'd4b3b-seafood-cat' },
      update: {},
      create: {
        name: 'D4B3B Seafood Category',
        slug: 'd4b3b-seafood-cat',
      },
    });

    customerUser = await prisma.user.create({
      data: {
        email: `d4b3b_cust_${randomUUID()}@example.com`,
        passwordHash: 'dummy_hash',
        firstName: 'Dana',
        lastName: 'Customer',
      },
    });

    const createVendor = async (suffix: string, parish: Parish) => {
      const user = await prisma.user.create({
        data: {
          email: `d4b3b_v_${suffix}_${randomUUID()}@example.com`,
          passwordHash: 'dummy_hash',
          firstName: 'Vendor',
          lastName: suffix,
        },
      });
      return prisma.vendor.create({
        data: {
          userId: user.id,
          businessName: `D4B3B Vendor ${suffix} ${randomUUID().slice(0, 6)}`,
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
    vendorSubtotals: Array<{ vendor: Vendor; subtotal: string }>;
    paymentAmount?: string;
  }): Promise<{
    order: { id: string };
    payment: { id: string; amount: Prisma.Decimal; status: PaymentStatus };
    vendorOrders: Array<VendorOrder & { items: OrderItem[] }>;
  }> {
    const order = await prisma.order.create({
      data: {
        customerId: customerUser.id,
        deliveryAddressLine1: '10 Harbour St',
        deliveryParish: Parish.KINGSTON,
        deliveryPhone: '+18765550100',
        currency: 'JMD',
      },
    });

    const vendorOrders: Array<VendorOrder & { items: OrderItem[] }> = [];
    let total = new Prisma.Decimal(0);

    for (const vs of options.vendorSubtotals) {
      const amt = new Prisma.Decimal(vs.subtotal);
      total = total.add(amt);
      const product = await prisma.product.create({
        data: {
          vendorId: vs.vendor.id,
          categoryId: category.id,
          name: `Snapper ${randomUUID().slice(0, 6)}`,
          description: 'D4B3B test product',
          unit: ProductUnit.PER_ITEM,
          price: amt,
          quantityAvailable: 50,
          imageUrl: 'https://example.com/fish.jpg',
        },
      });

      const vo = await prisma.vendorOrder.create({
        data: {
          orderId: order.id,
          vendorId: vs.vendor.id,
          subtotal: amt,
          status: VendorOrderStatus.DELIVERED,
          items: {
            create: [
              {
                productId: product.id,
                productName: product.name,
                quantity: 1,
                unitPrice: amt,
                unit: product.unit,
                subtotal: amt,
                currency: 'JMD',
              },
            ],
          },
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

  it('1-5. rejects all non-FAILED transitions out of FAILED via finalizeRefund and updateStatus', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, subtotal: '80.00' }],
    });
    const vo = vendorOrders[0]!;

    const res = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '50.00',
      reason: 'Initial attempt',
      idempotencyKey: `f_term_${randomUUID()}`,
    });
    expect(res.status).toBe('RESERVED');

    await allocationsService.createAllocation({
      refundId: res.refund!.id,
      vendorOrderId: vo.id,
      amount: '50.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    await refundsRepo.finalizeRefund({
      refundId: res.refund!.id,
      paymentId: payment.id,
      status: RefundStatus.FAILED,
      providerReference: 'prov_fail_1',
    });

    const disallowedTargets = [
      RefundStatus.COMPLETED,
      RefundStatus.PROCESSING,
      RefundStatus.PENDING,
      RefundStatus.REQUIRED,
      RefundStatus.RECONCILE_REQUIRED,
    ];

    for (const target of disallowedTargets) {
      await expect(
        refundsRepo.finalizeRefund({
          refundId: res.refund!.id,
          paymentId: payment.id,
          status: target,
          providerReference: `late_${target}`,
        }),
      ).rejects.toThrow(ConflictException);

      await expect(
        refundsRepo.updateStatus(res.refund!.id, target, `upd_${target}`),
      ).rejects.toThrow(ConflictException);
    }

    const freshRefund = await prisma.refund.findUniqueOrThrow({ where: { id: res.refund!.id } });
    const freshPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(freshRefund.status).toBe(RefundStatus.FAILED);
    expect(freshRefund.providerReference).toBe('prov_fail_1');
    expect(freshPayment.status).toBe(PaymentStatus.PAID);
  });

  it('6. handles repeated FAILED -> FAILED consistently and idempotently while rejecting conflicting providerReference', async () => {
    const { payment } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, subtotal: '80.00' }],
    });

    const res = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '30.00',
      reason: 'Idempotent failure',
      idempotencyKey: `f_idem_${randomUUID()}`,
    });
    await refundsRepo.finalizeRefund({
      refundId: res.refund!.id,
      paymentId: payment.id,
      status: RefundStatus.FAILED,
      providerReference: 'fail_ref_A',
    });

    const repeatFin = await refundsRepo.finalizeRefund({
      refundId: res.refund!.id,
      paymentId: payment.id,
      status: RefundStatus.FAILED,
      providerReference: 'fail_ref_A',
    });
    expect(repeatFin.refund.status).toBe(RefundStatus.FAILED);
    expect(repeatFin.paymentStatus).toBe(PaymentStatus.PAID);

    const repeatUpd = await refundsRepo.updateStatus(
      res.refund!.id,
      RefundStatus.FAILED,
      'fail_ref_A',
    );
    expect(repeatUpd.status).toBe(RefundStatus.FAILED);

    await expect(
      refundsRepo.finalizeRefund({
        refundId: res.refund!.id,
        paymentId: payment.id,
        status: RefundStatus.FAILED,
        providerReference: 'fail_ref_B',
      }),
    ).rejects.toThrow(ConflictException);

    await expect(
      refundsRepo.updateStatus(res.refund!.id, RefundStatus.FAILED, 'fail_ref_B'),
    ).rejects.toThrow(ConflictException);
  });

  it('7-8. preserves valid COMPLETED finalizations (PROCESSING/RECONCILE_REQUIRED -> COMPLETED) and leaves allocations untouched on rejected transitions', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, subtotal: '100.00' }],
    });
    const vo = vendorOrders[0]!;

    const rFail = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '40.00',
      reason: 'Failed provisional',
      idempotencyKey: `r_fail_${randomUUID()}`,
    });
    await allocationsService.createAllocation({
      refundId: rFail.refund!.id,
      vendorOrderId: vo.id,
      amount: '40.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    await refundsRepo.finalizeRefund({
      refundId: rFail.refund!.id,
      paymentId: payment.id,
      status: RefundStatus.FAILED,
    });

    await expect(
      refundsRepo.finalizeRefund({
        refundId: rFail.refund!.id,
        paymentId: payment.id,
        status: RefundStatus.COMPLETED,
      }),
    ).rejects.toThrow(ConflictException);

    expect((await allocationsService.getAllocatedTotalByVendorOrderId(vo.id)).toFixed(2)).toBe('0.00');
    expect(await allocationsService.getAllocationsByRefundId(rFail.refund!.id)).toHaveLength(1);

    const rRecon = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '60.00',
      reason: 'Timeout then reconciled',
      idempotencyKey: `r_recon_${randomUUID()}`,
    });
    await refundsRepo.updateStatus(rRecon.refund!.id, RefundStatus.RECONCILE_REQUIRED);
    await allocationsService.createAllocation({
      refundId: rRecon.refund!.id,
      vendorOrderId: vo.id,
      amount: '60.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    const finOk = await refundsRepo.finalizeRefund({
      refundId: rRecon.refund!.id,
      paymentId: payment.id,
      status: RefundStatus.COMPLETED,
      providerReference: `ok_ref_${randomUUID()}`,
    });
    expect(finOk.paymentStatus).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    expect(finOk.totalRefunded.toFixed(2)).toBe('60.00');
    expect((await allocationsService.getAllocatedTotalByVendorOrderId(vo.id)).toFixed(2)).toBe('60.00');
  });

  it('9. blocks the original F-D4B3A-01 200% over-allocation reproduction across finalizeRefund, updateStatus, Prisma update, and SQL', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorSubtotals: [
        { vendor: vendor1, subtotal: '60.00' },
        { vendor: vendor2, subtotal: '60.00' },
      ],
    });
    const vo1 = vendorOrders[0]!;

    const r1 = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '60.00',
      reason: 'Attempt 1',
      idempotencyKey: `f1_${randomUUID()}`,
    });
    await allocationsService.createAllocation({
      refundId: r1.refund!.id,
      vendorOrderId: vo1.id,
      amount: '60.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    await refundsRepo.finalizeRefund({
      refundId: r1.refund!.id,
      paymentId: payment.id,
      status: RefundStatus.FAILED,
    });

    const r2 = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '60.00',
      reason: 'Attempt 2 retry',
      idempotencyKey: `f2_${randomUUID()}`,
    });
    await allocationsService.createAllocation({
      refundId: r2.refund!.id,
      vendorOrderId: vo1.id,
      amount: '60.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    await refundsRepo.finalizeRefund({
      refundId: r2.refund!.id,
      paymentId: payment.id,
      status: RefundStatus.COMPLETED,
      providerReference: `r2_ok_${randomUUID()}`,
    });

    await expect(
      refundsRepo.finalizeRefund({
        refundId: r1.refund!.id,
        paymentId: payment.id,
        status: RefundStatus.COMPLETED,
        providerReference: 'late_success_ref',
      }),
    ).rejects.toThrow(ConflictException);

    await expect(
      refundsRepo.updateStatus(r1.refund!.id, RefundStatus.COMPLETED, 'late_success_ref'),
    ).rejects.toThrow(ConflictException);

    await expect(
      prisma.refund.update({
        where: { id: r1.refund!.id },
        data: { status: RefundStatus.COMPLETED },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "refunds" SET "status" = 'COMPLETED' WHERE "id" = '${r1.refund!.id}'`,
      ),
    ).rejects.toThrow();

    expect((await allocationsRepo.sumByVendorOrderIdDecimal(vo1.id)).toFixed(2)).toBe('60.00');
    expect(
      (await allocationsRepo.sumByVendorOrderIdDecimal(vo1.id, undefined, { includeFailed: true })).toFixed(2),
    ).toBe('120.00');
  });

  it('10. handles concurrent FAILED R1 reactivation attempt and replacement R2 allocation cleanly with 0 deadlocks', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorSubtotals: [
        { vendor: vendor1, subtotal: '60.00' },
        { vendor: vendor2, subtotal: '60.00' },
      ],
    });
    const vo1 = vendorOrders[0]!;

    const r1 = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '60.00',
      reason: 'Concurrent R1',
      idempotencyKey: `conc_r1_${randomUUID()}`,
    });
    await allocationsService.createAllocation({
      refundId: r1.refund!.id,
      vendorOrderId: vo1.id,
      amount: '60.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    await refundsRepo.finalizeRefund({
      refundId: r1.refund!.id,
      paymentId: payment.id,
      status: RefundStatus.FAILED,
    });

    const r2 = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '60.00',
      reason: 'Concurrent R2',
      idempotencyKey: `conc_r2_${randomUUID()}`,
    });

    const [reactivateRes, allocRes] = await Promise.allSettled([
      refundsRepo.finalizeRefund({
        refundId: r1.refund!.id,
        paymentId: payment.id,
        status: RefundStatus.COMPLETED,
        providerReference: 'concurrent_late_r1',
      }),
      allocationsService.createAllocation({
        refundId: r2.refund!.id,
        vendorOrderId: vo1.id,
        amount: '60.00',
        allocationType: RefundAllocationType.CANCELLATION,
      }),
    ]);

    expect(reactivateRes.status).toBe('rejected');
    expect((reactivateRes as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(allocRes.status).toBe('fulfilled');
    expect((await allocationsRepo.sumByVendorOrderIdDecimal(vo1.id)).toFixed(2)).toBe('60.00');
  });

  it('11-18. blocks F-D4B3A-02 direct repository bypass, module export leakage, and direct SQL cross-row reversal/mutation attacks', async () => {
    const exportedTokens = Reflect.getMetadata('exports', VendorSettlementsModule) as unknown[];
    expect(exportedTokens).toContain(RefundAllocationsService);
    expect(exportedTokens).not.toContain(RefundAllocationsRepository);

    const { payment, vendorOrders } = await createOrderGraph({
      vendorSubtotals: [
        { vendor: vendor1, subtotal: '60.00' },
        { vendor: vendor2, subtotal: '60.00' },
      ],
    });
    const vo1 = vendorOrders[0]!;
    const vo2 = vendorOrders[1]!;

    const rMain = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('80.00'),
        reason: 'Primary refund',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `rmain_${randomUUID()}`,
      },
    });
    const rOther = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('40.00'),
        reason: 'Other completed refund',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `rother_${randomUUID()}`,
      },
    });

    const { payment: pay2 } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, subtotal: '50.00' }],
    });
    const rFailedOtherOrder = await prisma.refund.create({
      data: {
        paymentId: pay2.id,
        amount: new Prisma.Decimal('10.00'),
        reason: 'Failed other order refund',
        status: RefundStatus.FAILED,
        idempotencyKey: `rfail_other_${randomUUID()}`,
      },
    });

    const a1 = await allocationsService.createAllocation({
      refundId: rMain.id,
      vendorOrderId: vo1.id,
      orderItemId: vo1.items[0]!.id,
      amount: '60.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    // Exact F-D4B3A-02 reproduction via direct RefundAllocationsRepository.create -> rejected
    await expect(
      allocationsRepo.create({
        refundId: rFailedOtherOrder.id,
        vendorOrderId: vo2.id,
        amount: '-999.00',
        currency: 'JMD',
        allocationType: RefundAllocationType.CUSTOMER_RETURN,
        entryKind: RefundAllocationEntryKind.REVERSAL,
        reversesAllocationId: a1.id,
      }),
    ).rejects.toThrow(BadRequestException);

    // Scenario 11: cross-refund reversal rejected (repo + SQL)
    await expect(
      allocationsRepo.create({
        refundId: rOther.id,
        vendorOrderId: vo1.id,
        orderItemId: vo1.items[0]!.id,
        amount: '-10.00',
        allocationType: RefundAllocationType.CANCELLATION,
        entryKind: RefundAllocationEntryKind.REVERSAL,
        reversesAllocationId: a1.id,
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","orderItemId","componentKey","entryKind","reversesAllocationId","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${rOther.id}','${vo1.id}','${vo1.items[0]!.id}','REV:${a1.id}','REVERSAL','${a1.id}',-10.00,'JMD','CANCELLATION')
      `),
    ).rejects.toThrow();

    // Scenario 12: cross-vendorOrder reversal rejected (repo + SQL)
    await expect(
      allocationsRepo.create({
        refundId: rMain.id,
        vendorOrderId: vo2.id,
        orderItemId: vo1.items[0]!.id,
        amount: '-10.00',
        allocationType: RefundAllocationType.CANCELLATION,
        entryKind: RefundAllocationEntryKind.REVERSAL,
        reversesAllocationId: a1.id,
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","orderItemId","componentKey","entryKind","reversesAllocationId","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${rMain.id}','${vo2.id}','${vo1.items[0]!.id}','REV:${a1.id}','REVERSAL','${a1.id}',-10.00,'JMD','CANCELLATION')
      `),
    ).rejects.toThrow();

    // Scenario 13: oversized reversal rejected (repo + SQL)
    await expect(
      allocationsRepo.create({
        refundId: rMain.id,
        vendorOrderId: vo1.id,
        orderItemId: vo1.items[0]!.id,
        amount: '-60.01',
        allocationType: RefundAllocationType.CANCELLATION,
        entryKind: RefundAllocationEntryKind.REVERSAL,
        reversesAllocationId: a1.id,
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","orderItemId","componentKey","entryKind","reversesAllocationId","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${rMain.id}','${vo1.id}','${vo1.items[0]!.id}','REV:${a1.id}','REVERSAL','${a1.id}',-999.00,'JMD','CANCELLATION')
      `),
    ).rejects.toThrow();

    // Scenario 16: concurrent duplicate reversals via raw SQL -> at most 1 succeeds
    const rawSqlRace = await Promise.allSettled([
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","orderItemId","componentKey","entryKind","reversesAllocationId","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${rMain.id}','${vo1.id}','${vo1.items[0]!.id}','REV:${a1.id}','REVERSAL','${a1.id}',-25.00,'JMD','CANCELLATION')
      `),
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","orderItemId","componentKey","entryKind","reversesAllocationId","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${rMain.id}','${vo1.id}','${vo1.items[0]!.id}','REV:${a1.id}','REVERSAL','${a1.id}',-25.00,'JMD','CANCELLATION')
      `),
    ]);
    expect(rawSqlRace.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rawSqlRace.filter((r) => r.status === 'rejected')).toHaveLength(1);

    const revRow = await prisma.refundVendorOrderAllocation.findUniqueOrThrow({
      where: { reversesAllocationId: a1.id },
    });

    // Scenario 14: reversal of a REVERSAL rejected (service + repo + raw SQL)
    await expect(
      allocationsService.reverseAllocation({ allocationId: revRow.id, reason: 'Chain reversal' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      allocationsRepo.create({
        refundId: rMain.id,
        vendorOrderId: vo1.id,
        orderItemId: vo1.items[0]!.id,
        amount: '-5.00',
        allocationType: RefundAllocationType.CANCELLATION,
        entryKind: RefundAllocationEntryKind.REVERSAL,
        reversesAllocationId: revRow.id,
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","orderItemId","componentKey","entryKind","reversesAllocationId","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${rMain.id}','${vo1.id}','${vo1.items[0]!.id}','REV:${revRow.id}','REVERSAL','${revRow.id}',-5.00,'JMD','CANCELLATION')
      `),
    ).rejects.toThrow();

    // Scenario 15 & 18: duplicate reversal via SQL fails cleanly & direct SQL/Prisma FAILED refund allocation insert + UPDATE identity mutation blocked
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","orderItemId","componentKey","entryKind","reversesAllocationId","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${rMain.id}','${vo1.id}','${vo1.items[0]!.id}','REV:${a1.id}','REVERSAL','${a1.id}',-1.00,'JMD','CANCELLATION')
      `),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","componentKey","entryKind","amount","currency","allocationType")
        VALUES ('${randomUUID()}','${rFailedOtherOrder.id}','${vo1.id}','VO','ALLOCATION',5.00,'JMD','CANCELLATION')
      `),
    ).rejects.toThrow();
    await expect(
      prisma.refundVendorOrderAllocation.update({
        where: { id: revRow.id },
        data: { amount: new Prisma.Decimal('-999.00') },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.refundVendorOrderAllocation.update({
        where: { id: a1.id },
        data: { vendorOrderId: vo2.id },
      }),
    ).rejects.toThrow();
  });

  it('19-20. executes valid partial reversal cleanly and rolls back all partial writes on invalid transitions', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, subtotal: '90.00' }],
    });
    const vo = vendorOrders[0]!;

    const rOk = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '45.00',
      reason: 'Valid partial reversal test',
      idempotencyKey: `r_valid_${randomUUID()}`,
    });
    await refundsRepo.finalizeRefund({
      refundId: rOk.refund!.id,
      paymentId: payment.id,
      status: RefundStatus.COMPLETED,
      providerReference: 'valid_ok_1',
    });

    const orig = await allocationsService.createAllocation({
      refundId: rOk.refund!.id,
      vendorOrderId: vo.id,
      amount: '45.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    const partialRev = await allocationsService.reverseAllocation({
      allocationId: orig.id,
      amount: '15.00',
      reason: 'Partial adjustment reversal',
    });
    expect(new Prisma.Decimal(partialRev.amount).toFixed(2)).toBe('-15.00');
    expect((await allocationsService.getAllocatedTotalByVendorOrderId(vo.id)).toFixed(2)).toBe('30.00');

    // Rollback atomicity check: failed reactivation in a multi-step tx must revert earlier writes in that tx
    const rFail = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '20.00',
      reason: 'Rollback check',
      idempotencyKey: `r_rb_${randomUUID()}`,
    });
    await refundsRepo.finalizeRefund({
      refundId: rFail.refund!.id,
      paymentId: payment.id,
      status: RefundStatus.FAILED,
    });

    const sentinelKey = `rb_sentinel_${randomUUID()}`;
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.refund.create({
          data: {
            paymentId: payment.id,
            amount: new Prisma.Decimal('5.00'),
            reason: 'Should roll back',
            status: RefundStatus.REQUIRED,
            idempotencyKey: sentinelKey,
          },
        });
        await refundsRepo.finalizeRefund(
          {
            refundId: rFail.refund!.id,
            paymentId: payment.id,
            status: RefundStatus.COMPLETED,
          },
          tx,
        );
      }),
    ).rejects.toThrow(ConflictException);

    expect(await refundsRepo.findByIdempotencyKey(sentinelKey)).toBeNull();
    expect((await allocationsService.getAllocatedTotalByVendorOrderId(vo.id)).toFixed(2)).toBe('30.00');
  });
});
