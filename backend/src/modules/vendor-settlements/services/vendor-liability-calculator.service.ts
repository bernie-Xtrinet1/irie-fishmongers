import { Injectable, BadRequestException } from '@nestjs/common';
import {
  Order,
  Payment,
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
  VendorSettlement,
  VendorSettlementDisbursement,
  VendorSettlementDisbursementStatus,
  VendorSettlementStatus,
} from '@prisma/client';

import { parseExactMonetary2dp } from '../utils/cent-distribution.util';

export enum VendorSettlementExposureCategory {
  UNPAID_ENTITLEMENT = 'UNPAID_ENTITLEMENT',
  EXTERNALLY_DISBURSED = 'EXTERNALLY_DISBURSED',
  PARTIALLY_DISBURSED = 'PARTIALLY_DISBURSED',
  PAYOUT_IN_FLIGHT = 'PAYOUT_IN_FLIGHT',
  DISBURSEMENT_UNKNOWN = 'DISBURSEMENT_UNKNOWN',
  UNRESOLVED = 'UNRESOLVED',
}

export enum LiabilityAttributionStatus {
  CONFIRMED_LIABILITY = 'CONFIRMED_LIABILITY',
  PROVISIONAL_ATTRIBUTION = 'PROVISIONAL_ATTRIBUTION',
  FAILED_REFUND_EXCLUDED = 'FAILED_REFUND_EXCLUDED',
  REVERSED_ALLOCATION_EXCLUDED = 'REVERSED_ALLOCATION_EXCLUDED',
  PLATFORM_CONCESSION = 'PLATFORM_CONCESSION',
  UNATTRIBUTED = 'UNATTRIBUTED',
}

const VENDOR_FAULT_CATEGORIES = new Set<VendorLiabilityCategory>([
  VendorLiabilityCategory.VENDOR_CANCELLED_ORDER,
  VendorLiabilityCategory.VENDOR_ITEM_DEFECT,
  VendorLiabilityCategory.VENDOR_FULFILLMENT_SHORTFALL,
  VendorLiabilityCategory.CONTRACTUAL_VENDOR_RETURN,
]);

export interface AllocationLiabilityPriorItem {
  allocation: RefundVendorOrderAllocation;
  refund?: Refund;
  determination?: VendorLiabilityDetermination | null;
  reversal?: RefundVendorOrderAllocation | null;
}

export interface AllocationLiabilityInput {
  settlement: VendorSettlement;
  allocation: RefundVendorOrderAllocation;
  priorAllocations?: RefundVendorOrderAllocation[];
  priorItems?: AllocationLiabilityPriorItem[];
  refund: Refund;
  determination?: VendorLiabilityDetermination | null;
  reversal?: RefundVendorOrderAllocation | null;
  vendorOrder?: VendorOrder | null;
  payment?: Payment | null;
  order?: Order | null;
  disbursements?: VendorSettlementDisbursement[];
  disbursement?: VendorSettlementDisbursement | null;
  adjustedEntitlement?: Prisma.Decimal | number | string;
}

export interface CumulativeAllocationItem {
  allocation: RefundVendorOrderAllocation;
  refund: Refund;
  determination?: VendorLiabilityDetermination | null;
  vendorOrder?: VendorOrder | null;
  payment?: Payment | null;
  order?: Order | null;
}

export interface AllocationLiabilityCalculation {
  allocationId: string;
  vendorOrderId: string;
  settlementId: string;
  refundId: string;
  entryKind: RefundAllocationEntryKind;
  grossAllocatedAmount: Prisma.Decimal;
  commissionReversedAmount: Prisma.Decimal;
  vendorNetLiability: Prisma.Decimal;
  attributionStatus: LiabilityAttributionStatus;
  exposureCategory: VendorSettlementExposureCategory;
  notes?: string;
}

export interface SettlementCumulativeLiability {
  settlementId: string;
  historicalGross: Prisma.Decimal;
  historicalPlatformFee: Prisma.Decimal;
  historicalNetAmount: Prisma.Decimal;
  cumulativeEligibleRefundGross: Prisma.Decimal;
  cumulativeFeeReversed: Prisma.Decimal;
  cumulativeVendorNetLiability: Prisma.Decimal;
  remainingSettlementNetAmount: Prisma.Decimal;
  allocationsBreakdown: AllocationLiabilityCalculation[];
  exposureCategory: VendorSettlementExposureCategory;
}

function compareAsc(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortAllocationsDeterministically<T extends { createdAt: Date | string; id: string }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const timeDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return compareAsc(a.id, b.id);
  });
}

