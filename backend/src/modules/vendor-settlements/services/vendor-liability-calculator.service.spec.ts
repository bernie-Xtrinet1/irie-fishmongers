import { BadRequestException } from '@nestjs/common';
import {
  Order,
  Parish,
  Payment,
  PaymentInitiationStatus,
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  Refund,
  RefundAllocationEntryKind,
  RefundAllocationType,
  RefundStatus,
  RefundVendorOrderAllocation,
  VendorLiabilityCategory,
  VendorLiabilityDecision,
  VendorLiabilityDetermination,
  VendorOrder,
  VendorOrderStatus,
  VendorSettlement,
  VendorSettlementDisbursement,
  VendorSettlementDisbursementStatus,
  VendorSettlementStatus,
} from '@prisma/client';
import {
  LiabilityAttributionStatus,
  VendorLiabilityCalculatorService,
  VendorSettlementExposureCategory,
} from './vendor-liability-calculator.service';

describe('VendorLiabilityCalculatorService', () => {
  let service: VendorLiabilityCalculatorService;

  beforeEach(() => {
    service = new VendorLiabilityCalculatorService();
  });

  function mockOrder(overrides: Partial<Order> = {}): Order {
    return {
      id: 'order-1',
      customerId: 'cust-1',
      deliveryAddressLine1: '1 Ocean Blvd',
      deliveryAddressLine2: null,
      deliveryParish: Parish.KINGSTON,
      deliveryPhone: '+18765550100',
      deliveryZoneId: null,
      currency: 'JMD',
      createdAt: new Date('2026-11-01T00:00:00Z'),
      updatedAt: new Date('2026-11-01T00:00:00Z'),
      ...overrides,
    };
  }

  function mockVendorOrder(overrides: Partial<VendorOrder> = {}): VendorOrder {
    return {
      id: 'vo-1',
      orderId: 'order-1',
      vendorId: 'vendor-1',
      status: VendorOrderStatus.DELIVERED,
      subtotal: new Prisma.Decimal('10000.00'),
      createdAt: new Date('2026-11-01T00:00:00Z'),
      updatedAt: new Date('2026-11-01T00:00:00Z'),
      ...overrides,
    };
  }

  function mockPayment(overrides: Partial<Payment> = {}): Payment {
    return {
      id: 'pay-1',
      orderId: 'order-1',
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      status: PaymentStatus.PAID,
      initiationStatus: PaymentInitiationStatus.ESTABLISHED,
      amount: new Prisma.Decimal('10000.00'),
      currency: 'JMD',
      providerReference: 'pay-ref-1',
      failureReason: null,
      paidAt: new Date('2026-11-01T00:00:00Z'),
      recoveryAttemptCount: 0,
      recoveryStartedAt: null,
      createdAt: new Date('2026-11-01T00:00:00Z'),
      updatedAt: new Date('2026-11-01T00:00:00Z'),
      ...overrides,
    };
  }

  function mockSettlement(overrides: Partial<VendorSettlement> = {}): VendorSettlement {
    return {
      id: 'settlement-1',
      vendorId: 'vendor-1',
      vendorOrderId: 'vo-1',
      grossAmount: new Prisma.Decimal('10000.00'),
      platformFee: new Prisma.Decimal('1500.00'),
      netAmount: new Prisma.Decimal('8500.00'),
      status: VendorSettlementStatus.PAID,
      paymentDate: new Date('2026-11-01T12:00:00Z'),
      paymentReference: null,
      notes: null,
      commissionConfigId: 'config-1',
      commissionRateSnapshot: new Prisma.Decimal('0.1500'),
      createdAt: new Date('2026-11-01T00:00:00Z'),
      updatedAt: new Date('2026-11-01T00:00:00Z'),
      ...overrides,
    };
  }

  function mockDisbursement(
    overrides: Partial<VendorSettlementDisbursement> = {},
  ): VendorSettlementDisbursement {
    return {
      id: 'disb-1',
      settlementId: 'settlement-1',
      vendorId: 'vendor-1',
      amount: new Prisma.Decimal('8500.00'),
      currency: 'JMD',
      status: VendorSettlementDisbursementStatus.CONFIRMED,
      externalReference: 'BANK-WIRE-001',
      notes: 'Wire settled',
      initiatedAt: new Date('2026-11-01T10:00:00Z'),
      confirmedAt: new Date('2026-11-01T12:00:00Z'),
      createdAt: new Date('2026-11-01T10:00:00Z'),
      updatedAt: new Date('2026-11-01T12:00:00Z'),
      ...overrides,
    };
  }

  function mockAllocation(
    overrides: Partial<RefundVendorOrderAllocation> = {},
  ): RefundVendorOrderAllocation {
    return {
      id: 'alloc-1',
      refundId: 'refund-1',
      vendorOrderId: 'vo-1',
      orderItemId: null,
      componentKey: 'VO',
      entryKind: RefundAllocationEntryKind.ALLOCATION,
      reversesAllocationId: null,
      amount: new Prisma.Decimal('2000.00'),
      currency: 'JMD',
      allocationType: RefundAllocationType.CANCELLATION,
      reason: null,
      createdAt: new Date('2026-11-02T00:00:00Z'),
      ...overrides,
    };
  }

  function mockRefund(overrides: Partial<Refund> = {}): Refund {
    return {
      id: 'refund-1',
      idempotencyKey: 'idemp-1',
      paymentId: 'pay-1',
      obligationId: null,
      supersedesRefundId: null,
      amount: new Prisma.Decimal('2000.00'),
      reason: 'DEFECTIVE_PRODUCT',
      status: RefundStatus.COMPLETED,
      providerReference: 'pr-1',
      createdAt: new Date('2026-11-02T00:00:00Z'),
      updatedAt: new Date('2026-11-02T00:00:00Z'),
      ...overrides,
    };
  }

  function mockDetermination(
    overrides: Partial<VendorLiabilityDetermination> = {},
  ): VendorLiabilityDetermination {
    return {
      id: 'det-1',
      allocationId: 'alloc-1',
      decision: VendorLiabilityDecision.VENDOR_RESPONSIBLE,
      category: VendorLiabilityCategory.VENDOR_CANCELLED_ORDER,
      rationale: 'Vendor cancelled order after capture',
      evidenceReference: 'TICKET-1001',
      createdAt: new Date('2026-11-02T00:05:00Z'),
      ...overrides,
    };
  }

  describe('Exposure classification (disbursement-evidence grounded)', () => {
    it('classifies PENDING and APPROVED (without IN_FLIGHT disbursement) as UNPAID_ENTITLEMENT', () => {
      expect(
        service.classifySettlementExposure(mockSettlement({ status: VendorSettlementStatus.PENDING })),
      ).toBe(VendorSettlementExposureCategory.UNPAID_ENTITLEMENT);

      expect(
        service.classifySettlementExposure(
          mockSettlement({ status: VendorSettlementStatus.APPROVED }),
        ),
      ).toBe(VendorSettlementExposureCategory.UNPAID_ENTITLEMENT);
    });

    it('classifies APPROVED or PAID with IN_FLIGHT disbursement as PAYOUT_IN_FLIGHT', () => {
      const inFlight = mockDisbursement({
        status: VendorSettlementDisbursementStatus.IN_FLIGHT,
        confirmedAt: null,
        externalReference: null,
      });

      expect(
        service.classifySettlementExposure(
          mockSettlement({ status: VendorSettlementStatus.APPROVED }),
          [inFlight],
        ),
      ).toBe(VendorSettlementExposureCategory.PAYOUT_IN_FLIGHT);

      expect(
        service.classifySettlementExposure(
          mockSettlement({ status: VendorSettlementStatus.PAID }),
          [inFlight],
        ),
      ).toBe(VendorSettlementExposureCategory.PAYOUT_IN_FLIGHT);
    });

    it('classifies PAID without CONFIRMED disbursement (even with paymentDate/notes) as DISBURSEMENT_UNKNOWN', () => {
      expect(
        service.classifySettlementExposure(
          mockSettlement({
            status: VendorSettlementStatus.PAID,
            paymentDate: new Date(),
            notes: 'Marked paid manually without bank ref',
          }),
        ),
      ).toBe(VendorSettlementExposureCategory.DISBURSEMENT_UNKNOWN);

      expect(
        service.classifySettlementExposure(
          mockSettlement({ status: VendorSettlementStatus.PAID }),
          [
            mockDisbursement({
              status: VendorSettlementDisbursementStatus.FAILED,
              confirmedAt: null,
            }),
          ],
        ),
      ).toBe(VendorSettlementExposureCategory.DISBURSEMENT_UNKNOWN);
    });

    it('classifies PAID with valid CONFIRMED disbursement as EXTERNALLY_DISBURSED', () => {
      expect(
        service.classifySettlementExposure(
          mockSettlement({ status: VendorSettlementStatus.PAID }),
          [mockDisbursement()],
          'JMD',
        ),
      ).toBe(VendorSettlementExposureCategory.EXTERNALLY_DISBURSED);
    });

    it('rejects spoofed disbursement with mismatched settlementId or vendorId', () => {
      expect(() =>
        service.classifySettlementExposure(
          mockSettlement({ id: 'settlement-1', vendorId: 'vendor-1' }),
          [mockDisbursement({ vendorId: 'vendor-other' })],
        ),
      ).toThrow(BadRequestException);

      expect(() =>
        service.classifySettlementExposure(
          mockSettlement({ id: 'settlement-1', vendorId: 'vendor-1' }),
          [mockDisbursement({ settlementId: 'settlement-other' })],
        ),
      ).toThrow(BadRequestException);
    });

    it('classifies FAILED as UNRESOLVED', () => {
      expect(
        service.classifySettlementExposure(mockSettlement({ status: VendorSettlementStatus.FAILED })),
      ).toBe(VendorSettlementExposureCategory.UNRESOLVED);
    });
  });

  describe('Proportional liability calculation and commission conservation', () => {
    it('calculates exact 15% commission reversal for $2,000 refund on $10,000 settlement', () => {
      const settlement = mockSettlement();
      const allocation = mockAllocation({ amount: new Prisma.Decimal('2000.00') });
      const refund = mockRefund({ status: RefundStatus.COMPLETED });

      const calc = service.calculateAllocationLiability({
        settlement,
        allocation,
        refund,
        determination: mockDetermination({ allocationId: allocation.id }),
        order: mockOrder(),
        vendorOrder: mockVendorOrder(),
        payment: mockPayment(),
        disbursements: [mockDisbursement()],
      });

      expect(calc.grossAllocatedAmount.toString()).toBe('2000');
      expect(calc.commissionReversedAmount.toString()).toBe('300');
      expect(calc.vendorNetLiability.toString()).toBe('1700');
      expect(calc.attributionStatus).toBe(LiabilityAttributionStatus.CONFIRMED_LIABILITY);
      expect(calc.exposureCategory).toBe(VendorSettlementExposureCategory.EXTERNALLY_DISBURSED);
    });

    it('preserves historical commission amounts regardless of current config rate', () => {
      const settlement = mockSettlement({
        grossAmount: new Prisma.Decimal('10000.00'),
        platformFee: new Prisma.Decimal('1250.00'),
        netAmount: new Prisma.Decimal('8750.00'),
        commissionRateSnapshot: new Prisma.Decimal('0.1250'),
      });
      const allocation = mockAllocation({ amount: new Prisma.Decimal('4000.00') });
      const refund = mockRefund({ status: RefundStatus.COMPLETED });

      const calc = service.calculateAllocationLiability({
        settlement,
        allocation,
        refund,
        determination: mockDetermination({ allocationId: allocation.id }),
        disbursements: [mockDisbursement()],
      });

      expect(calc.commissionReversedAmount.toString()).toBe('500');
      expect(calc.vendorNetLiability.toString()).toBe('3500');
    });

    it('preserves exact cents on $33.33 / $100.00 fractional remainder', () => {
      const settlement = mockSettlement({
        grossAmount: new Prisma.Decimal('100.00'),
        platformFee: new Prisma.Decimal('15.00'),
        netAmount: new Prisma.Decimal('85.00'),
      });
      const allocation = mockAllocation({ amount: new Prisma.Decimal('33.33') });
      const refund = mockRefund({ status: RefundStatus.COMPLETED });

      const calc = service.calculateAllocationLiability({
        settlement,
        allocation,
        refund,
        determination: mockDetermination({ allocationId: allocation.id }),
        disbursements: [mockDisbursement({ amount: settlement.netAmount })],
      });

      expect(calc.commissionReversedAmount.toString()).toBe('5');
      expect(calc.vendorNetLiability.toString()).toBe('28.33');
    });

    it('guarantees zero cent drift across partial refunds summing to full settlement', () => {
      const settlement = mockSettlement({
        grossAmount: new Prisma.Decimal('1000.00'),
        platformFee: new Prisma.Decimal('150.00'),
        netAmount: new Prisma.Decimal('850.00'),
      });
      const refund = mockRefund({ status: RefundStatus.COMPLETED });

      const alloc1 = mockAllocation({
        id: 'a1',
        amount: new Prisma.Decimal('333.33'),
        createdAt: new Date('2026-11-02T00:01:00Z'),
      });
      const alloc2 = mockAllocation({
        id: 'a2',
        amount: new Prisma.Decimal('333.33'),
        createdAt: new Date('2026-11-02T00:02:00Z'),
      });
      const alloc3 = mockAllocation({
        id: 'a3',
        amount: new Prisma.Decimal('333.34'),
        createdAt: new Date('2026-11-02T00:03:00Z'),
      });

      const cum = service.calculateSettlementCumulativeLiability({
        settlement,
        disbursements: [mockDisbursement({ amount: settlement.netAmount })],
        allocations: [
          {
            allocation: alloc1,
            refund,
            determination: mockDetermination({ allocationId: alloc1.id }),
          },
          {
            allocation: alloc2,
            refund,
            determination: mockDetermination({ allocationId: alloc2.id }),
          },
          {
            allocation: alloc3,
            refund,
            determination: mockDetermination({ allocationId: alloc3.id }),
          },
        ],
      });

      expect(cum.cumulativeEligibleRefundGross.toString()).toBe('1000');
      expect(cum.cumulativeFeeReversed.toString()).toBe('150');
      expect(cum.cumulativeVendorNetLiability.toString()).toBe('850');
      expect(cum.remainingSettlementNetAmount.toString()).toBe('0');
      expect(cum.allocationsBreakdown.map((b) => b.commissionReversedAmount.toString())).toEqual([
        '50',
        '50',
        '50',
      ]);
    });

    it('is permutation-invariant regardless of allocation array ordering and excludes reversals cleanly', () => {
      const settlement = mockSettlement({
        grossAmount: new Prisma.Decimal('10.00'),
        platformFee: new Prisma.Decimal('1.50'),
        netAmount: new Prisma.Decimal('8.50'),
      });
      const r1 = mockRefund({ id: 'r1', status: RefundStatus.COMPLETED });
      const r2 = mockRefund({ id: 'r2', status: RefundStatus.COMPLETED });
      const rFailed = mockRefund({ id: 'r-fail', status: RefundStatus.FAILED });

      const a1 = mockAllocation({
        id: 'a1',
        refundId: 'r1',
        amount: new Prisma.Decimal('0.03'),
        createdAt: new Date('2026-11-02T00:01:00Z'),
      });
      const a2 = mockAllocation({
        id: 'a2',
        refundId: 'r2',
        amount: new Prisma.Decimal('0.04'),
        createdAt: new Date('2026-11-02T00:02:00Z'),
      });
      const aRevOrig = mockAllocation({
        id: 'a3-orig',
        refundId: 'r1',
        amount: new Prisma.Decimal('4.00'),
        createdAt: new Date('2026-11-02T00:03:00Z'),
      });
      const aRev = mockAllocation({
        id: 'a3-rev',
        refundId: 'r1',
        entryKind: RefundAllocationEntryKind.REVERSAL,
        reversesAllocationId: 'a3-orig',
        componentKey: 'REV:a3-orig',
        amount: new Prisma.Decimal('-4.00'),
        createdAt: new Date('2026-11-02T00:04:00Z'),
      });
      const aFailed = mockAllocation({
        id: 'a4-failed',
        refundId: 'r-fail',
        amount: new Prisma.Decimal('5.00'),
        createdAt: new Date('2026-11-02T00:00:00Z'),
      });

      const itemsForward = [
        { allocation: aFailed, refund: rFailed, determination: mockDetermination({ allocationId: aFailed.id }) },
        { allocation: a1, refund: r1, determination: mockDetermination({ allocationId: a1.id }) },
        { allocation: a2, refund: r2, determination: mockDetermination({ allocationId: a2.id }) },
        { allocation: aRevOrig, refund: r1, determination: mockDetermination({ allocationId: aRevOrig.id }) },
        { allocation: aRev, refund: r1 },
      ];
      const itemsReversedOrder = [
        itemsForward[4]!,
        itemsForward[2]!,
        itemsForward[1]!,
        itemsForward[3]!,
        itemsForward[0]!,
      ];

      const resForward = service.calculateSettlementCumulativeLiability({
        settlement,
        allocations: itemsForward,
        disbursements: [mockDisbursement({ amount: settlement.netAmount })],
      });
      const resReversed = service.calculateSettlementCumulativeLiability({
        settlement,
        allocations: itemsReversedOrder,
        disbursements: [mockDisbursement({ amount: settlement.netAmount })],
      });

      expect(resForward.cumulativeEligibleRefundGross.toString()).toBe('0.07');
      expect(resReversed.cumulativeEligibleRefundGross.toString()).toBe('0.07');
      expect(resForward.cumulativeFeeReversed.toString()).toBe(
        resReversed.cumulativeFeeReversed.toString(),
      );
      expect(resForward.allocationsBreakdown.map((b) => ({ id: b.allocationId, net: b.vendorNetLiability.toString() }))).toEqual(
        resReversed.allocationsBreakdown.map((b) => ({ id: b.allocationId, net: b.vendorNetLiability.toString() })),
      );
      const revEntry = resReversed.allocationsBreakdown.find((b) => b.allocationId === 'a3-orig');
      expect(revEntry?.attributionStatus).toBe(LiabilityAttributionStatus.REVERSED_ALLOCATION_EXCLUDED);
      expect(revEntry?.vendorNetLiability.toString()).toBe('0');
    });

    it('handles zero-gross settlement cleanly without division by zero when no active allocations exist', () => {
      const zeroSettlement = mockSettlement({
        grossAmount: new Prisma.Decimal('0.00'),
        platformFee: new Prisma.Decimal('0.00'),
        netAmount: new Prisma.Decimal('0.00'),
      });

      const emptyCum = service.calculateSettlementCumulativeLiability({
        settlement: zeroSettlement,
        allocations: [],
      });
      expect(emptyCum.cumulativeFeeReversed.toString()).toBe('0');
      expect(emptyCum.remainingSettlementNetAmount.toString()).toBe('0');
    });
  });

  describe('Entity hierarchy, attribution determinations, precision and ceiling guards', () => {
    it('rejects mismatched refundId, vendorOrderId, cross-vendor, cross-order, and currency mismatches', () => {
      const settlement = mockSettlement();
      const alloc = mockAllocation();
      const refund = mockRefund();
      const det = mockDetermination();

      expect(() =>
        service.calculateAllocationLiability({
          settlement,
          allocation: { ...alloc, refundId: 'other-refund' },
          refund,
          determination: det,
        }),
      ).toThrow(BadRequestException);

      expect(() =>
        service.calculateAllocationLiability({
          settlement,
          allocation: { ...alloc, vendorOrderId: 'other-vo' },
          refund,
          determination: det,
        }),
      ).toThrow(BadRequestException);

      expect(() =>
        service.calculateAllocationLiability({
          settlement,
          allocation: alloc,
          refund,
          determination: det,
          vendorOrder: mockVendorOrder({ vendorId: 'vendor-other' }),
        }),
      ).toThrow(BadRequestException);

      expect(() =>
        service.calculateAllocationLiability({
          settlement,
          allocation: alloc,
          refund,
          determination: det,
          vendorOrder: mockVendorOrder({ orderId: 'order-1' }),
          payment: mockPayment({ orderId: 'order-other' }),
        }),
      ).toThrow(BadRequestException);

      expect(() =>
        service.calculateAllocationLiability({
          settlement,
          allocation: { ...alloc, currency: 'USD' },
          refund,
          determination: det,
          payment: mockPayment({ currency: 'JMD' }),
        }),
      ).toThrow(BadRequestException);
    });

    it('treats missing or UNRESOLVED determination as UNATTRIBUTED (zero vendor liability)', () => {
      const calcNoDet = service.calculateAllocationLiability({
        settlement: mockSettlement(),
        allocation: mockAllocation(),
        refund: mockRefund(),
      });
      expect(calcNoDet.attributionStatus).toBe(LiabilityAttributionStatus.UNATTRIBUTED);
      expect(calcNoDet.grossAllocatedAmount.toString()).toBe('0');
      expect(calcNoDet.vendorNetLiability.toString()).toBe('0');

      const calcUnresolved = service.calculateAllocationLiability({
        settlement: mockSettlement(),
        allocation: mockAllocation(),
        refund: mockRefund(),
        determination: mockDetermination({
          decision: VendorLiabilityDecision.UNRESOLVED,
          category: VendorLiabilityCategory.UNSPECIFIED,
        }),
      });
      expect(calcUnresolved.attributionStatus).toBe(LiabilityAttributionStatus.UNATTRIBUTED);
      expect(calcUnresolved.vendorNetLiability.toString()).toBe('0');
    });

    it('treats PLATFORM_CONCESSION determination as zero vendor liability', () => {
      const calc = service.calculateAllocationLiability({
        settlement: mockSettlement(),
        allocation: mockAllocation(),
        refund: mockRefund(),
        determination: mockDetermination({
          decision: VendorLiabilityDecision.PLATFORM_CONCESSION,
          category: VendorLiabilityCategory.PLATFORM_GOODWILL_CONCESSION,
        }),
      });
      expect(calc.attributionStatus).toBe(LiabilityAttributionStatus.PLATFORM_CONCESSION);
      expect(calc.grossAllocatedAmount.toString()).toBe('0');
      expect(calc.vendorNetLiability.toString()).toBe('0');
    });

    it('rejects MANUAL_SUPERVISOR_ADJUSTMENT with VENDOR_RESPONSIBLE when evidenceReference is missing', () => {
      const alloc = mockAllocation({
        allocationType: RefundAllocationType.MANUAL_SUPERVISOR_ADJUSTMENT,
      });
      expect(() =>
        service.calculateAllocationLiability({
          settlement: mockSettlement(),
          allocation: alloc,
          refund: mockRefund(),
          determination: mockDetermination({
            allocationId: alloc.id,
            category: VendorLiabilityCategory.CONTRACTUAL_VENDOR_RETURN,
            evidenceReference: null,
          }),
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects negative/zero ALLOCATION amounts, sub-cent >2dp inputs, direct REVERSAL target, and over-allocation ceiling', () => {
      const settlement = mockSettlement({
        grossAmount: new Prisma.Decimal('100.00'),
        platformFee: new Prisma.Decimal('15.00'),
        netAmount: new Prisma.Decimal('85.00'),
      });

      expect(() =>
        service.calculateAllocationLiability({
          settlement,
          allocation: mockAllocation({ amount: new Prisma.Decimal('-20.00') }),
          refund: mockRefund(),
          determination: mockDetermination(),
        }),
      ).toThrow(BadRequestException);

      expect(() =>
        service.calculateAllocationLiability({
          settlement,
          allocation: mockAllocation({ amount: new Prisma.Decimal('33.334') }),
          refund: mockRefund(),
          determination: mockDetermination(),
        }),
      ).toThrow(BadRequestException);

      expect(() =>
        service.calculateAllocationLiability({
          settlement,
          allocation: mockAllocation({
            entryKind: RefundAllocationEntryKind.REVERSAL,
            reversesAllocationId: 'alloc-0',
            amount: new Prisma.Decimal('-10.00'),
          }),
          refund: mockRefund(),
          determination: mockDetermination(),
        }),
      ).toThrow(BadRequestException);

      expect(() =>
        service.calculateAllocationLiability({
          settlement,
          allocation: mockAllocation({ amount: new Prisma.Decimal('150.00') }),
          refund: mockRefund(),
          determination: mockDetermination(),
        }),
      ).toThrow(BadRequestException);
    });

    it('excludes FAILED and provisional priors from confirmed cumulative settlement calculations', () => {
      const settlement = mockSettlement({
        grossAmount: new Prisma.Decimal('100.00'),
        platformFee: new Prisma.Decimal('15.00'),
        netAmount: new Prisma.Decimal('85.00'),
      });
      const failedRefund = mockRefund({ id: 'rf-fail', status: RefundStatus.FAILED });
      const pendingRefund = mockRefund({ id: 'rf-pend', status: RefundStatus.PENDING });
      const compRefund = mockRefund({ id: 'rf-comp', status: RefundStatus.COMPLETED });

      const aFail = mockAllocation({ id: 'af', refundId: 'rf-fail', amount: new Prisma.Decimal('50.00') });
      const aPend = mockAllocation({ id: 'ap', refundId: 'rf-pend', amount: new Prisma.Decimal('40.00') });
      const aComp = mockAllocation({ id: 'ac', refundId: 'rf-comp', amount: new Prisma.Decimal('33.33') });

      const cum = service.calculateSettlementCumulativeLiability({
        settlement,
        disbursements: [mockDisbursement({ amount: settlement.netAmount })],
        allocations: [
          { allocation: aFail, refund: failedRefund, determination: mockDetermination({ allocationId: 'af' }) },
          { allocation: aPend, refund: pendingRefund, determination: mockDetermination({ allocationId: 'ap' }) },
          { allocation: aComp, refund: compRefund, determination: mockDetermination({ allocationId: 'ac' }) },
        ],
      });

      expect(cum.cumulativeEligibleRefundGross.toString()).toBe('33.33');
      expect(cum.cumulativeFeeReversed.toString()).toBe('5');
      expect(cum.cumulativeVendorNetLiability.toString()).toBe('28.33');
    });

    it('rejects overlapping, duplicated, or mixed priorItems and priorAllocations and classifies partial disbursements safely', () => {
      const settlement = mockSettlement({
        grossAmount: new Prisma.Decimal('1000.00'),
        platformFee: new Prisma.Decimal('150.00'),
        netAmount: new Prisma.Decimal('850.00'),
      });
      const refund = mockRefund({ status: RefundStatus.COMPLETED, amount: new Prisma.Decimal('500.00') });
      const allocA = mockAllocation({
        id: 'a-overlap-1',
        amount: new Prisma.Decimal('100.00'),
        createdAt: new Date('2026-11-02T00:01:00Z'),
      });
      const allocB = mockAllocation({
        id: 'a-overlap-2',
        amount: new Prisma.Decimal('100.00'),
        createdAt: new Date('2026-11-02T00:02:00Z'),
      });
      const partialDisb = mockDisbursement({ amount: new Prisma.Decimal('1.00') });

      // Partial $1 confirmed disbursement on $850 settlement -> PARTIALLY_DISBURSED, max coverage $1.00
      const partialCov = service.resolveConfirmedDisbursementCoverage(
        settlement,
        [partialDisb],
        'JMD',
      );
      expect(partialCov.exposureCategory).toBe(VendorSettlementExposureCategory.PARTIALLY_DISBURSED);
      expect(partialCov.confirmedDisbursedAmount.toString()).toBe('1');
      expect(partialCov.maxReceivableCoverageAmount.toString()).toBe('1');

      // Confirmed disbursement exceeding adjusted entitlement rejected
      expect(() =>
        service.classifySettlementExposure(
          settlement,
          [mockDisbursement({ amount: new Prisma.Decimal('850.00') })],
          'JMD',
          { adjustedEntitlement: '400.00' },
        ),
      ).toThrow(BadRequestException);

      // Zero adjusted entitlement with confirmed disbursement rejected
      expect(() =>
        service.classifySettlementExposure(
          settlement,
          [partialDisb],
          'JMD',
          { adjustedEntitlement: '0.00' },
        ),
      ).toThrow(BadRequestException);

      // Self-overlap in priorItems rejected (even within gross cap)
      expect(() =>
        service.calculateAllocationLiability({
          settlement,
          allocation: allocB,
          refund,
          determination: mockDetermination({ allocationId: allocB.id }),
          priorItems: [
            {
              allocation: allocB,
              refund,
              determination: mockDetermination({ allocationId: allocB.id }),
            },
          ],
          disbursements: [mockDisbursement({ amount: settlement.netAmount })],
        }),
      ).toThrow(BadRequestException);

      // Duplicate allocation in priorItems rejected (even within gross cap)
      expect(() =>
        service.calculateAllocationLiability({
          settlement,
          allocation: allocB,
          refund,
          determination: mockDetermination({ allocationId: allocB.id }),
          priorItems: [
            {
              allocation: allocA,
              refund,
              determination: mockDetermination({ allocationId: allocA.id }),
            },
            {
              allocation: allocA,
              refund,
              determination: mockDetermination({ allocationId: allocA.id }),
            },
          ],
          disbursements: [mockDisbursement({ amount: settlement.netAmount })],
        }),
      ).toThrow(BadRequestException);

      // Both priorItems and priorAllocations rejected
      expect(() =>
        service.calculateAllocationLiability({
          settlement,
          allocation: allocB,
          refund,
          determination: mockDetermination({ allocationId: allocB.id }),
          priorItems: [{ allocation: allocA, refund }],
          priorAllocations: [allocA],
          disbursements: [mockDisbursement({ amount: settlement.netAmount })],
        }),
      ).toThrow(BadRequestException);

      // Duplicate/self-overlap in priorAllocations rejected even when unattributed
      expect(() =>
        service.calculateAllocationLiability({
          settlement,
          allocation: allocB,
          refund,
          determination: null,
          priorAllocations: [allocB],
        }),
      ).toThrow(BadRequestException);
    });
  });
});
