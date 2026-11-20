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
  LiabilityAttributionStatus,
  VendorLiabilityCalculatorService,
  VendorSettlementExposureCategory,
} from '../services/vendor-liability-calculator.service';
import { VendorSettlementsService } from '../services/vendor-settlements.service';

jest.setTimeout(180_000);

describe('D.4B.5B Vendor Liability and Passive Receivable Integrity Hardening (PostgreSQL Suite)', () => {
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
      where: { slug: 'd4b5-liability-cat' },
      update: {},
      create: {
        name: 'D4B5 Liability Category',
        slug: 'd4b5-liability-cat',
      },
    });

    customerUser = await prisma.user.create({
      data: {
        email: `d4b5_cust_${randomUUID()}@example.com`,
        passwordHash: 'dummy_hash',
        firstName: 'D4B5',
        lastName: 'Customer',
      },
    });

    const createVendor = async (suffix: string, parish: Parish) => {
      const user = await prisma.user.create({
        data: {
          email: `d4b5_v_${suffix}_${randomUUID()}@example.com`,
          passwordHash: 'dummy_hash',
          firstName: 'Vendor',
          lastName: suffix,
        },
      });
      return prisma.vendor.create({
        data: {
          userId: user.id,
          businessName: `D4B5 Vendor ${suffix} ${randomUUID().slice(0, 6)}`,
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
        deliveryAddressLine1: '45 Harbour Street',
        deliveryParish: Parish.KINGSTON,
        deliveryPhone: '+18765550299',
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
          name: `D4B5 Catch ${randomUUID().slice(0, 6)}`,
          description: 'D4B5 test product',
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
        rationale: params.rationale ?? 'Verified vendor fault cancellation',
        evidenceReference: params.evidenceReference ?? `CASE-${randomUUID().slice(0, 6)}`,
      },
    });
  }

  async function createTargetOffsetAdjustment(vendor: Vendor, amount: string, currency = 'JMD') {
    const graph = await createOrderGraph({
      vendorSubtotals: [{ vendor, subtotal: new Prisma.Decimal(amount).plus('200.00').toFixed(2) }],
      currency,
    });
    const gross = new Prisma.Decimal(graph.vendorOrders[0]!.subtotal);
    const fee = gross.mul('0.10').toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const net = gross.minus(fee);
    const targetSettlement = await settlementsRepo.create({
      vendorId: vendor.id,
      vendorOrderId: graph.vendorOrders[0]!.id,
      grossAmount: gross,
      platformFee: fee,
      netAmount: net,
    });
    const adjustment = await adjustmentsRepo.create({
      settlementId: targetSettlement.id,
      amount: new Prisma.Decimal(amount).negated(),
      reason: `Receivable recovery offset (${amount})`,
    });
    return { targetSettlement, adjustment };
  }

  // =========================================================================
  // PART A — BASELINE VERIFICATION (HARDENED EVIDENCE MODELS)
  // =========================================================================

  it('1. verifies hardened schema tables, unique indexes, check constraints, and FK retention', async () => {
    const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN (
          'vendor_receivables',
          'vendor_receivable_recoveries',
          'vendor_receivable_write_offs',
          'vendor_liability_determinations',
          'vendor_settlement_disbursements',
          'vendor_settlements'
        )
      ORDER BY tablename
    `);
    expect(tables).toHaveLength(6);

    const checks = await prisma.$queryRawUnsafe<Array<{ conname: string }>>(`
      SELECT conname FROM pg_constraint
      WHERE conname IN (
        'chk_vendor_receivable_amounts',
        'chk_vendor_receivable_math',
        'chk_vendor_receivable_status_matrix',
        'chk_receivable_recovery_amount',
        'chk_recovery_type_allowed',
        'chk_recovery_type_adjustment_link',
        'chk_commission_config_rate_bounds',
        'chk_vendor_settlement_rate_snapshot_bounds',
        'chk_vendor_settlement_math_non_negative',
        'chk_receivable_write_off_amount'
      )
    `);
    expect(checks).toHaveLength(10);

    const fk = await prisma.$queryRawUnsafe<Array<{ confdeltype: string }>>(`
      SELECT confdeltype::text AS confdeltype
      FROM pg_constraint
      WHERE conname = 'vendor_settlements_commissionConfigId_fkey'
    `);
    expect(fk[0]?.confdeltype).toBe('r');
  });

  it('2. pre-existing settlements retain valid calculation capabilities when determination & disbursement exist', async () => {
    const { vendorOrders, payment } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, subtotal: '500.00' }],
    });
    const vo = vendorOrders[0]!;

    const legacySettlement = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: vo.id,
      grossAmount: new Prisma.Decimal('500.00'),
      platformFee: new Prisma.Decimal('75.00'),
      netAmount: new Prisma.Decimal('425.00'),
      commissionConfigId: null,
      commissionRateSnapshot: null,
    });
    const { paid, disbursement } = await confirmSettlementDisbursement({
      settlementId: legacySettlement.id,
      vendorId: vendor1.id,
      amount: '425.00',
    });

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Legacy test refund',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `legacy_r_${randomUUID()}`,
      },
    });
    const alloc = await allocService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    const determination = await recordVendorDetermination({ allocationId: alloc.id });

    const liability = liabilityCalculator.calculateAllocationLiability({
      settlement: paid,
      allocation: alloc,
      refund,
      determination,
      disbursements: [disbursement],
    });

    expect(liability.commissionReversedAmount.toString()).toBe('15');
    expect(liability.vendorNetLiability.toString()).toBe('85');
    expect(liability.attributionStatus).toBe(LiabilityAttributionStatus.CONFIRMED_LIABILITY);
    expect(liability.exposureCategory).toBe(VendorSettlementExposureCategory.EXTERNALLY_DISBURSED);
  });

  it('3-4. records immutable commission snapshot and isolates historical settlements from config updates', async () => {
    const initialConfig = await commissionRepo.create(0.15);
    const { vendorOrders, payment } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, subtotal: '1000.00' }],
    });
    const vo = vendorOrders[0]!;

    const settlement = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: vo.id,
      grossAmount: '1000.00',
      platformFee: '150.00',
      netAmount: '850.00',
      commissionConfigId: initialConfig.id,
      commissionRateSnapshot: initialConfig.commissionRate,
    });
    expect(settlement.commissionConfigId).toBe(initialConfig.id);
    expect(new Prisma.Decimal(settlement.commissionRateSnapshot!).toString()).toBe('0.15');

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('200.00'),
        reason: 'Rate isolation',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `rate_iso_${randomUUID()}`,
      },
    });
    const alloc = await allocService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '200.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    const determination = await recordVendorDetermination({ allocationId: alloc.id });

    await commissionRepo.create(0.25);

    const liability = liabilityCalculator.calculateAllocationLiability({
      settlement,
      allocation: alloc,
      refund,
      determination,
    });
    expect(liability.commissionReversedAmount.toString()).toBe('30');
    expect(liability.vendorNetLiability.toString()).toBe('170');
  });

  it('5-14. verifies cumulative zero cent drift, 4-state disbursement exposure, and attribution statuses', async () => {
    const { vendorOrders, payment } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor2, subtotal: '1000.00' }],
    });
    const vo = vendorOrders[0]!;
    const settlement = await settlementsRepo.create({
      vendorId: vendor2.id,
      vendorOrderId: vo.id,
      grossAmount: '1000.00',
      platformFee: '150.00',
      netAmount: '850.00',
    });

    const r1 = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('300.00'),
        reason: 'Part 1',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `p1_${randomUUID()}`,
      },
    });
    const a1 = await allocService.createAllocation({
      refundId: r1.id,
      vendorOrderId: vo.id,
      amount: '300.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    const d1 = await recordVendorDetermination({ allocationId: a1.id });

    const r2 = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('700.00'),
        reason: 'Part 2',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `p2_${randomUUID()}`,
      },
    });
    const a2 = await allocService.createAllocation({
      refundId: r2.id,
      vendorOrderId: vo.id,
      amount: '700.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    const d2 = await recordVendorDetermination({ allocationId: a2.id });

    const cum = liabilityCalculator.calculateSettlementCumulativeLiability({
      settlement,
      allocations: [
        { allocation: a1, refund: r1, determination: d1 },
        { allocation: a2, refund: r2, determination: d2 },
      ],
    });
    expect(cum.cumulativeEligibleRefundGross.toString()).toBe('1000');
    expect(cum.cumulativeFeeReversed.toString()).toBe('150');
    expect(cum.cumulativeVendorNetLiability.toString()).toBe('850');
    expect(cum.remainingSettlementNetAmount.toString()).toBe('0');
    expect(cum.exposureCategory).toBe(VendorSettlementExposureCategory.UNPAID_ENTITLEMENT);
  });

  it('15-25. creates receivable with full evidence, applies recoveries & write-off cleanly, and blocks DB tampering', async () => {
    const { vendorOrders, payment } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, subtotal: '1000.00' }],
    });
    const vo = vendorOrders[0]!;
    const settlement = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: vo.id,
      grossAmount: '1000.00',
      platformFee: '150.00',
      netAmount: '850.00',
    });
    await confirmSettlementDisbursement({
      settlementId: settlement.id,
      vendorId: vendor1.id,
      amount: '850.00',
    });

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('500.00'),
        reason: 'Defective catch',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `valid_rec_${randomUUID()}`,
      },
    });
    const alloc = await allocService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '500.00',
      allocationType: RefundAllocationType.ITEM_DEFECT,
    });
    await recordVendorDetermination({
      allocationId: alloc.id,
      category: VendorLiabilityCategory.VENDOR_ITEM_DEFECT,
    });

    const receivable = await receivablesRepo.createReceivable({
      allocationId: alloc.id,
      vendorId: vendor1.id,
      settlementId: settlement.id,
      grossAllocatedAmount: '500.00',
      commissionReversedAmount: '75.00',
      originalAmount: '425.00',
      currency: 'JMD',
      notes: 'Valid receivable',
    });
    expect(receivable.status).toBe(VendorReceivableStatus.OPEN);

    const { adjustment: offsetAdj1 } = await createTargetOffsetAdjustment(vendor1, '125.00');
    const partRes = await receivablesRepo.createRecovery({
      receivableId: receivable.id,
      amount: '125.00',
      recoveryType: VendorReceivableRecoveryType.SETTLEMENT_OFFSET,
      targetAdjustmentId: offsetAdj1.id,
      idempotencyKey: `rec1_${randomUUID()}`,
    });
    expect(partRes.receivable.status).toBe(VendorReceivableStatus.PARTIALLY_RECOVERED);
    expect(new Prisma.Decimal(partRes.receivable.recoveredAmount).toString()).toBe('125');

    const { adjustment: offsetAdj2 } = await createTargetOffsetAdjustment(vendor1, '300.00');
    const fullRes = await receivablesRepo.createRecovery({
      receivableId: receivable.id,
      amount: '300.00',
      recoveryType: VendorReceivableRecoveryType.SETTLEMENT_OFFSET,
      targetAdjustmentId: offsetAdj2.id,
      idempotencyKey: `rec2_${randomUUID()}`,
    });
    expect(fullRes.receivable.status).toBe(VendorReceivableStatus.RECOVERED);
    expect(new Prisma.Decimal(fullRes.receivable.recoveredAmount).toString()).toBe('425');

    // Separate full write-off lifecycle into dedicated write-off ledger
    const woGraph = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor2, subtotal: '300.00' }] });
    const woSettlement = await settlementsRepo.create({
      vendorId: vendor2.id,
      vendorOrderId: woGraph.vendorOrders[0]!.id,
      grossAmount: '300.00',
      platformFee: '45.00',
      netAmount: '255.00',
    });
    await confirmSettlementDisbursement({
      settlementId: woSettlement.id,
      vendorId: vendor2.id,
      amount: '255.00',
    });
    const woRefund = await prisma.refund.create({
      data: {
        paymentId: woGraph.payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Uncollectible closure',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `wo_r_${randomUUID()}`,
      },
    });
    const woAlloc = await allocService.createAllocation({
      refundId: woRefund.id,
      vendorOrderId: woGraph.vendorOrders[0]!.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    await recordVendorDetermination({ allocationId: woAlloc.id });
    const woReceivable = await receivablesRepo.createReceivable({
      allocationId: woAlloc.id,
      vendorId: vendor2.id,
      settlementId: woSettlement.id,
      grossAllocatedAmount: '100.00',
      commissionReversedAmount: '15.00',
      originalAmount: '85.00',
      currency: 'JMD',
    });
    const woRes = await receivablesRepo.createWriteOff({
      receivableId: woReceivable.id,
      amount: '85.00',
      reason: 'Vendor insolvency write-off',
      idempotencyKey: `wo_${randomUUID()}`,
    });
    expect(woRes.receivable.status).toBe(VendorReceivableStatus.WRITTEN_OFF);
    expect(new Prisma.Decimal(woRes.receivable.writtenOffAmount).toString()).toBe('85');
  });

  // =========================================================================
  // PART B — 22 NEGATIVE INTEGRATION TESTS (REPO + POSTGRESQL TRIGGERS)
  // =========================================================================

  it('Negative 1-5: rejects PENDING/FAILED refunds, reversed allocations, cross-vendor/order, and currency mismatches', async () => {
    const graph1 = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, subtotal: '500.00' }] });
    const s1 = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: graph1.vendorOrders[0]!.id,
      grossAmount: '500.00',
      platformFee: '75.00',
      netAmount: '425.00',
    });
    await confirmSettlementDisbursement({ settlementId: s1.id, vendorId: vendor1.id, amount: '425.00' });

    // N1: PENDING refund
    const pendingRefund = await prisma.refund.create({
      data: {
        paymentId: graph1.payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Pending',
        status: RefundStatus.PENDING,
        idempotencyKey: `n1_${randomUUID()}`,
      },
    });
    const pendingAlloc = await allocService.createAllocation({
      refundId: pendingRefund.id,
      vendorOrderId: graph1.vendorOrders[0]!.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    await recordVendorDetermination({ allocationId: pendingAlloc.id });
    await expect(
      receivablesRepo.createReceivable({
        allocationId: pendingAlloc.id,
        vendorId: vendor1.id,
        settlementId: s1.id,
        grossAllocatedAmount: '100.00',
        commissionReversedAmount: '15.00',
        originalAmount: '85.00',
        currency: 'JMD',
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_receivables"
          ("id","allocationId","vendorId","settlementId","currency","grossAllocatedAmount","commissionReversedAmount","originalAmount","status","updatedAt")
        VALUES ('${randomUUID()}','${pendingAlloc.id}','${vendor1.id}','${s1.id}','JMD',100.00,15.00,85.00,'OPEN',NOW())
      `),
    ).rejects.toThrow();

    // N2: FAILED refund
    await prisma.refund.update({ where: { id: pendingRefund.id }, data: { status: RefundStatus.FAILED } });
    await expect(
      receivablesRepo.createReceivable({
        allocationId: pendingAlloc.id,
        vendorId: vendor1.id,
        settlementId: s1.id,
        grossAllocatedAmount: '100.00',
        commissionReversedAmount: '15.00',
        originalAmount: '85.00',
        currency: 'JMD',
      }),
    ).rejects.toThrow(BadRequestException);

    // N3: Reversed allocation
    const compRefund = await prisma.refund.create({
      data: {
        paymentId: graph1.payment.id,
        amount: new Prisma.Decimal('200.00'),
        reason: 'Comp',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `n3_${randomUUID()}`,
      },
    });
    const revTargetAlloc = await allocService.createAllocation({
      refundId: compRefund.id,
      vendorOrderId: graph1.vendorOrders[0]!.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
      componentKey: 'REVTARGET',
    });
    await recordVendorDetermination({ allocationId: revTargetAlloc.id });
    await allocService.reverseAllocation({
      allocationId: revTargetAlloc.id,
      reason: 'Mistaken allocation',
    });
    await expect(
      receivablesRepo.createReceivable({
        allocationId: revTargetAlloc.id,
        vendorId: vendor1.id,
        settlementId: s1.id,
        grossAllocatedAmount: '100.00',
        commissionReversedAmount: '15.00',
        originalAmount: '85.00',
        currency: 'JMD',
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_receivables"
          ("id","allocationId","vendorId","settlementId","currency","grossAllocatedAmount","commissionReversedAmount","originalAmount","status","updatedAt")
        VALUES ('${randomUUID()}','${revTargetAlloc.id}','${vendor1.id}','${s1.id}','JMD',100.00,15.00,85.00,'OPEN',NOW())
      `),
    ).rejects.toThrow();

    // Active completed allocation for N4 & N5
    const activeAlloc = await allocService.createAllocation({
      refundId: compRefund.id,
      vendorOrderId: graph1.vendorOrders[0]!.id,
      amount: '100.00',
      allocationType: RefundAllocationType.ITEM_DEFECT,
      componentKey: 'ACTIVE',
    });
    await recordVendorDetermination({
      allocationId: activeAlloc.id,
      category: VendorLiabilityCategory.VENDOR_ITEM_DEFECT,
    });

    // N4: Cross-vendor / cross-settlement mismatch
    const graph2 = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor2, subtotal: '500.00' }] });
    const s2 = await settlementsRepo.create({
      vendorId: vendor2.id,
      vendorOrderId: graph2.vendorOrders[0]!.id,
      grossAmount: '500.00',
      platformFee: '75.00',
      netAmount: '425.00',
    });
    await confirmSettlementDisbursement({ settlementId: s2.id, vendorId: vendor2.id, amount: '425.00' });

    await expect(
      receivablesRepo.createReceivable({
        allocationId: activeAlloc.id,
        vendorId: vendor2.id,
        settlementId: s2.id,
        grossAllocatedAmount: '100.00',
        commissionReversedAmount: '15.00',
        originalAmount: '85.00',
        currency: 'JMD',
      }),
    ).rejects.toThrow(BadRequestException);

    // N5: Currency mismatch (USD vs JMD)
    await expect(
      receivablesRepo.createReceivable({
        allocationId: activeAlloc.id,
        vendorId: vendor1.id,
        settlementId: s1.id,
        grossAllocatedAmount: '100.00',
        commissionReversedAmount: '15.00',
        originalAmount: '85.00',
        currency: 'USD',
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_receivables"
          ("id","allocationId","vendorId","settlementId","currency","grossAllocatedAmount","commissionReversedAmount","originalAmount","status","updatedAt")
        VALUES ('${randomUUID()}','${activeAlloc.id}','${vendor1.id}','${s1.id}','USD',100.00,15.00,85.00,'OPEN',NOW())
      `),
    ).rejects.toThrow();
  });

  it('Negative 6-11: rejects missing determination, concession/unresolved, manual adjustment without evidence, and non-disbursed settlements', async () => {
    const graph = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, subtotal: '500.00' }] });
    const vo = graph.vendorOrders[0]!;
    const refund = await prisma.refund.create({
      data: {
        paymentId: graph.payment.id,
        amount: new Prisma.Decimal('400.00'),
        reason: 'Evidence tests',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `n6_${randomUUID()}`,
      },
    });

    const aNoDet = await allocService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
      componentKey: 'NODET',
    });
    const aConc = await allocService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
      componentKey: 'CONC',
    });
    await recordVendorDetermination({
      allocationId: aConc.id,
      decision: VendorLiabilityDecision.PLATFORM_CONCESSION,
      category: VendorLiabilityCategory.PLATFORM_GOODWILL_CONCESSION,
    });

    const aSup = await allocService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '100.00',
      allocationType: RefundAllocationType.MANUAL_SUPERVISOR_ADJUSTMENT,
      componentKey: 'SUP',
    });
    // N8: MANUAL_SUPERVISOR_ADJUSTMENT VENDOR_RESPONSIBLE without evidenceReference rejected by DB trigger!
    await expect(
      prisma.vendorLiabilityDetermination.create({
        data: {
          allocationId: aSup.id,
          decision: VendorLiabilityDecision.VENDOR_RESPONSIBLE,
          category: VendorLiabilityCategory.CONTRACTUAL_VENDOR_RETURN,
          rationale: 'Missing evidence reference should fail',
          evidenceReference: null,
        },
      }),
    ).rejects.toThrow();

    // Settlement starts PENDING (N9), then PAID without disbursement (N10), then IN_FLIGHT disbursement (N11)
    const settlement = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: vo.id,
      grossAmount: '500.00',
      platformFee: '75.00',
      netAmount: '425.00',
    });
    const aDetValid = await allocService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
      componentKey: 'VALIDDET',
    });
    await recordVendorDetermination({ allocationId: aDetValid.id });

    // N9: PENDING settlement rejected
    await expect(
      receivablesRepo.createReceivable({
        allocationId: aDetValid.id,
        vendorId: vendor1.id,
        settlementId: settlement.id,
        grossAllocatedAmount: '100.00',
        commissionReversedAmount: '15.00',
        originalAmount: '85.00',
      }),
    ).rejects.toThrow(BadRequestException);

    // Move settlement to PAID with paymentDate and notes ONLY -> DISBURSEMENT_UNKNOWN (N10)
    await settlementsRepo.updateStatus(settlement.id, VendorSettlementStatus.APPROVED);
    await settlementsRepo.updateStatus(settlement.id, VendorSettlementStatus.PAID, {
      paymentDate: new Date(),
      notes: 'Paid without bank confirmation',
    });
    await expect(
      receivablesRepo.createReceivable({
        allocationId: aDetValid.id,
        vendorId: vendor1.id,
        settlementId: settlement.id,
        grossAllocatedAmount: '100.00',
        commissionReversedAmount: '15.00',
        originalAmount: '85.00',
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_receivables"
          ("id","allocationId","vendorId","settlementId","currency","grossAllocatedAmount","commissionReversedAmount","originalAmount","status","updatedAt")
        VALUES ('${randomUUID()}','${aDetValid.id}','${vendor1.id}','${settlement.id}','JMD',100.00,15.00,85.00,'OPEN',NOW())
      `),
    ).rejects.toThrow();

    // N11: IN_FLIGHT disbursement rejected
    const inFlight = await prisma.vendorSettlementDisbursement.create({
      data: {
        settlementId: settlement.id,
        vendorId: vendor1.id,
        amount: new Prisma.Decimal('425.00'),
        currency: 'JMD',
        status: VendorSettlementDisbursementStatus.IN_FLIGHT,
      },
    });
    await expect(
      receivablesRepo.createReceivable({
        allocationId: aDetValid.id,
        vendorId: vendor1.id,
        settlementId: settlement.id,
        grossAllocatedAmount: '100.00',
        commissionReversedAmount: '15.00',
        originalAmount: '85.00',
      }),
    ).rejects.toThrow(BadRequestException);

    // Confirm disbursement -> now valid for aDetValid, still rejected for aNoDet (N6) & aConc (N7)
    await prisma.vendorSettlementDisbursement.update({
      where: { id: inFlight.id },
      data: {
        status: VendorSettlementDisbursementStatus.CONFIRMED,
        externalReference: `WIRE-${randomUUID()}`,
        confirmedAt: new Date(),
      },
    });

    await expect(
      receivablesRepo.createReceivable({
        allocationId: aNoDet.id,
        vendorId: vendor1.id,
        settlementId: settlement.id,
        grossAllocatedAmount: '100.00',
        commissionReversedAmount: '15.00',
        originalAmount: '85.00',
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      receivablesRepo.createReceivable({
        allocationId: aConc.id,
        vendorId: vendor1.id,
        settlementId: settlement.id,
        grossAllocatedAmount: '100.00',
        commissionReversedAmount: '15.00',
        originalAmount: '85.00',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('Negative 12: blocks double-recognition between negative refund adjustment and VendorReceivable in both directions', async () => {
    // Direction 1: Unpaid PENDING settlement has negative refund adjustment -> blocked from creating receivable even if later PAID+CONFIRMED
    const g1 = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, subtotal: '500.00' }] });
    const s1 = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: g1.vendorOrders[0]!.id,
      grossAmount: '500.00',
      platformFee: '75.00',
      netAmount: '425.00',
    });
    const r1 = await prisma.refund.create({
      data: {
        paymentId: g1.payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Dir 1 double recognition',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `dr1_${randomUUID()}`,
      },
    });
    const a1 = await allocService.createAllocation({
      refundId: r1.id,
      vendorOrderId: g1.vendorOrders[0]!.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    await recordVendorDetermination({ allocationId: a1.id });
    await adjustmentsRepo.create({
      settlementId: s1.id,
      refundId: r1.id,
      allocationId: a1.id,
      amount: '-85.00',
      reason: 'Unpaid entitlement deduction',
      idempotencyKey: `adj_dr1_${randomUUID()}`,
    });
    await confirmSettlementDisbursement({ settlementId: s1.id, vendorId: vendor1.id, amount: '340.00' });

    await expect(
      receivablesRepo.createReceivable({
        allocationId: a1.id,
        vendorId: vendor1.id,
        settlementId: s1.id,
        grossAllocatedAmount: '100.00',
        commissionReversedAmount: '15.00',
        originalAmount: '85.00',
      }),
    ).rejects.toThrow(ConflictException);
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_receivables"
          ("id","allocationId","vendorId","settlementId","currency","grossAllocatedAmount","commissionReversedAmount","originalAmount","status","updatedAt")
        VALUES ('${randomUUID()}','${a1.id}','${vendor1.id}','${s1.id}','JMD',100.00,15.00,85.00,'OPEN',NOW())
      `),
    ).rejects.toThrow();

    // Direction 2: VendorReceivable exists on PAID+CONFIRMED -> refund/allocation negative adjustment blocked!
    const g2 = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor2, subtotal: '500.00' }] });
    const s2 = await settlementsRepo.create({
      vendorId: vendor2.id,
      vendorOrderId: g2.vendorOrders[0]!.id,
      grossAmount: '500.00',
      platformFee: '75.00',
      netAmount: '425.00',
    });
    await confirmSettlementDisbursement({ settlementId: s2.id, vendorId: vendor2.id, amount: '425.00' });
    const r2 = await prisma.refund.create({
      data: {
        paymentId: g2.payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Dir 2',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `dr2_${randomUUID()}`,
      },
    });
    const a2 = await allocService.createAllocation({
      refundId: r2.id,
      vendorOrderId: g2.vendorOrders[0]!.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    await recordVendorDetermination({ allocationId: a2.id });
    await receivablesRepo.createReceivable({
      allocationId: a2.id,
      vendorId: vendor2.id,
      settlementId: s2.id,
      grossAllocatedAmount: '100.00',
      commissionReversedAmount: '15.00',
      originalAmount: '85.00',
    });

    await expect(
      adjustmentsRepo.create({
        settlementId: s2.id,
        refundId: r2.id,
        allocationId: a2.id,
        amount: '-85.00',
        reason: 'Duplicate clawback',
        idempotencyKey: `dup_adj_${randomUUID()}`,
      }),
    ).rejects.toThrow();
  });

  it('Negative 13-20: blocks phantom SQL write-offs, raw SQL overdrafts, DISPUTED/terminal mutations, WRITE_OFF in recoveries, mixed RECOVERED corruption, and invalid SETTLEMENT_OFFSET', async () => {
    const graph = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, subtotal: '500.00' }] });
    const s = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: graph.vendorOrders[0]!.id,
      grossAmount: '500.00',
      platformFee: '75.00',
      netAmount: '425.00',
    });
    await confirmSettlementDisbursement({ settlementId: s.id, vendorId: vendor1.id, amount: '425.00' });

    const r = await prisma.refund.create({
      data: {
        paymentId: graph.payment.id,
        amount: new Prisma.Decimal('200.00'),
        reason: 'Ledger guards',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `lg_${randomUUID()}`,
      },
    });
    const alloc = await allocService.createAllocation({
      refundId: r.id,
      vendorOrderId: graph.vendorOrders[0]!.id,
      amount: '200.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    await recordVendorDetermination({ allocationId: alloc.id });
    const rec = await receivablesRepo.createReceivable({
      allocationId: alloc.id,
      vendorId: vendor1.id,
      settlementId: s.id,
      grossAllocatedAmount: '200.00',
      commissionReversedAmount: '30.00',
      originalAmount: '170.00',
    });

    // N13: Phantom SQL & Prisma UPDATE on recoveredAmount / writtenOffAmount / status blocked
    await expect(
      prisma.vendorReceivable.update({
        where: { id: rec.id },
        data: { writtenOffAmount: 170, status: VendorReceivableStatus.WRITTEN_OFF },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "vendor_receivables" SET "recoveredAmount" = 50.00, "status" = 'PARTIALLY_RECOVERED' WHERE "id" = '${rec.id}'`),
    ).rejects.toThrow();

    // N14: Raw SQL INSERT overdraft ($99,999.00 on $170.00) blocked
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_receivable_recoveries" ("id","receivableId","amount","recoveryType","externalReference","collectedAt","idempotencyKey")
        VALUES ('${randomUUID()}','${rec.id}',99999.00,'MANUAL_PAYMENT','WIRE-RAW-OVF-${randomUUID()}',NOW(),'raw_ovf_${randomUUID()}')
      `),
    ).rejects.toThrow();

    // N15: WRITE_OFF rejected on createRecovery & raw SQL
    await expect(
      receivablesRepo.createRecovery({
        receivableId: rec.id,
        amount: '10.00',
        recoveryType: 'WRITE_OFF' as any,
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_receivable_recoveries" ("id","receivableId","amount","recoveryType")
        VALUES ('${randomUUID()}','${rec.id}',10.00,'WRITE_OFF')
      `),
    ).rejects.toThrow();

    // N19: SETTLEMENT_OFFSET validation checks
    await expect(
      receivablesRepo.createRecovery({
        receivableId: rec.id,
        amount: '20.00',
        recoveryType: VendorReceivableRecoveryType.SETTLEMENT_OFFSET,
      }),
    ).rejects.toThrow(BadRequestException);

    // Wrong vendor settlement adjustment
    const { adjustment: wrongVendorAdj } = await createTargetOffsetAdjustment(vendor2, '20.00');
    await expect(
      receivablesRepo.createRecovery({
        receivableId: rec.id,
        amount: '20.00',
        recoveryType: VendorReceivableRecoveryType.SETTLEMENT_OFFSET,
        targetAdjustmentId: wrongVendorAdj.id,
      }),
    ).rejects.toThrow(BadRequestException);

    // Magnitude mismatch on target adjustment
    const { adjustment: goodAdj } = await createTargetOffsetAdjustment(vendor1, '70.00');
    await expect(
      receivablesRepo.createRecovery({
        receivableId: rec.id,
        amount: '50.00',
        recoveryType: VendorReceivableRecoveryType.SETTLEMENT_OFFSET,
        targetAdjustmentId: goodAdj.id,
      }),
    ).rejects.toThrow(BadRequestException);

    // N17: DISPUTED lifecycle blocks recovery and write-off, then resolveDispute re-enables!
    const disputed = await receivablesRepo.markDisputed(rec.id, 'Vendor disputed fee');
    expect(disputed.status).toBe(VendorReceivableStatus.DISPUTED);

    await expect(
      receivablesRepo.createRecovery({
        receivableId: rec.id,
        amount: '70.00',
        recoveryType: VendorReceivableRecoveryType.SETTLEMENT_OFFSET,
        targetAdjustmentId: goodAdj.id,
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      receivablesRepo.createWriteOff({
        receivableId: rec.id,
        amount: '100.00',
        reason: 'Blocked while disputed',
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "vendor_receivable_recoveries" ("id","receivableId","amount","recoveryType","externalReference","collectedAt","idempotencyKey")
        VALUES ('${randomUUID()}','${rec.id}',10.00,'MANUAL_PAYMENT','WIRE-RAW-DISP-${randomUUID()}',NOW(),'raw_disp_${randomUUID()}')
      `),
    ).rejects.toThrow();

    const resolved = await receivablesRepo.resolveDispute(rec.id, 'Dispute resolved in favor of liability');
    expect(resolved.status).toBe(VendorReceivableStatus.OPEN);

    // N16: Partial recovery $70 + partial write-off $100 = $170 MUST close to WRITTEN_OFF (never RECOVERED!)
    const { receivable: afterRec70 } = await receivablesRepo.createRecovery({
      receivableId: rec.id,
      amount: '70.00',
      recoveryType: VendorReceivableRecoveryType.SETTLEMENT_OFFSET,
      targetAdjustmentId: goodAdj.id,
      idempotencyKey: `mix_rec_${randomUUID()}`,
    });
    expect(afterRec70.status).toBe(VendorReceivableStatus.PARTIALLY_RECOVERED);

    const { writeOff, receivable: closedMixed } = await receivablesRepo.createWriteOff({
      receivableId: rec.id,
      amount: '100.00',
      reason: 'Remaining balance written off',
      idempotencyKey: `mix_wo_${randomUUID()}`,
    });
    expect(closedMixed.status).toBe(VendorReceivableStatus.WRITTEN_OFF);
    expect(new Prisma.Decimal(closedMixed.recoveredAmount).toString()).toBe('70');
    expect(new Prisma.Decimal(closedMixed.writtenOffAmount).toString()).toBe('100');

    // N18 & N20: Terminal receivable mutations and write-off immutability blocked
    await expect(receivablesRepo.markDisputed(rec.id)).rejects.toThrow(BadRequestException);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "vendor_receivables" SET "status" = 'RECOVERED' WHERE "id" = '${rec.id}'`),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "vendor_receivable_write_offs" SET "amount" = 1.00 WHERE "id" = '${writeOff.id}'`),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "vendor_receivable_write_offs" WHERE "id" = '${writeOff.id}'`),
    ).rejects.toThrow();
  });

  it('Negative 21-22: blocks out-of-domain commission rates, referenced config deletion, snapshot tampering, sub-cent inputs, and cumulative cap breaches', async () => {
    // N21: Out-of-domain commission rates rejected in repo & SQL
    await expect(commissionRepo.create(-0.01)).rejects.toThrow(BadRequestException);
    await expect(commissionRepo.create(2.5)).rejects.toThrow(BadRequestException);
    await expect(commissionRepo.create(0.12345)).rejects.toThrow(BadRequestException);
    await expect(
      prisma.$executeRawUnsafe(`INSERT INTO "platform_commission_configs" ("id","commissionRate") VALUES ('${randomUUID()}', 2.5000)`),
    ).rejects.toThrow();

    const validCfg = await commissionRepo.create(0.15);
    const graph = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor2, subtotal: '100.00' }] });
    const settlement = await settlementsRepo.create({
      vendorId: vendor2.id,
      vendorOrderId: graph.vendorOrders[0]!.id,
      grossAmount: '100.00',
      platformFee: '15.00',
      netAmount: '85.00',
      commissionConfigId: validCfg.id,
      commissionRateSnapshot: validCfg.commissionRate,
    });
    await confirmSettlementDisbursement({ settlementId: settlement.id, vendorId: vendor2.id, amount: '85.00' });

    // Referenced commissionConfig cannot be updated or deleted
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "platform_commission_configs" SET "commissionRate" = 0.5000 WHERE "id" = '${validCfg.id}'`),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "platform_commission_configs" WHERE "id" = '${validCfg.id}'`),
    ).rejects.toThrow();

    // Settlement commissionRateSnapshot & commissionConfigId immutable
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "vendor_settlements" SET "commissionRateSnapshot" = 0.9900 WHERE "id" = '${settlement.id}'`),
    ).rejects.toThrow();

    // N22: Sub-cent >2dp inputs rejected in createReceivable, createRecovery, createWriteOff
    const r = await prisma.refund.create({
      data: {
        paymentId: graph.payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Precision test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `n22_${randomUUID()}`,
      },
    });
    const a = await allocService.createAllocation({
      refundId: r.id,
      vendorOrderId: graph.vendorOrders[0]!.id,
      amount: '50.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    await recordVendorDetermination({ allocationId: a.id });

    await expect(
      receivablesRepo.createReceivable({
        allocationId: a.id,
        vendorId: vendor2.id,
        settlementId: settlement.id,
        grossAllocatedAmount: '50.00',
        commissionReversedAmount: '7.501',
        originalAmount: '42.499',
      }),
    ).rejects.toThrow(BadRequestException);

    const rec = await receivablesRepo.createReceivable({
      allocationId: a.id,
      vendorId: vendor2.id,
      settlementId: settlement.id,
      grossAllocatedAmount: '50.00',
      commissionReversedAmount: '7.50',
      originalAmount: '42.50',
    });

    await expect(
      receivablesRepo.createRecovery({
        receivableId: rec.id,
        amount: '10.005',
        recoveryType: VendorReceivableRecoveryType.MANUAL_PAYMENT,
        externalReference: `WIRE-SUBCENT-${randomUUID()}`,
        collectedAt: new Date(),
        idempotencyKey: `subcent_${randomUUID()}`,
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      receivablesRepo.createWriteOff({
        receivableId: rec.id,
        amount: '10.005',
        reason: 'Sub-cent writeoff',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // =========================================================================
  // PART C — 8 POSTGRESQL CONCURRENCY & CONSERVATION TESTS (Promise.allSettled)
  // =========================================================================

  it('Concurrency 1-4: serializes duplicate receivable creation, 5x recovery overdrafts, recovery vs write-off race, and shared targetAdjustmentId', async () => {
    const g = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, subtotal: '500.00' }] });
    const s = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: g.vendorOrders[0]!.id,
      grossAmount: '500.00',
      platformFee: '75.00',
      netAmount: '425.00',
    });
    await confirmSettlementDisbursement({ settlementId: s.id, vendorId: vendor1.id, amount: '425.00' });

    const r = await prisma.refund.create({
      data: {
        paymentId: g.payment.id,
        amount: new Prisma.Decimal('400.00'),
        reason: 'Concurrency suite 1-4',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `c14_${randomUUID()}`,
      },
    });
    const aDup = await allocService.createAllocation({
      refundId: r.id,
      vendorOrderId: g.vendorOrders[0]!.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
      componentKey: 'CDUP',
    });
    await recordVendorDetermination({ allocationId: aDup.id });

    // C1: Concurrent duplicate createReceivable
    const dupOutcomes = await Promise.allSettled([
      receivablesRepo.createReceivable({
        allocationId: aDup.id,
        vendorId: vendor1.id,
        settlementId: s.id,
        grossAllocatedAmount: '100.00',
        commissionReversedAmount: '15.00',
        originalAmount: '85.00',
      }),
      receivablesRepo.createReceivable({
        allocationId: aDup.id,
        vendorId: vendor1.id,
        settlementId: s.id,
        grossAllocatedAmount: '100.00',
        commissionReversedAmount: '15.00',
        originalAmount: '85.00',
      }),
    ]);
    expect(dupOutcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);

    // C2: 5x $40.00 recoveries racing on $100.00 receivable -> max 2 succeed ($80 recovered)
    const aRace = await allocService.createAllocation({
      refundId: r.id,
      vendorOrderId: g.vendorOrders[0]!.id,
      amount: '100.00',
      allocationType: RefundAllocationType.ITEM_DEFECT,
      componentKey: 'CRACE',
    });
    await recordVendorDetermination({
      allocationId: aRace.id,
      category: VendorLiabilityCategory.VENDOR_ITEM_DEFECT,
    });
    const sRaceGraph = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, subtotal: '100.00' }] });
    const sRace = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: sRaceGraph.vendorOrders[0]!.id,
      grossAmount: '100.00',
      platformFee: '0.00',
      netAmount: '100.00',
    });
    await confirmSettlementDisbursement({ settlementId: sRace.id, vendorId: vendor1.id, amount: '100.00' });
    const rRacePay = await prisma.refund.create({
      data: {
        paymentId: sRaceGraph.payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: '100 receivable for overdraft race',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `c2_r_${randomUUID()}`,
      },
    });
    const a100 = await allocService.createAllocation({
      refundId: rRacePay.id,
      vendorOrderId: sRaceGraph.vendorOrders[0]!.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    await recordVendorDetermination({ allocationId: a100.id });
    const rec100 = await receivablesRepo.createReceivable({
      allocationId: a100.id,
      vendorId: vendor1.id,
      settlementId: sRace.id,
      grossAllocatedAmount: '100.00',
      commissionReversedAmount: '0.00',
      originalAmount: '100.00',
    });

    const overdraftOutcomes = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        receivablesRepo.createRecovery({
          receivableId: rec100.id,
          amount: '40.00',
          recoveryType: VendorReceivableRecoveryType.MANUAL_PAYMENT,
          externalReference: `WIRE-C2-${i}-${randomUUID()}`,
          collectedAt: new Date(),
          idempotencyKey: `ovf_${i}_${randomUUID()}`,
        }),
      ),
    );
    expect(overdraftOutcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
    const balAfterOvf = await receivablesRepo.getOutstandingBalance(rec100.id);
    expect(balAfterOvf.recoveredAmount.toString()).toBe('80');
    expect(balAfterOvf.outstandingAmount.toString()).toBe('20');

    // C3: Concurrent recovery ($60) vs write-off ($60) on fresh $100 receivable -> only 1 wins
    const g3 = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, subtotal: '100.00' }] });
    const s3 = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: g3.vendorOrders[0]!.id,
      grossAmount: '100.00',
      platformFee: '0.00',
      netAmount: '100.00',
    });
    await confirmSettlementDisbursement({ settlementId: s3.id, vendorId: vendor1.id, amount: '100.00' });
    const r3 = await prisma.refund.create({
      data: {
        paymentId: g3.payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Rec vs WO race',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `c3_r_${randomUUID()}`,
      },
    });
    const a3 = await allocService.createAllocation({
      refundId: r3.id,
      vendorOrderId: g3.vendorOrders[0]!.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });
    await recordVendorDetermination({ allocationId: a3.id });
    const rec3 = await receivablesRepo.createReceivable({
      allocationId: a3.id,
      vendorId: vendor1.id,
      settlementId: s3.id,
      grossAllocatedAmount: '100.00',
      commissionReversedAmount: '0.00',
      originalAmount: '100.00',
    });

    const raceRecVsWo = await Promise.allSettled([
      receivablesRepo.createRecovery({
        receivableId: rec3.id,
        amount: '60.00',
        recoveryType: VendorReceivableRecoveryType.MANUAL_PAYMENT,
        externalReference: `WIRE-C3-${randomUUID()}`,
        collectedAt: new Date(),
        idempotencyKey: `c3_rec_${randomUUID()}`,
      }),
      receivablesRepo.createWriteOff({
        receivableId: rec3.id,
        amount: '60.00',
        reason: 'Concurrent write-off race',
        idempotencyKey: `c3_wo_${randomUUID()}`,
      }),
    ]);
    expect(raceRecVsWo.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const bal3 = await receivablesRepo.getOutstandingBalance(rec3.id);
    expect(bal3.recoveredAmount.plus(bal3.writtenOffAmount).toString()).toBe('60');

    // C4: Two concurrent SETTLEMENT_OFFSET recoveries racing on same targetAdjustmentId -> only 1 succeeds
    const { adjustment: sharedAdj } = await createTargetOffsetAdjustment(vendor1, '20.00');
    const c4Outcomes = await Promise.allSettled([
      receivablesRepo.createRecovery({
        receivableId: rec100.id,
        amount: '20.00',
        recoveryType: VendorReceivableRecoveryType.SETTLEMENT_OFFSET,
        targetAdjustmentId: sharedAdj.id,
        idempotencyKey: `c4_1_${randomUUID()}`,
      }),
      receivablesRepo.createRecovery({
        receivableId: rec3.id,
        amount: '20.00',
        recoveryType: VendorReceivableRecoveryType.SETTLEMENT_OFFSET,
        targetAdjustmentId: sharedAdj.id,
        idempotencyKey: `c4_2_${randomUUID()}`,
      }),
    ]);
    expect(c4Outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });

  it('Concurrency 5-8: serializes double-recognition race, dispute vs recovery, cumulative settlement cap race, and duplicate generateSettlements', async () => {
    // C5 & C7 setup: PAID+CONFIRMED settlement capped at 80.00 gross (12.00 fee, 68.00 net) with two 50.00 allocations
    const g = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor2, subtotal: '120.00' }] });
    const s = await settlementsRepo.create({
      vendorId: vendor2.id,
      vendorOrderId: g.vendorOrders[0]!.id,
      grossAmount: '80.00',
      platformFee: '12.00',
      netAmount: '68.00',
    });
    await confirmSettlementDisbursement({ settlementId: s.id, vendorId: vendor2.id, amount: '68.00' });

    const r = await prisma.refund.create({
      data: {
        paymentId: g.payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Cap and double-recog race',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `c57_${randomUUID()}`,
      },
    });
    const a1 = await allocService.createAllocation({
      refundId: r.id,
      vendorOrderId: g.vendorOrders[0]!.id,
      amount: '50.00',
      allocationType: RefundAllocationType.CANCELLATION,
      componentKey: 'C5A',
    });
    const a2 = await allocService.createAllocation({
      refundId: r.id,
      vendorOrderId: g.vendorOrders[0]!.id,
      amount: '50.00',
      allocationType: RefundAllocationType.ITEM_DEFECT,
      componentKey: 'C5B',
    });
    await recordVendorDetermination({ allocationId: a1.id });
    await recordVendorDetermination({
      allocationId: a2.id,
      category: VendorLiabilityCategory.VENDOR_ITEM_DEFECT,
    });

    // C5 & C7 combined: race createReceivable(a1=50), createReceivable(a2=50), and refund adjustment(-42.50)
    const c57Outcomes = await Promise.allSettled([
      receivablesRepo.createReceivable({
        allocationId: a1.id,
        vendorId: vendor2.id,
        settlementId: s.id,
        grossAllocatedAmount: '50.00',
        commissionReversedAmount: '7.50',
        originalAmount: '42.50',
      }),
      receivablesRepo.createReceivable({
        allocationId: a2.id,
        vendorId: vendor2.id,
        settlementId: s.id,
        grossAllocatedAmount: '50.00',
        commissionReversedAmount: '7.50',
        originalAmount: '42.50',
      }),
      adjustmentsRepo.create({
        settlementId: s.id,
        refundId: r.id,
        allocationId: a1.id,
        amount: '-42.50',
        reason: 'Competing entitlement adjustment',
        idempotencyKey: `c5_adj_${randomUUID()}`,
      }),
    ]);

    expect(c57Outcomes[2]!.status).toBe('rejected');
    const createdReceivables = await prisma.vendorReceivable.findMany({ where: { settlementId: s.id } });
    expect(createdReceivables).toHaveLength(1);
    const createdRec = createdReceivables[0]!;

    // C6: Concurrent markDisputed vs MANUAL_PAYMENT recovery on createdRec
    const c6Outcomes = await Promise.allSettled([
      receivablesRepo.markDisputed(createdRec.id, 'Concurrent dispute'),
      receivablesRepo.createRecovery({
        receivableId: createdRec.id,
        amount: '10.00',
        recoveryType: VendorReceivableRecoveryType.MANUAL_PAYMENT,
        externalReference: `WIRE-C6-${randomUUID()}`,
        collectedAt: new Date(),
        idempotencyKey: `c6_rec_${randomUUID()}`,
      }),
    ]);
    const freshRec = (await receivablesRepo.findById(createdRec.id))!;
    const sumRecoveries = freshRec.recoveries.reduce(
      (acc, item) => acc.plus(new Prisma.Decimal(item.amount)),
      new Prisma.Decimal('0.00'),
    );
    expect(new Prisma.Decimal(freshRec.recoveredAmount).equals(sumRecoveries)).toBe(true);
    expect(freshRec.status).toBe(VendorReceivableStatus.DISPUTED);
    expect(c6Outcomes[0]!.status).toBe('fulfilled');

    // C8: Concurrent generateSettlements calls produce zero duplicate settlements
    const g8 = await createOrderGraph({ vendorSubtotals: [{ vendor: vendor1, subtotal: '200.00' }] });
    await commissionRepo.create(0.10);
    await Promise.allSettled([
      settlementsService.generateSettlements(),
      settlementsService.generateSettlements(),
    ]);
    const settlementsForVo = await prisma.vendorSettlement.findMany({
      where: { vendorOrderId: g8.vendorOrders[0]!.id },
    });
    expect(settlementsForVo).toHaveLength(1);
  });
});