@Injectable()
export class VendorLiabilityCalculatorService {
  /**
   * Classify exposure strictly using settlement status PLUS authoritative disbursement evidence.
   * Bare PAID status (or paymentDate/notes) without a CONFIRMED disbursement is DISBURSEMENT_UNKNOWN.
   * Partial confirmed disbursements classify as PARTIALLY_DISBURSED rather than full EXTERNALLY_DISBURSED,
   * and active/confirmed disbursements exceeding payable settlement entitlement are rejected.
   */
  classifySettlementExposure(
    settlement: Pick<VendorSettlement, 'status'> &
      Partial<Pick<VendorSettlement, 'id' | 'vendorId' | 'netAmount'>>,
    disbursementsInput?:
      | VendorSettlementDisbursement[]
      | VendorSettlementDisbursement
      | null,
    expectedCurrency?: string,
    options?: {
      adjustedEntitlement?: Prisma.Decimal | number | string;
    },
  ): VendorSettlementExposureCategory {
    return this.resolveConfirmedDisbursementCoverage(
      settlement,
      disbursementsInput,
      expectedCurrency,
      options,
    ).exposureCategory;
  }

  /**
   * Deterministic disbursement coverage policy:
   * - Authoritative payable entitlement is options.adjustedEntitlement (when supplied) else settlement.netAmount.
   * - Cumulative active/confirmed disbursements may never exceed positive payable entitlement.
   * - Max receivable exposure backed by a PAID settlement equals cumulative valid CONFIRMED disbursement amount.
   * - Missing/invalid confirmed evidence preserves DISBURSEMENT_UNKNOWN on PAID settlements (zero receivable ceiling).
   */
  resolveConfirmedDisbursementCoverage(
    settlement: Pick<VendorSettlement, 'status'> &
      Partial<Pick<VendorSettlement, 'id' | 'vendorId' | 'netAmount'>>,
    disbursementsInput?:
      | VendorSettlementDisbursement[]
      | VendorSettlementDisbursement
      | null,
    expectedCurrency?: string,
    options?: {
      adjustedEntitlement?: Prisma.Decimal | number | string;
    },
  ): {
    exposureCategory: VendorSettlementExposureCategory;
    confirmedDisbursedAmount: Prisma.Decimal;
    inFlightDisbursedAmount: Prisma.Decimal;
    maxReceivableCoverageAmount: Prisma.Decimal;
  } {
    const rawList: VendorSettlementDisbursement[] = Array.isArray(disbursementsInput)
      ? disbursementsInput
      : disbursementsInput
        ? [disbursementsInput]
        : [];

    for (const d of rawList) {
      if (settlement.id && d.settlementId !== settlement.id) {
        throw new BadRequestException(
          `Disbursement ${d.id} settlementId (${d.settlementId}) does not match settlement (${settlement.id})`,
        );
      }
      if (settlement.vendorId && d.vendorId !== settlement.vendorId) {
        throw new BadRequestException(
          `Disbursement ${d.id} vendorId (${d.vendorId}) does not match settlement vendorId (${settlement.vendorId})`,
        );
      }
    }

    let confirmedTotal = new Prisma.Decimal('0.00');
    let inFlightTotal = new Prisma.Decimal('0.00');

    for (const d of rawList) {
      const currencyOk = !expectedCurrency || d.currency === expectedCurrency;
      if (!currencyOk) {
        continue;
      }
      if (d.status === VendorSettlementDisbursementStatus.CONFIRMED) {
        const amt = parseExactMonetary2dp(d.amount, 'disbursement.amount', { allowZero: false });
        const hasRef =
          typeof d.externalReference === 'string' && d.externalReference.trim().length > 0;
        const hasConfirmedAt = d.confirmedAt !== null && d.confirmedAt !== undefined;
        if (amt.gt(0) && hasRef && hasConfirmedAt) {
          confirmedTotal = confirmedTotal.plus(amt);
        }
      } else if (d.status === VendorSettlementDisbursementStatus.IN_FLIGHT) {
        const amt = parseExactMonetary2dp(d.amount, 'disbursement.amount', { allowZero: false });
        if (amt.gt(0)) {
          inFlightTotal = inFlightTotal.plus(amt);
        }
      }
    }

    const effectiveEntitlement =
      options?.adjustedEntitlement !== undefined
        ? parseExactMonetary2dp(options.adjustedEntitlement, 'adjustedEntitlement', {
            allowZero: true,
            allowNegative: true,
          })
        : settlement.netAmount !== undefined && settlement.netAmount !== null
          ? parseExactMonetary2dp(settlement.netAmount, 'settlement.netAmount', {
              allowZero: true,
              allowNegative: true,
            })
          : null;

    if (effectiveEntitlement !== null) {
      if (effectiveEntitlement.lte(0) && (confirmedTotal.gt(0) || inFlightTotal.gt(0))) {
        throw new BadRequestException(
          `Zero or negative settlement entitlement (${effectiveEntitlement}) cannot support active or confirmed disbursements`,
        );
      }
      if (confirmedTotal.gt(effectiveEntitlement)) {
        throw new BadRequestException(
          `Confirmed disbursement total (${confirmedTotal}) exceeds settlement payable entitlement (${effectiveEntitlement})`,
        );
      }
      if (confirmedTotal.plus(inFlightTotal).gt(effectiveEntitlement)) {
        throw new BadRequestException(
          `Cumulative active disbursements (${confirmedTotal.plus(inFlightTotal)}) exceed settlement payable entitlement (${effectiveEntitlement})`,
        );
      }
    }

    let exposureCategory: VendorSettlementExposureCategory;
    let maxReceivableCoverageAmount = new Prisma.Decimal('0.00');

    switch (settlement.status) {
      case VendorSettlementStatus.PENDING:
        exposureCategory = VendorSettlementExposureCategory.UNPAID_ENTITLEMENT;
        break;
      case VendorSettlementStatus.APPROVED:
        exposureCategory = inFlightTotal.gt(0)
          ? VendorSettlementExposureCategory.PAYOUT_IN_FLIGHT
          : VendorSettlementExposureCategory.UNPAID_ENTITLEMENT;
        break;
      case VendorSettlementStatus.PAID:
        if (confirmedTotal.gt(0)) {
          maxReceivableCoverageAmount = confirmedTotal;
          exposureCategory =
            effectiveEntitlement !== null && confirmedTotal.lt(effectiveEntitlement)
              ? VendorSettlementExposureCategory.PARTIALLY_DISBURSED
              : VendorSettlementExposureCategory.EXTERNALLY_DISBURSED;
        } else if (inFlightTotal.gt(0)) {
          exposureCategory = VendorSettlementExposureCategory.PAYOUT_IN_FLIGHT;
        } else {
          exposureCategory = VendorSettlementExposureCategory.DISBURSEMENT_UNKNOWN;
        }
        break;
      case VendorSettlementStatus.FAILED:
      default:
        exposureCategory = VendorSettlementExposureCategory.UNRESOLVED;
        break;
    }

    return {
      exposureCategory,
      confirmedDisbursedAmount: confirmedTotal,
      inFlightDisbursedAmount: inFlightTotal,
      maxReceivableCoverageAmount,
    };
  }

