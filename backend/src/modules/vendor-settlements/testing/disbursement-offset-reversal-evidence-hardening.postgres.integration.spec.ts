import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  OrderItem,
  Parish,
  Payment,
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
  VendorReceivableRecoveryType,
  VendorReceivableStatus,
  VendorSettlementDisbursementStatus,
  VendorSettlementStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';

import { PrismaService } from '../../../database/prisma.service';
import { CommissionRateConfigsRepository } from '../repositories/commission-rate-configs.repository';
import { RefundAllocationsRepository } from '../repositories/refund-allocations.repository';
import { VendorReceivablesRepository } from '../repositories/vendor-receivables.repository';
import { VendorSettlementAdjustmentsRepository } from '../repositories/vendor-settlement-adjustments.repository';
import { VendorSettlementsRepository } from '../repositories/vendor-settlements.repository';
import { RefundAllocationsService } from '../services/refund-allocations.service';
import {
  VendorLiabilityCalculatorService,
  VendorSettlementExposureCategory,
} from '../services/vendor-liability-calculator.service';
import { VendorSettlementsService } from '../services/vendor-settlements.service';

jest.setTimeout(180_000);

describe('D.4B.5D Second-Pass Hardening — Disbursement, Reversal, Offset, Evidence & Idempotency (PostgreSQL Suite)', () => {
  let prisma: PrismaService;
  let allocRepo: RefundAllocationsRepository;
  let allocService: RefundAllocationsService;
  let settlementsRepo: VendorSettlementsRepository;
  let adjustmentsRepo: VendorSettlementAdjustmentsRepository;
  let settlementsService: VendorSettlementsService;
  let commissionRepo: CommissionRateConfigsRepository;
  let liabilityCalculator: VendorLiabilityCalculatorService;
  let receivablesRepo: VendorReceivablesRepository;

  let customerUser: User;
  let vendor1: Vendor;
  let vendor2: Vendor;
  let category: { id: string };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    allocRepo = new RefundAllocationsRepository(prisma);
    allocService = new RefundAllocationsService(prisma, allocRepo);
    settlementsRepo = new VendorSettlementsRepository(prisma);
    adjustmentsRepo = new VendorSettlementAdjustmentsRepository(prisma);
    commissionRepo = new CommissionRateConfigsRepository(prisma);
    settlementsService = new VendorSettlementsService(
      settlementsRepo,
      adjustmentsRepo,
      commissionRepo,
      null as any,
      prisma,
    );
    liabilityCalculator = new VendorLiabilityCalculatorService();
    receivablesRepo = new VendorReceivablesRepository(prisma);

    category = await prisma.category.upsert({
      where: { slug: 'd4b5d-hardening-cat' },
      update: {},
      create: {
        name: 'D4B5D Hardening Category',
        slug: 'd4b5d-hardening-cat',
      },
    });

    customerUser = await prisma.user.create({
      data: {
        email: `d4b5d_cust_${randomUUID()}@example.com`,
        passwordHash: 'dummy_hash',
        firstName: 'D4B5D',
        lastName: 'Customer',
      },
    });

    const createVendor = async (suffix: string, parish: Parish) => {
      const user = await prisma.user.create({
        data: {
          email: `d4b5d_v_${suffix}_${randomUUID()}@example.com`,
          passwordHash: 'dummy_hash',
          firstName: 'Vendor',
          lastName: suffix,
        },
      });
      return prisma.vendor.create({
        data: {
          userId: user.id,
          businessName: `D4B5D Vendor ${suffix} ${randomUUID().slice(0, 6)}`,
          parish,
          termsAcceptedAt: new Date(),
        },
      });
    };

    vendor1 = await createVendor('Alpha', Parish.KINGSTON);
    vendor2 = await createVendor('Beta', Parish.ST_ANN);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createOrderGraph(options: {
    vendorSubtotals: Array<{ vendor: Vendor; subtotal: string }>;
    paymentAmount?: string;
    currency?: string;
  }): Promise<{
    order: { id: string; currency: string | null };
    payment: Payment;
    vendorOrders: Array<VendorOrder & { items: OrderItem[] }>;
  }> {
    const currency = options.currency ?? 'JMD';
    const order = await prisma.order.create({
      data: {
        customerId: customerUser.id,
        deliveryAddressLine1: '101 Port Royal Street',
        deliveryParish: Parish.KINGSTON,
        deliveryPhone: '+18765550399',
        currency,
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
          name: `D4B5D Catch ${randomUUID().slice(0, 6)}`,
          description: 'D4B5D test product',
          unit: ProductUnit.PER_ITEM,
          price: amt,
          quantityAvailable: 100,
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
                currency,
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
        currency,
        status: PaymentStatus.PAID,
        initiationStatus: PaymentInitiationStatus.ESTABLISHED,
      },
    });

    return { order, payment, vendorOrders };
  }

  async function confirmSettlementDisbursement(params: {
    settlementId: string;
    vendorId: string;
    amount: string;
    currency?: string;
  }) {
    await settlementsRepo.updateStatus(params.settlementId, VendorSettlementStatus.APPROVED);
    const paid = await settlementsRepo.updateStatus(
      params.settlementId,
      VendorSettlementStatus.PAID,
      { paymentDate: new Date(), notes: 'Confirmed bank wire payout' },
    );
    const disbursement = await prisma.vendorSettlementDisbursement.create({
      data: {
        settlementId: params.settlementId,
        vendorId: params.vendorId,
        amount: new Prisma.Decimal(params.amount),
        currency: params.currency ?? 'JMD',
        status: VendorSettlementDisbursementStatus.CONFIRMED,
        externalReference: `WIRE-${randomUUID().slice(0, 8)}`,
        confirmedAt: new Date(),
        notes: 'Bank wire settled',
      },
    });
    return { paid, disbursement };
  }

  async function recordVendorDetermination(params: {
    allocationId: string;
    decision?: VendorLiabilityDecision;
    category?: VendorLiabilityCategory;
    rationale?: string;
    evidenceReference?: string | null;
  }) {
    return prisma.vendorLiabilityDetermination.create({
      data: {
        allocationId: params.allocationId,
        decision: params.decision ?? VendorLiabilityDecision.VENDOR_RESPONSIBLE,
        category: params.category ?? VendorLiabilityCategory.VENDOR_CANCELLED_ORDER,
        rationale: params.rationale ?? 'Verified fault',
        evidenceReference:
          params.evidenceReference === undefined ? `CASE-${randomUUID().slice(0, 8)}` : params.evidenceReference,
      },
    });
  }

  it('B5D-01: blocks partial $1 disbursement from unlocking $850 receivable, enforces partial coverage cap, and caps disbursements at adjusted entitlement', async () => {
    const g = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, subtotal: '1000.00' }] });
    const s = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: g.vendorOrders[0]!.id,
      grossAmount: '1000.00',
      platformFee: '150.00',
      netAmount: '850.00',
    });

    const { paid, disbursement } = await confirmSettlementDisbursement({
      settlementId: s.id,
      vendorId: vendor1.id,
      amount: '1.00',
    });

    // Calculator recognizes partial disbursement explicitly rather than EXTERNALLY_DISBURSED
    expect(
      liabilityCalculator.classifySettlementExposure(paid, [disbursement], 'JMD'),
    ).toBe(VendorSettlementExposureCategory.PARTIALLY_DISBURSED);

    const r = await prisma.refund.create({
      data: {
        paymentId: g.payment.id,
        amount: new Prisma.Decimal('1000.00'),
        reason: 'Full cancellation after partial payout',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `b5d01_r_${randomUUID()}`,
      },
    });
    const allocFull = await allocService.createAllocation({
      refundId: r.id,
      vendorOrderId: g.vendorOrders[0]!.id,
      amount: '1000.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    await recordVendorDetermination({ allocationId: allocFull.id });

    // Application layer blocks $850 receivable on $1 confirmed disbursement
    await expect(
      receivablesRepo.createReceivable({
        allocationId: allocFull.id,
        vendorId: vendor1.id,
        settlementId: s.id,
        grossAllocatedAmount: '1000.00',
        commissionReversedAmount: '150.00',
        originalAmount: '850.00',
      }),
    ).rejects.toThrow(BadRequestException);

    // Raw SQL bypass also blocked by PostgreSQL trigger
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_receivables"
          ("id","allocationId","vendorId","settlementId","currency","grossAllocatedAmount","commissionReversedAmount","originalAmount","status","updatedAt")
        VALUES ('${randomUUID()}','${allocFull.id}','${vendor1.id}','${s.id}','JMD',1000.00,150.00,850.00,'OPEN',NOW())
      `),
    ).rejects.toThrow();

    // Separate settlement: $10.00 CONFIRMED disbursement covers $8.50 receivable, blocks 2nd $8.50 ($17.00 > $10.00)
    const g2 = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor2, subtotal: '100.00' }] });
    const s2 = await settlementsRepo.create({
      vendorId: vendor2.id,
      vendorOrderId: g2.vendorOrders[0]!.id,
      grossAmount: '100.00',
      platformFee: '15.00',
      netAmount: '85.00',
    });
    await confirmSettlementDisbursement({ settlementId: s2.id, vendorId: vendor2.id, amount: '10.00' });
    const r2 = await prisma.refund.create({
      data: {
        paymentId: g2.payment.id,
        amount: new Prisma.Decimal('20.00'),
        reason: 'Cumulative partial disbursement cap test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `b5d01_r2_${randomUUID()}`,
      },
    });
    const a21 = await allocService.createAllocation({
      refundId: r2.id,
      vendorOrderId: g2.vendorOrders[0]!.id,
      amount: '10.00',
      allocationType: RefundAllocationType.CANCELLATION,
      componentKey: 'PART_1',
    });
    const a22 = await allocService.createAllocation({
      refundId: r2.id,
      vendorOrderId: g2.vendorOrders[0]!.id,
      amount: '10.00',
      allocationType: RefundAllocationType.ITEM_DEFECT,
      componentKey: 'PART_2',
    });
    await recordVendorDetermination({ allocationId: a21.id });
    await recordVendorDetermination({
      allocationId: a22.id,
      category: VendorLiabilityCategory.VENDOR_ITEM_DEFECT,
    });

    const raceReceivables = await Promise.allSettled([
      receivablesRepo.createReceivable({
        allocationId: a21.id,
        vendorId: vendor2.id,
        settlementId: s2.id,
        grossAllocatedAmount: '10.00',
        commissionReversedAmount: '1.50',
        originalAmount: '8.50',
      }),
      receivablesRepo.createReceivable({
        allocationId: a22.id,
        vendorId: vendor2.id,
        settlementId: s2.id,
        grossAllocatedAmount: '10.00',
        commissionReversedAmount: '1.50',
        originalAmount: '8.50',
      }),
    ]);
    expect(raceReceivables.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const s2Receivables = await prisma.vendorReceivable.findMany({ where: { settlementId: s2.id } });
    expect(s2Receivables).toHaveLength(1);

    // Over-disbursement ceiling: $100 net adjusted by -40 => max disbursement = $60
    const g3 = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, subtotal: '100.00' }] });
    const s3 = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: g3.vendorOrders[0]!.id,
      grossAmount: '100.00',
      platformFee: '15.00',
      netAmount: '85.00',
    });
    await adjustmentsRepo.create({
      settlementId: s3.id,
      amount: '-40.00',
      reason: 'Pre-payout adjustment reduces entitlement to 45.00',
    });
    await settlementsRepo.updateStatus(s3.id, VendorSettlementStatus.APPROVED);

    // IN_FLIGHT exceeding $45.00 rejected
    await expect(
      prisma.vendorSettlementDisbursement.create({
        data: {
          settlementId: s3.id,
          vendorId: vendor1.id,
          amount: new Prisma.Decimal('60.00'),
          currency: 'JMD',
          status: VendorSettlementDisbursementStatus.IN_FLIGHT,
        },
      }),
    ).rejects.toThrow();

    await settlementsRepo.updateStatus(s3.id, VendorSettlementStatus.PAID, { paymentDate: new Date() });

    // CONFIRMED without evidence or exceeding $45.00 rejected
    await expect(
      prisma.vendorSettlementDisbursement.create({
        data: {
          settlementId: s3.id,
          vendorId: vendor1.id,
          amount: new Prisma.Decimal('45.00'),
          currency: 'JMD',
          status: VendorSettlementDisbursementStatus.CONFIRMED,
          externalReference: '   ',
          confirmedAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.vendorSettlementDisbursement.create({
        data: {
          settlementId: s3.id,
          vendorId: vendor1.id,
          amount: new Prisma.Decimal('85.00'),
          currency: 'JMD',
          status: VendorSettlementDisbursementStatus.CONFIRMED,
          externalReference: `WIRE-CAP-${randomUUID()}`,
          confirmedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it('B5D-02: blocks reversing an allocation once a VendorReceivable exists and serializes concurrent reversal vs receivable creation', async () => {
    const g = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, subtotal: '100.00' }] });
    const s = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: g.vendorOrders[0]!.id,
      grossAmount: '100.00',
      platformFee: '15.00',
      netAmount: '85.00',
    });
    await confirmSettlementDisbursement({ settlementId: s.id, vendorId: vendor1.id, amount: '85.00' });

    const r = await prisma.refund.create({
      data: {
        paymentId: g.payment.id,
        amount: new Prisma.Decimal('60.00'),
        reason: 'Reversal lock test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `b5d02_r_${randomUUID()}`,
      },
    });
    const aCommitted = await allocService.createAllocation({
      refundId: r.id,
      vendorOrderId: g.vendorOrders[0]!.id,
      amount: '30.00',
      allocationType: RefundAllocationType.CANCELLATION,
      componentKey: 'B5D02_A',
    });
    await recordVendorDetermination({ allocationId: aCommitted.id });

    await receivablesRepo.createReceivable({
      allocationId: aCommitted.id,
      vendorId: vendor1.id,
      settlementId: s.id,
      grossAllocatedAmount: '30.00',
      commissionReversedAmount: '4.50',
      originalAmount: '25.50',
    });

    // App service, repository direct REVERSAL, and raw SQL INSERT all blocked
    await expect(
      allocService.reverseAllocation({
        allocationId: aCommitted.id,
        reason: 'Post-receivable reversal bypass attempt',
      }),
    ).rejects.toThrow(ConflictException);

    await expect(
      allocRepo.create({
        refundId: r.id,
        vendorOrderId: g.vendorOrders[0]!.id,
        componentKey: `REV:${aCommitted.id}`,
        entryKind: RefundAllocationEntryKind.REVERSAL,
        reversesAllocationId: aCommitted.id,
        amount: '-10.00',
        allocationType: RefundAllocationType.CANCELLATION,
        reason: 'Direct partial reversal attempt',
      }),
    ).rejects.toThrow(ConflictException);

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id","refundId","vendorOrderId","componentKey","entryKind","reversesAllocationId","amount","currency","allocationType","reason")
        VALUES ('${randomUUID()}','${r.id}','${g.vendorOrders[0]!.id}','REV:${aCommitted.id}','REVERSAL','${aCommitted.id}',-30.00,'JMD','CANCELLATION','Raw SQL reversal')
      `),
    ).rejects.toThrow();

    // Concurrency: reverseAllocation vs createReceivable on a fresh allocation -> strictly mutual exclusion
    const aRace = await allocService.createAllocation({
      refundId: r.id,
      vendorOrderId: g.vendorOrders[0]!.id,
      amount: '30.00',
      allocationType: RefundAllocationType.ITEM_DEFECT,
      componentKey: 'B5D02_RACE',
    });
    await recordVendorDetermination({
      allocationId: aRace.id,
      category: VendorLiabilityCategory.VENDOR_ITEM_DEFECT,
    });

    const raceOutcomes = await Promise.allSettled([
      allocService.reverseAllocation({
        allocationId: aRace.id,
        reason: 'Concurrent reversal vs receivable',
      }),
      receivablesRepo.createReceivable({
        allocationId: aRace.id,
        vendorId: vendor1.id,
        settlementId: s.id,
        grossAllocatedAmount: '30.00',
        commissionReversedAmount: '4.50',
        originalAmount: '25.50',
      }),
    ]);
    expect(raceOutcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);

    const revCount = await prisma.refundVendorOrderAllocation.count({
      where: { reversesAllocationId: aRace.id },
    });
    const recExists = await prisma.vendorReceivable.findUnique({
      where: { allocationId: aRace.id },
    });
    expect((revCount === 1 && !recExists) || (revCount === 0 && Boolean(recExists))).toBe(true);
  });

  it('B5D-03: blocks insolvent settlement offsets, concurrent over-offsets, and FAIL transition of offset-encumbered settlements', async () => {
    // Setup origin receivable ($510)
    const gOrig = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, subtotal: '600.00' }] });
    const sOrig = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: gOrig.vendorOrders[0]!.id,
      grossAmount: '600.00',
      platformFee: '90.00',
      netAmount: '510.00',
    });
    await confirmSettlementDisbursement({ settlementId: sOrig.id, vendorId: vendor1.id, amount: '510.00' });
    const rOrig = await prisma.refund.create({
      data: {
        paymentId: gOrig.payment.id,
        amount: new Prisma.Decimal('600.00'),
        reason: 'Offset solvency source',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `b5d03_orig_${randomUUID()}`,
      },
    });
    const aOrig = await allocService.createAllocation({
      refundId: rOrig.id,
      vendorOrderId: gOrig.vendorOrders[0]!.id,
      amount: '600.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    await recordVendorDetermination({ allocationId: aOrig.id });
    const receivable = await receivablesRepo.createReceivable({
      allocationId: aOrig.id,
      vendorId: vendor1.id,
      settlementId: sOrig.id,
      grossAllocatedAmount: '600.00',
      commissionReversedAmount: '90.00',
      originalAmount: '510.00',
    });

    // Target settlement S2 with only $425.00 net payable
    const g2 = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, subtotal: '500.00' }] });
    const s2 = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: g2.vendorOrders[0]!.id,
      grossAmount: '500.00',
      platformFee: '75.00',
      netAmount: '425.00',
    });
    await settlementsRepo.updateStatus(s2.id, VendorSettlementStatus.APPROVED);

    // Oversized -$510.00 offset adjustment rejected (both repo & raw SQL)
    await expect(
      adjustmentsRepo.create({
        settlementId: s2.id,
        amount: '-510.00',
        reason: 'Insolvent offset adjustment',
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_settlement_adjustments" ("id","settlementId","amount","reason")
        VALUES ('${randomUUID()}','${s2.id}',-510.00,'Raw SQL insolvent offset')
      `),
    ).rejects.toThrow();

    // Concurrent two -$300.00 offset adjustments against $425.00 settlement -> strictly 1 wins
    const adjRace = await Promise.allSettled([
      adjustmentsRepo.create({ settlementId: s2.id, amount: '-300.00', reason: 'Concurrent offset 1' }),
      adjustmentsRepo.create({ settlementId: s2.id, amount: '-300.00', reason: 'Concurrent offset 2' }),
    ]);
    const winningAdjs = adjRace
      .filter((o): o is PromiseFulfilledResult<any> => o.status === 'fulfilled')
      .map((o) => o.value);
    expect(winningAdjs).toHaveLength(1);

    const adjSumAfterRace = await adjustmentsRepo.sumBySettlementIdDecimal(s2.id);
    expect(new Prisma.Decimal(s2.netAmount).plus(adjSumAfterRace).toString()).toBe('125');

    // Race between SETTLEMENT_OFFSET recovery binding vs updateStatus(s2, 'FAILED')
    const validAdj = winningAdjs[0]!;
    const offsetVsFailRace = await Promise.allSettled([
      receivablesRepo.createRecovery({
        receivableId: receivable.id,
        amount: '300.00',
        recoveryType: VendorReceivableRecoveryType.SETTLEMENT_OFFSET,
        targetAdjustmentId: validAdj.id,
        idempotencyKey: `b5d03_off_${randomUUID()}`,
      }),
      settlementsService.updateStatus(s2.id, VendorSettlementStatus.FAILED, 'Concurrent fail attempt'),
    ]);
    const recAfterRace = await prisma.vendorReceivableRecovery.findUnique({
      where: { targetAdjustmentId: validAdj.id },
    });
    const s2AfterRace = await prisma.vendorSettlement.findUniqueOrThrow({ where: { id: s2.id } });

    if (recAfterRace) {
      expect(s2AfterRace.status).toBe(VendorSettlementStatus.APPROVED);
      expect(offsetVsFailRace[1]!.status).toBe('rejected');

      // Sequential FAIL via service, repository, and raw SQL all blocked
      await expect(
        settlementsService.updateStatus(s2.id, VendorSettlementStatus.FAILED, 'Blocked'),
      ).rejects.toThrow(ConflictException);
      await expect(
        settlementsRepo.updateStatus(s2.id, VendorSettlementStatus.FAILED),
      ).rejects.toThrow(ConflictException);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE "vendor_settlements" SET "status" = 'FAILED' WHERE "id" = '${s2.id}'`),
      ).rejects.toThrow();
    } else {
      expect(s2AfterRace.status).toBe(VendorSettlementStatus.FAILED);
    }
  });

  it('B5D-04 & B5D-05: enforces manual recovery evidence, normalized reference uniqueness, durable idempotency, allocationId adjustment idempotency, and calculator overlap checks', async () => {
    const g = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor2, subtotal: '300.00' }] });
    const s = await settlementsRepo.create({
      vendorId: vendor2.id,
      vendorOrderId: g.vendorOrders[0]!.id,
      grossAmount: '300.00',
      platformFee: '45.00',
      netAmount: '255.00',
    });
    await confirmSettlementDisbursement({ settlementId: s.id, vendorId: vendor2.id, amount: '255.00' });

    const r = await prisma.refund.create({
      data: {
        paymentId: g.payment.id,
        amount: new Prisma.Decimal('200.00'),
        reason: 'Evidence and overlap checks',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `b5d04_r_${randomUUID()}`,
      },
    });
    const a1 = await allocService.createAllocation({
      refundId: r.id,
      vendorOrderId: g.vendorOrders[0]!.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
      componentKey: 'EV_1',
    });
    const a2 = await allocService.createAllocation({
      refundId: r.id,
      vendorOrderId: g.vendorOrders[0]!.id,
      amount: '100.00',
      allocationType: RefundAllocationType.ITEM_DEFECT,
      componentKey: 'EV_2',
    });
    const det1 = await recordVendorDetermination({ allocationId: a1.id });
    await recordVendorDetermination({
      allocationId: a2.id,
      category: VendorLiabilityCategory.VENDOR_ITEM_DEFECT,
    });

    const rec = await receivablesRepo.createReceivable({
      allocationId: a1.id,
      vendorId: vendor2.id,
      settlementId: s.id,
      grossAllocatedAmount: '100.00',
      commissionReversedAmount: '15.00',
      originalAmount: '85.00',
    });

    // B5D-04 Missing/invalid MANUAL_PAYMENT evidence & idempotency blocked in app & raw SQL
    await expect(
      receivablesRepo.createRecovery({
        receivableId: rec.id,
        amount: '20.00',
        recoveryType: VendorReceivableRecoveryType.MANUAL_PAYMENT,
        collectedAt: new Date(),
        idempotencyKey: `k_${randomUUID()}`,
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      receivablesRepo.createRecovery({
        receivableId: rec.id,
        amount: '20.00',
        recoveryType: VendorReceivableRecoveryType.MANUAL_PAYMENT,
        externalReference: 'BANK-REF-01',
        collectedAt: new Date(Date.now() + 3600_000),
        idempotencyKey: `k_${randomUUID()}`,
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      receivablesRepo.createRecovery({
        receivableId: rec.id,
        amount: '20.00',
        recoveryType: VendorReceivableRecoveryType.MANUAL_PAYMENT,
        externalReference: 'BANK-REF-02',
        collectedAt: new Date(),
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_receivable_recoveries" ("id","receivableId","amount","recoveryType","idempotencyKey")
        VALUES ('${randomUUID()}','${rec.id}',20.00,'MANUAL_PAYMENT','raw_missing_ev_${randomUUID()}')
      `),
    ).rejects.toThrow();

    // Concurrent duplicate normalized externalReference ('  BANK-DUP-777 ' vs 'bank-dup-777') -> strictly 1 wins
    const priorRecoveries = await prisma.vendorReceivableRecovery.findMany({
      where: { receivableId: rec.id },
    });
    const priorRecoveredSum = priorRecoveries.reduce(
      (sum, row) => sum.plus(row.amount),
      new Prisma.Decimal('0.00'),
    );
    const dupKey1 = `dup_ext_1_${randomUUID()}`;
    const dupKey2 = `dup_ext_2_${randomUUID()}`;
    const dupRace = await Promise.allSettled([
      receivablesRepo.createRecovery({
        receivableId: rec.id,
        amount: '25.00',
        recoveryType: VendorReceivableRecoveryType.MANUAL_PAYMENT,
        externalReference: '  BANK-DUP-777 ',
        collectedAt: new Date('2026-11-13T10:00:00Z'),
        idempotencyKey: dupKey1,
      }),
      receivablesRepo.createRecovery({
        receivableId: rec.id,
        amount: '25.00',
        recoveryType: VendorReceivableRecoveryType.MANUAL_PAYMENT,
        externalReference: 'bank-dup-777',
        collectedAt: new Date('2026-11-13T10:00:00Z'),
        idempotencyKey: dupKey2,
      }),
    ]);
    const fulfilledOutcomes = dupRace.filter(
      (o): o is PromiseFulfilledResult<any> => o.status === 'fulfilled',
    );
    const rejectedOutcomes = dupRace.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );
    expect(fulfilledOutcomes).toHaveLength(1);
    expect(rejectedOutcomes).toHaveLength(1);
    const rejectedReason = rejectedOutcomes[0]!.reason as {
      status?: number;
      code?: string;
      message?: string;
    };
    expect(
      rejectedReason?.status === 409 || rejectedReason?.code === 'P2002',
    ).toBe(true);
    const savedRecovery = fulfilledOutcomes[0]!.value.recovery;
    expect(savedRecovery.externalReference).toBe(
      savedRecovery.externalReference.trim(),
    );
    expect(savedRecovery.externalReference.trim().toLowerCase()).toBe(
      'bank-dup-777',
    );
    expect(['BANK-DUP-777', 'bank-dup-777']).toContain(
      savedRecovery.externalReference,
    );
    expect([dupKey1, dupKey2]).toContain(savedRecovery.idempotencyKey);
    expect(savedRecovery.collectedAt).not.toBeNull();

    const afterRecoveries = await prisma.vendorReceivableRecovery.findMany({
      where: { receivableId: rec.id },
    });
    expect(afterRecoveries).toHaveLength(priorRecoveries.length + 1);
    const raceRows = afterRecoveries.filter(
      (row) => row.idempotencyKey === dupKey1 || row.idempotencyKey === dupKey2,
    );
    expect(raceRows).toHaveLength(1);
    expect(raceRows[0]!.id).toBe(savedRecovery.id);
    expect(new Prisma.Decimal(raceRows[0]!.amount).toFixed(2)).toBe('25.00');
    const afterRecoveredSum = afterRecoveries.reduce(
      (sum, row) => sum.plus(row.amount),
      new Prisma.Decimal('0.00'),
    );
    expect(afterRecoveredSum.toFixed(2)).toBe(
      priorRecoveredSum.plus('25.00').toFixed(2),
    );

    // Evidence immutability after creation
    await expect(
      prisma.$executeRawUnsafe(`
        UPDATE "vendor_receivable_recoveries"
        SET "externalReference" = 'TAMPERED-REF'
        WHERE "id" = '${savedRecovery.id}'
      `),
    ).rejects.toThrow();

    // B5D-05 Raw SQL & Prisma insert with allocationId non-null and refundId NULL + idempotencyKey NULL/blank blocked
    const gAdj = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor2, subtotal: '100.00' }] });
    const sAdj = await settlementsRepo.create({
      vendorId: vendor2.id,
      vendorOrderId: gAdj.vendorOrders[0]!.id,
      grossAmount: '100.00',
      platformFee: '15.00',
      netAmount: '85.00',
    });
    const rAdj = await prisma.refund.create({
      data: {
        paymentId: gAdj.payment.id,
        amount: new Prisma.Decimal('50.00'),
        reason: 'Allocation-only idempotency check',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `b5d05_r_${randomUUID()}`,
      },
    });
    const aAdj = await allocService.createAllocation({
      refundId: rAdj.id,
      vendorOrderId: gAdj.vendorOrders[0]!.id,
      amount: '50.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_settlement_adjustments" ("id","settlementId","allocationId","amount","reason")
        VALUES ('${randomUUID()}','${sAdj.id}','${aAdj.id}',-10.00,'Missing idempotencyKey')
      `),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_settlement_adjustments" ("id","settlementId","allocationId","amount","reason","idempotencyKey")
        VALUES ('${randomUUID()}','${sAdj.id}','${aAdj.id}',-10.00,'Blank idempotencyKey','   ')
      `),
    ).rejects.toThrow();

    // Calculator overlap with real PG rows rejected cleanly
    expect(() =>
      liabilityCalculator.calculateAllocationLiability({
        settlement: s,
        allocation: a1,
        refund: r,
        determination: det1,
        priorItems: [{ allocation: a1, refund: r, determination: det1 }],
      }),
    ).toThrow(BadRequestException);
  });
});