  private validateSettlementAmounts(settlement: VendorSettlement): {
    histGross: Prisma.Decimal;
    histFee: Prisma.Decimal;
    histNet: Prisma.Decimal;
  } {
    const histGross = parseExactMonetary2dp(settlement.grossAmount, 'settlement.grossAmount', {
      allowZero: true,
    });
    const histFee = parseExactMonetary2dp(settlement.platformFee, 'settlement.platformFee', {
      allowZero: true,
    });
    const histNet = parseExactMonetary2dp(settlement.netAmount, 'settlement.netAmount', {
      allowZero: true,
    });
    if (!histGross.minus(histFee).equals(histNet)) {
      throw new BadRequestException(
        `Settlement netAmount (${histNet}) must equal grossAmount (${histGross}) - platformFee (${histFee})`,
      );
    }
    return { histGross, histFee, histNet };
  }

  private validateEntityHierarchy(params: {
    settlement: VendorSettlement;
    allocation: RefundVendorOrderAllocation;
    refund: Refund;
    vendorOrder?: VendorOrder | null;
    payment?: Payment | null;
    order?: Order | null;
  }): void {
    const { settlement, allocation, refund, vendorOrder, payment, order } = params;

    if (allocation.refundId !== refund.id) {
      throw new BadRequestException(
        `Allocation refundId (${allocation.refundId}) does not match refund id (${refund.id})`,
      );
    }

    if (allocation.vendorOrderId !== settlement.vendorOrderId) {
      throw new BadRequestException(
        `Allocation vendorOrderId (${allocation.vendorOrderId}) does not match settlement vendorOrderId (${settlement.vendorOrderId})`,
      );
    }

    if (vendorOrder) {
      if (vendorOrder.id !== settlement.vendorOrderId) {
        throw new BadRequestException(
          `VendorOrder id (${vendorOrder.id}) does not match settlement vendorOrderId (${settlement.vendorOrderId})`,
        );
      }
      if (vendorOrder.vendorId !== settlement.vendorId) {
        throw new BadRequestException(
          `VendorOrder vendorId (${vendorOrder.vendorId}) does not match settlement vendorId (${settlement.vendorId})`,
        );
      }
    }

    if (payment) {
      if (refund.paymentId !== payment.id) {
        throw new BadRequestException(
          `Refund paymentId (${refund.paymentId}) does not match payment id (${payment.id})`,
        );
      }
      if (vendorOrder && payment.orderId !== vendorOrder.orderId) {
        throw new BadRequestException(
          `Payment orderId (${payment.orderId}) does not match vendorOrder orderId (${vendorOrder.orderId})`,
        );
      }
      if (allocation.currency !== payment.currency) {
        throw new BadRequestException(
          `Allocation currency (${allocation.currency}) does not match payment currency (${payment.currency})`,
        );
      }
    }

    if (order) {
      if (vendorOrder && vendorOrder.orderId !== order.id) {
        throw new BadRequestException(
          `VendorOrder orderId (${vendorOrder.orderId}) does not match order id (${order.id})`,
        );
      }
      if (payment && payment.orderId !== order.id) {
        throw new BadRequestException(
          `Payment orderId (${payment.orderId}) does not match order id (${order.id})`,
        );
      }
      if (order.currency && allocation.currency !== order.currency) {
        throw new BadRequestException(
          `Allocation currency (${allocation.currency}) does not match order currency (${order.currency})`,
        );
      }
    }
  }

  private resolveAttributionStatus(params: {
    allocation: RefundVendorOrderAllocation;
    refund: Refund;
    determination?: VendorLiabilityDetermination | null;
  }): LiabilityAttributionStatus {
    const { allocation, refund, determination } = params;

    if (refund.status === RefundStatus.FAILED) {
      return LiabilityAttributionStatus.FAILED_REFUND_EXCLUDED;
    }

    if (!determination || determination.decision === VendorLiabilityDecision.UNRESOLVED) {
      return LiabilityAttributionStatus.UNATTRIBUTED;
    }

    if (determination.allocationId !== allocation.id) {
      throw new BadRequestException(
        `Determination allocationId (${determination.allocationId}) does not match allocation id (${allocation.id})`,
      );
    }

    if (determination.decision === VendorLiabilityDecision.PLATFORM_CONCESSION) {
      return LiabilityAttributionStatus.PLATFORM_CONCESSION;
    }

    if (!VENDOR_FAULT_CATEGORIES.has(determination.category)) {
      throw new BadRequestException(
        `Invalid vendor responsibility category "${determination.category}" for determination ${determination.id}`,
      );
    }

    if (
      allocation.allocationType === RefundAllocationType.MANUAL_SUPERVISOR_ADJUSTMENT &&
      (!determination.evidenceReference || determination.evidenceReference.trim().length === 0)
    ) {
      throw new BadRequestException(
        `MANUAL_SUPERVISOR_ADJUSTMENT allocation ${allocation.id} requires non-empty evidenceReference on determination`,
      );
    }

    return refund.status === RefundStatus.COMPLETED
      ? LiabilityAttributionStatus.CONFIRMED_LIABILITY
      : LiabilityAttributionStatus.PROVISIONAL_ATTRIBUTION;
  }

  private computeActiveAllocationNetAmount(
    allocation: RefundVendorOrderAllocation,
    reversal?: RefundVendorOrderAllocation | null,
  ): Prisma.Decimal {
    if (allocation.entryKind !== RefundAllocationEntryKind.ALLOCATION) {
      throw new BadRequestException(
        `Expected ALLOCATION entryKind for ${allocation.id}, got ${allocation.entryKind}`,
      );
    }

    const allocAmount = parseExactMonetary2dp(allocation.amount, 'allocation.amount', {
      allowZero: false,
      allowNegative: false,
    });

    if (!reversal) {
      return allocAmount;
    }

    if (reversal.entryKind !== RefundAllocationEntryKind.REVERSAL) {
      throw new BadRequestException(
        `Expected REVERSAL entryKind for ${reversal.id}, got ${reversal.entryKind}`,
      );
    }
    if (reversal.reversesAllocationId !== allocation.id) {
      throw new BadRequestException(
        `Reversal ${reversal.id} targets ${reversal.reversesAllocationId}, not ${allocation.id}`,
      );
    }
    if (
      reversal.refundId !== allocation.refundId ||
      reversal.vendorOrderId !== allocation.vendorOrderId ||
      reversal.currency !== allocation.currency
    ) {
      throw new BadRequestException(
        `Reversal ${reversal.id} identity/currency does not match original allocation ${allocation.id}`,
      );
    }

    const revAmount = parseExactMonetary2dp(reversal.amount, 'reversal.amount', {
      onlyNegative: true,
    });
    const netAmount = allocAmount.plus(revAmount);
    if (netAmount.lt(0)) {
      throw new BadRequestException(
        `Reversal magnitude (${revAmount.abs()}) exceeds original allocation amount (${allocAmount})`,
      );
    }
    return netAmount;
  }

  private resolvePriorGrossSum(
    settlement: VendorSettlement,
    targetCurrency: string,
    priorAllocations?: RefundVendorOrderAllocation[],
    priorItems?: AllocationLiabilityPriorItem[],
    targetAllocationId?: string,
    targetReversalId?: string | null,
  ): Prisma.Decimal {
    if (
      priorItems &&
      priorItems.length > 0 &&
      priorAllocations &&
      priorAllocations.length > 0
    ) {
      throw new BadRequestException(
        'Conflicting prior liability inputs: provide either priorItems or priorAllocations, not both',
      );
    }

    let priorCumGross = new Prisma.Decimal('0.00');

    if (priorItems && priorItems.length > 0) {
      const seenPriorAllocIds = new Set<string>();
      const seenPriorReversalIds = new Set<string>();

      for (const item of priorItems) {
        if (item.allocation.entryKind !== RefundAllocationEntryKind.ALLOCATION) {
          throw new BadRequestException(
            `Prior item ${item.allocation.id} must have entryKind ALLOCATION, got ${item.allocation.entryKind}`,
          );
        }
        if (targetAllocationId && item.allocation.id === targetAllocationId) {
          throw new BadRequestException(
            `Prior item ${item.allocation.id} overlaps with target allocation ${targetAllocationId}`,
          );
        }
        if (targetReversalId && item.allocation.id === targetReversalId) {
          throw new BadRequestException(
            `Prior item ${item.allocation.id} overlaps with target reversal ${targetReversalId}`,
          );
        }
        if (seenPriorAllocIds.has(item.allocation.id)) {
          throw new BadRequestException(
            `Duplicate prior allocation ${item.allocation.id} in priorItems`,
          );
        }
        seenPriorAllocIds.add(item.allocation.id);

        if (item.reversal) {
          if (item.reversal.entryKind !== RefundAllocationEntryKind.REVERSAL) {
            throw new BadRequestException(
              `Prior reversal ${item.reversal.id} must have entryKind REVERSAL`,
            );
          }
          if (item.reversal.reversesAllocationId !== item.allocation.id) {
            throw new BadRequestException(
              `Prior reversal ${item.reversal.id} reversesAllocationId (${item.reversal.reversesAllocationId}) does not match prior allocation ${item.allocation.id}`,
            );
          }
          if (targetAllocationId && item.reversal.reversesAllocationId === targetAllocationId) {
            throw new BadRequestException(
              `Prior reversal ${item.reversal.id} overlaps with target allocation ${targetAllocationId}`,
            );
          }
          if (seenPriorReversalIds.has(item.reversal.id)) {
            throw new BadRequestException(
              `Duplicate prior reversal ${item.reversal.id} in priorItems`,
            );
          }
          seenPriorReversalIds.add(item.reversal.id);
        }
      }

      const sorted = sortAllocationsDeterministically(
        priorItems.map((item) => ({
          ...item,
          createdAt: item.allocation.createdAt,
          id: item.allocation.id,
        })),
      );
      for (const item of sorted) {
        if (item.allocation.vendorOrderId !== settlement.vendorOrderId) {
          throw new BadRequestException(
            `Prior allocation ${item.allocation.id} vendorOrderId (${item.allocation.vendorOrderId}) does not match settlement (${settlement.vendorOrderId})`,
          );
        }
        if (item.allocation.currency !== targetCurrency) {
          throw new BadRequestException(
            `Prior allocation ${item.allocation.id} currency (${item.allocation.currency}) does not match ${targetCurrency}`,
          );
        }
        if (item.refund) {
          if (item.allocation.refundId !== item.refund.id) {
            throw new BadRequestException(
              `Prior allocation ${item.allocation.id} refundId does not match prior refund ${item.refund.id}`,
            );
          }
          if (item.refund.status !== RefundStatus.COMPLETED) {
            continue;
          }
        }
        if (item.determination !== undefined) {
          if (
            !item.determination ||
            item.determination.decision !== VendorLiabilityDecision.VENDOR_RESPONSIBLE
          ) {
            continue;
          }
        }
        const net = this.computeActiveAllocationNetAmount(item.allocation, item.reversal);
        priorCumGross = priorCumGross.plus(net);
      }
      return priorCumGross;
    }

    if (!priorAllocations || priorAllocations.length === 0) {
      return priorCumGross;
    }

    const seenEntryIds = new Set<string>();
    const allocationsById = new Map<string, RefundVendorOrderAllocation>();
    const reversalsByOrigId = new Map<string, RefundVendorOrderAllocation>();

    for (const entry of priorAllocations) {
      if (seenEntryIds.has(entry.id)) {
        throw new BadRequestException(
          `Duplicate prior allocation entry ${entry.id} in priorAllocations`,
        );
      }
      seenEntryIds.add(entry.id);

      if (targetAllocationId && entry.id === targetAllocationId) {
        throw new BadRequestException(
          `Prior entry ${entry.id} overlaps with target allocation ${targetAllocationId}`,
        );
      }
      if (targetReversalId && entry.id === targetReversalId) {
        throw new BadRequestException(
          `Prior entry ${entry.id} overlaps with target reversal ${targetReversalId}`,
        );
      }
      if (targetAllocationId && entry.reversesAllocationId === targetAllocationId) {
        throw new BadRequestException(
          `Prior reversal ${entry.id} targets overlapping current allocation ${targetAllocationId}`,
        );
      }

      if (entry.vendorOrderId !== settlement.vendorOrderId) {
        throw new BadRequestException(
          `Prior allocation ${entry.id} vendorOrderId (${entry.vendorOrderId}) does not match settlement (${settlement.vendorOrderId})`,
        );
      }
      if (entry.currency !== targetCurrency) {
        throw new BadRequestException(
          `Prior allocation ${entry.id} currency (${entry.currency}) does not match ${targetCurrency}`,
        );
      }
      if (entry.entryKind === RefundAllocationEntryKind.ALLOCATION) {
        allocationsById.set(entry.id, entry);
      } else {
        if (!entry.reversesAllocationId) {
          throw new BadRequestException(`Prior reversal ${entry.id} lacks reversesAllocationId`);
        }
        if (reversalsByOrigId.has(entry.reversesAllocationId)) {
          throw new BadRequestException(
            `Duplicate reversal for prior allocation ${entry.reversesAllocationId}`,
          );
        }
        reversalsByOrigId.set(entry.reversesAllocationId, entry);
      }
    }

    for (const [origId, rev] of reversalsByOrigId.entries()) {
      if (!allocationsById.has(origId)) {
        throw new BadRequestException(
          `Prior reversal ${rev.id} references unknown prior allocation ${origId}`,
        );
      }
    }

    const sortedAllocs = sortAllocationsDeterministically(Array.from(allocationsById.values()));
    for (const alloc of sortedAllocs) {
      const net = this.computeActiveAllocationNetAmount(alloc, reversalsByOrigId.get(alloc.id) ?? null);
      priorCumGross = priorCumGross.plus(net);
    }

    return priorCumGross;
  }

  /**
   * Calculate exact vendor liability and historical commission reversal for a single allocation.
   * Requires strict entity coherence, explicit VENDOR_RESPONSIBLE determination, positive ALLOCATION,
   * exact 2dp inputs, non-overlapping priors, and cumulative commission/gross ceilings.
   */
  calculateAllocationLiability(params: AllocationLiabilityInput): AllocationLiabilityCalculation {
    const {
      settlement,
      allocation,
      priorAllocations,
      priorItems,
      refund,
      determination,
      reversal,
      vendorOrder,
      payment,
      order,
      disbursements,
      disbursement,
      adjustedEntitlement,
    } = params;

    this.validateEntityHierarchy({
      settlement,
      allocation,
      refund,
      vendorOrder,
      payment,
      order,
    });

    const { histGross, histFee, histNet } = this.validateSettlementAmounts(settlement);
    const activeGross = this.computeActiveAllocationNetAmount(allocation, reversal);

    // Always validate prior identity non-overlap & non-duplication even when target is excluded/unattributed
    const priorCumGross = this.resolvePriorGrossSum(
      settlement,
      allocation.currency,
      priorAllocations,
      priorItems,
      allocation.id,
      reversal?.id ?? null,
    );

    const disbInput = disbursements ?? (disbursement ? [disbursement] : undefined);
    const exposureCategory = this.classifySettlementExposure(
      settlement,
      disbInput,
      allocation.currency,
      adjustedEntitlement !== undefined ? { adjustedEntitlement } : undefined,
    );

    if (activeGross.isZero()) {
      return {
        allocationId: allocation.id,
        vendorOrderId: allocation.vendorOrderId,
        settlementId: settlement.id,
        refundId: refund.id,
        entryKind: allocation.entryKind,
        grossAllocatedAmount: new Prisma.Decimal('0.00'),
        commissionReversedAmount: new Prisma.Decimal('0.00'),
        vendorNetLiability: new Prisma.Decimal('0.00'),
        attributionStatus: LiabilityAttributionStatus.REVERSED_ALLOCATION_EXCLUDED,
        exposureCategory,
        notes: 'Allocation fully reversed: zero remaining liability.',
      };
    }

    const attributionStatus = this.resolveAttributionStatus({
      allocation,
      refund,
      determination,
    });

    if (
      attributionStatus === LiabilityAttributionStatus.FAILED_REFUND_EXCLUDED ||
      attributionStatus === LiabilityAttributionStatus.PLATFORM_CONCESSION ||
      attributionStatus === LiabilityAttributionStatus.UNATTRIBUTED
    ) {
      const reasonNote =
        attributionStatus === LiabilityAttributionStatus.FAILED_REFUND_EXCLUDED
          ? 'Refund FAILED: capacity released, zero vendor clawback liability.'
          : attributionStatus === LiabilityAttributionStatus.PLATFORM_CONCESSION
            ? 'Explicit platform concession determination: zero vendor liability.'
            : 'No VENDOR_RESPONSIBLE determination recorded: unattributed (zero assumed vendor liability).';

      return {
        allocationId: allocation.id,
        vendorOrderId: allocation.vendorOrderId,
        settlementId: settlement.id,
        refundId: refund.id,
        entryKind: allocation.entryKind,
        grossAllocatedAmount: new Prisma.Decimal('0.00'),
        commissionReversedAmount: new Prisma.Decimal('0.00'),
        vendorNetLiability: new Prisma.Decimal('0.00'),
        attributionStatus,
        exposureCategory,
        notes: reasonNote,
      };
    }

    const newCumGross = priorCumGross.plus(activeGross);

    if (newCumGross.gt(histGross)) {
      throw new BadRequestException(
        `Cumulative refund allocation gross (${newCumGross}) exceeds settlement historical grossAmount (${histGross})`,
      );
    }

    let priorCumFee = new Prisma.Decimal('0.00');
    let newCumFee = new Prisma.Decimal('0.00');

    if (!histGross.isZero()) {
      if (!priorCumGross.isZero()) {
        priorCumFee = histFee
          .mul(priorCumGross)
          .div(histGross)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      }
      if (!newCumGross.isZero()) {
        newCumFee = histFee
          .mul(newCumGross)
          .div(histGross)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      }
    }

    if (newCumFee.lt(0) || newCumFee.gt(histFee)) {
      throw new BadRequestException(
        `Cumulative fee reversed (${newCumFee}) violates settlement fee bounds [0, ${histFee}]`,
      );
    }

    const commissionReversedAmount = newCumFee.minus(priorCumFee);
    const vendorNetLiability = activeGross.minus(commissionReversedAmount);

    if (vendorNetLiability.lt(0) || newCumGross.minus(newCumFee).gt(histNet)) {
      throw new BadRequestException(
        `Calculated vendor net liability (${vendorNetLiability}) violates remaining settlement net cap (${histNet})`,
      );
    }

    return {
      allocationId: allocation.id,
      vendorOrderId: allocation.vendorOrderId,
      settlementId: settlement.id,
      refundId: refund.id,
      entryKind: allocation.entryKind,
      grossAllocatedAmount: activeGross,
      commissionReversedAmount,
      vendorNetLiability,
      attributionStatus,
      exposureCategory,
      notes:
        attributionStatus === LiabilityAttributionStatus.PROVISIONAL_ATTRIBUTION
          ? 'Provisional allocation awaiting refund completion; not confirmed for settlement deduction or receivable creation.'
          : undefined,
    };
  }

  /**
   * Permutation-invariant cumulative liability calculation across allocations for a settlement.
   * Pairs REVERSAL rows cleanly, sorts deterministically by (createdAt ASC, id ASC),
   * and excludes FAILED, provisional, concession, unattributed, and fully reversed allocations
   * from confirmed cumulative totals.
   */
  calculateSettlementCumulativeLiability(params: {
    settlement: VendorSettlement;
    allocations: CumulativeAllocationItem[];
    disbursements?: VendorSettlementDisbursement[];
    disbursement?: VendorSettlementDisbursement | null;
    adjustedEntitlement?: Prisma.Decimal | number | string;
  }): SettlementCumulativeLiability {
    const { settlement, allocations, disbursements, disbursement, adjustedEntitlement } = params;
    const { histGross, histFee, histNet } = this.validateSettlementAmounts(settlement);

    const disbInput = disbursements ?? (disbursement ? [disbursement] : undefined);
    let expectedCurrency: string | undefined;

    const seenIds = new Set<string>();
    const allocMap = new Map<string, CumulativeAllocationItem>();
    const reversalByOrigId = new Map<string, CumulativeAllocationItem>();

    for (const item of allocations) {
      this.validateEntityHierarchy({
        settlement,
        allocation: item.allocation,
        refund: item.refund,
        vendorOrder: item.vendorOrder,
        payment: item.payment,
        order: item.order,
      });

      if (seenIds.has(item.allocation.id)) {
        throw new BadRequestException(`Duplicate allocation/reversal entry ${item.allocation.id} in input`);
      }
      seenIds.add(item.allocation.id);

      if (!expectedCurrency) {
        expectedCurrency = item.allocation.currency;
      } else if (item.allocation.currency !== expectedCurrency) {
        throw new BadRequestException(
          `Inconsistent allocation currencies for settlement ${settlement.id}: ${expectedCurrency} vs ${item.allocation.currency}`,
        );
      }

      if (item.allocation.entryKind === RefundAllocationEntryKind.ALLOCATION) {
        parseExactMonetary2dp(item.allocation.amount, 'allocation.amount', {
          allowZero: false,
          allowNegative: false,
        });
        allocMap.set(item.allocation.id, item);
      } else {
        if (!item.allocation.reversesAllocationId) {
          throw new BadRequestException(
            `Reversal ${item.allocation.id} must specify reversesAllocationId`,
          );
        }
        if (reversalByOrigId.has(item.allocation.reversesAllocationId)) {
          throw new BadRequestException(
            `Duplicate reversal targeting allocation ${item.allocation.reversesAllocationId}`,
          );
        }
        reversalByOrigId.set(item.allocation.reversesAllocationId, item);
      }
    }

    for (const [origId, revItem] of reversalByOrigId.entries()) {
      if (!allocMap.has(origId)) {
        throw new BadRequestException(
          `Reversal ${revItem.allocation.id} references unknown allocation ${origId}`,
        );
      }
    }

    const exposureCategory = this.classifySettlementExposure(
      settlement,
      disbInput,
      expectedCurrency,
      adjustedEntitlement !== undefined ? { adjustedEntitlement } : undefined,
    );

    const sortedItems = sortAllocationsDeterministically(
      Array.from(allocMap.values()).map((item) => ({
        ...item,
        createdAt: item.allocation.createdAt,
        id: item.allocation.id,
      })),
    );

    const breakdowns: AllocationLiabilityCalculation[] = [];
    const confirmedPriorItems: AllocationLiabilityPriorItem[] = [];

    let cumEligibleGross = new Prisma.Decimal('0.00');
    let cumFeeReversed = new Prisma.Decimal('0.00');
    let cumNetLiability = new Prisma.Decimal('0.00');

    for (const item of sortedItems) {
      const matchedReversal = reversalByOrigId.get(item.allocation.id)?.allocation ?? null;
      const calc = this.calculateAllocationLiability({
        settlement,
        allocation: item.allocation,
        priorItems: confirmedPriorItems,
        refund: item.refund,
        determination: item.determination,
        reversal: matchedReversal,
        vendorOrder: item.vendorOrder,
        payment: item.payment,
        order: item.order,
        disbursements: disbInput,
        adjustedEntitlement,
      });

      breakdowns.push(calc);

      if (calc.attributionStatus === LiabilityAttributionStatus.CONFIRMED_LIABILITY) {
        confirmedPriorItems.push({
          allocation: item.allocation,
          refund: item.refund,
          determination: item.determination,
          reversal: matchedReversal,
        });
        cumEligibleGross = cumEligibleGross.plus(calc.grossAllocatedAmount);
        cumFeeReversed = cumFeeReversed.plus(calc.commissionReversedAmount);
        cumNetLiability = cumNetLiability.plus(calc.vendorNetLiability);
      }
    }

    const remainingNet = histNet.minus(cumNetLiability);
    if (remainingNet.lt(0)) {
      throw new BadRequestException(
        `Remaining settlement net amount (${remainingNet}) cannot be negative`,
      );
    }

    return {
      settlementId: settlement.id,
      historicalGross: histGross,
      historicalPlatformFee: histFee,
      historicalNetAmount: histNet,
      cumulativeEligibleRefundGross: cumEligibleGross,
      cumulativeFeeReversed: cumFeeReversed,
      cumulativeVendorNetLiability: cumNetLiability,
      remainingSettlementNetAmount: remainingNet,
      allocationsBreakdown: breakdowns,
      exposureCategory,
    };
  }
}
