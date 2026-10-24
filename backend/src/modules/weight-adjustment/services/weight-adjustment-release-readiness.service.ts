import { Injectable, Logger } from '@nestjs/common';
import {
  CertificationStatus,
  CustomerWeightApprovalStatus,
  FishermanStatus,
  FoodSafetyStatus,
  PaymentObligationDirection,
  PaymentProviderName,
  Prisma,
  RoleName,
  VendorStatus,
  WeightMeasurementStatus,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../database/prisma.service';
import { AdjustmentNotFoundError } from '../repositories/errors/weight-adjustment-repository.errors';
import { WeightAdjustmentSafetyGateService } from './weight-adjustment-safety-gate.service';
import { WeightAdjustmentSettlementService } from './weight-adjustment-settlement.service';
import {
  EvaluateReleaseReadinessInput,
  GateAssessment,
  ReleaseReadinessEvaluationResult,
} from './types/weight-adjustment-coordination.types';

@Injectable()
export class WeightAdjustmentReleaseReadinessService {
  private readonly logger = new Logger(WeightAdjustmentReleaseReadinessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly safetyGate: WeightAdjustmentSafetyGateService,
    private readonly settlementService: WeightAdjustmentSettlementService,
  ) {}

  /**
   * Evaluates the five independent release readiness gates for an adjusted seafood item.
   *
   * Five Independent Gates:
   * 1. Scale Measurement: Verified by operator, valid positive weight on active revision.
   * 2. Authoritative Food Safety & Regulatory: Active check of SeafoodLot status (SAFE, zero recalls)
   *    and vendor/fisherman active regulatory credentials.
   * 3. Customer Approval: NOT_REQUIRED or APPROVED_BY_CUSTOMER bound to active measurement revision.
   * 4. Preparation Fulfillment: Completed if requested; NOT_REQUIRED if no service selected.
   * 5. Financial Settlement: Fully settled or COD pending collection (for dispatch) vs fully discharged (for handover).
   *
   * Operational Separation:
   * - dispatchReady: Product is prepared, safe, approved, and authorized for driver collection / loading.
   * - handoverReady: Product is physically authorized for customer release (COD requires doorstep cash receipt).
   * - Customer credit due does not block release of an otherwise paid order.
   * - Fails closed if any gate or authoritative status cannot be verified.
   */
  async evaluateReleaseReadiness(
    input: EvaluateReleaseReadinessInput,
    tx?: Prisma.TransactionClient,
  ): Promise<ReleaseReadinessEvaluationResult> {
    const client = tx ?? this.prisma;

    // 1. Fetch Weight Adjustment with complete operational context
    const adjustment = await client.seafoodOrderWeightAdjustment.findUnique({
      where: { id: input.weightAdjustmentId },
      include: {
        orderItem: {
          include: {
            vendorOrder: {
              include: {
                order: {
                  include: {
                    payment: true,
                  },
                },
                delivery: {
                  include: {
                    driver: true,
                  },
                },
                vendor: {
                  include: {
                    user: {
                      include: {
                        roles: { include: { role: true } },
                        fisherman: {
                          include: {
                            certifications: {
                              include: { issuingAuthority: true },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            product: {
              include: {
                lot: true,
              },
            },
          },
        },
        financialObligations: {
          include: { settlementRecords: true },
          orderBy: { revision: 'desc' },
        },
      },
    });

    if (!adjustment) {
      throw new AdjustmentNotFoundError(input.weightAdjustmentId);
    }

    const orderItem = adjustment.orderItem;
    const vendorOrder = orderItem.vendorOrder;
    const vendor = vendorOrder.vendor;
    const order = vendorOrder.order;
    const activeRevision = adjustment.activeMeasurementRevision ?? 0;

    // =========================================================================
    // Gate 1: Scale Measurement Verification
    // =========================================================================
    let gate1: GateAssessment;
    const isMeasurementVerified =
      adjustment.measurementStatus === WeightMeasurementStatus.MEASURED_WITHIN_CEILING ||
      adjustment.measurementStatus === WeightMeasurementStatus.MEASURED_EXCEEDS_CEILING ||
      adjustment.measurementStatus === WeightMeasurementStatus.SETTLED;
    const hasActiveRevision = activeRevision >= 1;
    const hasVerifiedWeight =
      adjustment.verifiedBillableWeight !== null &&
      new Decimal(adjustment.verifiedBillableWeight.toString()).greaterThan(0);

    if (isMeasurementVerified && hasActiveRevision && hasVerifiedWeight) {
      gate1 = {
        gateName: 'GATE_1_SCALE_MEASUREMENT',
        status: 'PASSED',
        details: `Verified billable weight ${adjustment.verifiedBillableWeight} ${adjustment.unit} on revision ${activeRevision}.`,
      };
    } else {
      gate1 = {
        gateName: 'GATE_1_SCALE_MEASUREMENT',
        status: 'BLOCKED',
        details: 'Scale measurement has not been verified by operator on scale.',
      };
    }

    // =========================================================================
    // Gate 2: Live Food Safety & Regulatory Verification
    // =========================================================================
    let gate2: GateAssessment;
    try {
      // 2a. Live query of physical lot provenance (fail closed if original lot or listing provenance is missing)
      const persistedLotId = ((orderItem as any).originalLotId ??
        (orderItem as any).lotId) as string | undefined;
      const persistedListingId = ((orderItem as any).originalListingId ??
        (orderItem as any).listingId) as string | undefined;

      if (!persistedLotId) {
        gate2 = {
          gateName: 'GATE_2_FOOD_SAFETY_AND_REGULATORY',
          status: 'BLOCKED',
          details: 'Missing authoritative original-lot provenance on purchased order item.',
        };
      } else if (!persistedListingId) {
        gate2 = {
          gateName: 'GATE_2_FOOD_SAFETY_AND_REGULATORY',
          status: 'BLOCKED',
          details: 'Missing authoritative original-listing provenance on purchased order item.',
        };
      } else {
        // Assert lot safe live via safety gate service (checks lot status, recalls, temperature)
        await this.safetyGate.assertLotSafeForFulfillment(
          {
            seafoodLotId: persistedLotId,
            vendorId: vendor.id,
            atDate: new Date(),
          },
          client,
        );

        // 2b. Vendor & Fisherman Regulatory Credentials Verification
        if (vendor.status !== VendorStatus.APPROVED) {
          gate2 = {
            gateName: 'GATE_2_FOOD_SAFETY_AND_REGULATORY',
            status: 'BLOCKED',
            details: `Vendor "${vendor.id}" is not approved (status: ${vendor.status}).`,
          };
        } else {
          const vendorUser = vendor.user;
          const userRoles = (vendorUser?.roles ?? []).map((r) => r.role.name);
          const hasFishermanRole = userRoles.includes(RoleName.FISHERMAN);

          if (hasFishermanRole) {
            const fisherman = vendorUser.fisherman;
            if (!fisherman || fisherman.status !== FishermanStatus.APPROVED) {
              gate2 = {
                gateName: 'GATE_2_FOOD_SAFETY_AND_REGULATORY',
                status: 'BLOCKED',
                details: `Fisherman profile is missing or not approved (status: ${fisherman?.status}).`,
              };
            } else {
              const now = new Date();
              const certs = fisherman.certifications ?? [];
              const isFisheriesLicence = (type: string) => {
                const t = type.toUpperCase().trim();
                return (
                  t.includes('FISHING_LICENCE') ||
                  t.includes('FISHING_LICENSE') ||
                  t.includes('FISHERIES_LICENCE') ||
                  t.includes('FISHERIES_LICENSE') ||
                  t.includes('COMMERCIAL_FISHER') ||
                  t.includes('COMMERCIAL_FISHING') ||
                  t === 'FISHING_PERMIT' ||
                  t === 'FISHERMAN_LICENCE' ||
                  t === 'FISHERMAN_LICENSE'
                );
              };

              const validLicence = certs.find((c) => {
                const isCat = isFisheriesLicence(c.certificateType);
                const isActive = c.status === CertificationStatus.ACTIVE;
                const isNotExpired = !c.expiryDate || c.expiryDate >= now;
                return isCat && isActive && isNotExpired;
              });

              if (!validLicence) {
                gate2 = {
                  gateName: 'GATE_2_FOOD_SAFETY_AND_REGULATORY',
                  status: 'BLOCKED',
                  details: 'Fisherman lacks an active, unexpired commercial fisheries licence.',
                };
              } else {
                gate2 = {
                  gateName: 'GATE_2_FOOD_SAFETY_AND_REGULATORY',
                  status: 'PASSED',
                  details: 'Seafood lot is SAFE with no active recalls; vendor and fisheries regulatory credentials are active.',
                };
              }
            }
          } else {
            gate2 = {
              gateName: 'GATE_2_FOOD_SAFETY_AND_REGULATORY',
              status: 'PASSED',
              details: 'Seafood lot is SAFE with no active recalls; vendor regulatory status is APPROVED.',
            };
          }
        }
      }
    } catch (err: any) {
      gate2 = {
        gateName: 'GATE_2_FOOD_SAFETY_AND_REGULATORY',
        status: 'BLOCKED',
        details: err?.message ?? 'Authoritative food safety verification failed.',
      };
    }

    // =========================================================================
    // Gate 3: Customer Approval Verification
    // =========================================================================
    let gate3: GateAssessment;
    switch (adjustment.customerApprovalStatus) {
      case CustomerWeightApprovalStatus.NOT_REQUIRED:
        gate3 = {
          gateName: 'GATE_3_CUSTOMER_APPROVAL',
          status: 'PASSED',
          details: 'Measured total does not exceed authorized ceiling; customer approval not required.',
        };
        break;
      case CustomerWeightApprovalStatus.APPROVED_BY_CUSTOMER:
        if (adjustment.boundApprovalRevision === activeRevision) {
          gate3 = {
            gateName: 'GATE_3_CUSTOMER_APPROVAL',
            status: 'PASSED',
            details: `Approved by customer on active revision ${activeRevision}.`,
          };
        } else {
          gate3 = {
            gateName: 'GATE_3_CUSTOMER_APPROVAL',
            status: 'BLOCKED',
            details: `Customer approval is bound to revision ${adjustment.boundApprovalRevision}, but active measurement revision is ${activeRevision}.`,
          };
        }
        break;
      case CustomerWeightApprovalStatus.AWAITING_APPROVAL:
        gate3 = {
          gateName: 'GATE_3_CUSTOMER_APPROVAL',
          status: 'BLOCKED',
          details: 'Measured item total exceeds authorized ceiling; awaiting customer approval.',
        };
        break;
      case CustomerWeightApprovalStatus.REJECTED_BY_CUSTOMER:
        gate3 = {
          gateName: 'GATE_3_CUSTOMER_APPROVAL',
          status: 'REJECTED',
          details: 'Customer explicitly rejected weight adjustment.',
        };
        break;
      case CustomerWeightApprovalStatus.AUTO_EXPIRED:
        gate3 = {
          gateName: 'GATE_3_CUSTOMER_APPROVAL',
          status: 'EXPIRED',
          details: 'Customer approval challenge expired without decision.',
        };
        break;
      default:
        gate3 = {
          gateName: 'GATE_3_CUSTOMER_APPROVAL',
          status: 'BLOCKED',
          details: `Unknown customer approval status: ${adjustment.customerApprovalStatus}`,
        };
    }

    // =========================================================================
    // Gate 4: Preparation Fulfillment Verification
    // =========================================================================
    let gate4: GateAssessment;
    if (!adjustment.preparationServiceName) {
      gate4 = {
        gateName: 'GATE_4_PREPARATION_FULFILLMENT',
        status: 'NOT_REQUIRED',
        details: 'No preparation service requested for this seafood item.',
      };
    } else {
      const isPreparationFulfilled =
        adjustment.activePreparationRevision !== null &&
        adjustment.activePreparationRevision >= 1 &&
        adjustment.preparedNetWeight !== null;

      if (isPreparationFulfilled) {
        gate4 = {
          gateName: 'GATE_4_PREPARATION_FULFILLMENT',
          status: 'PASSED',
          details: `Preparation "${adjustment.preparationServiceName}" fulfilled at prepared net weight ${adjustment.preparedNetWeight} ${adjustment.unit}.`,
        };
      } else {
        gate4 = {
          gateName: 'GATE_4_PREPARATION_FULFILLMENT',
          status: 'BLOCKED',
          details: `Requested preparation service "${adjustment.preparationServiceName}" has not been fulfilled.`,
        };
      }
    }

    // =========================================================================
    // Gate 5: Financial Settlement Disposition
    // =========================================================================
    let gate5: GateAssessment;
    let allowsDispatch = false;
    let allowsHandover = false;

    // Find obligation for active measurement revision
    const activeObligation = (adjustment.financialObligations ?? []).find(
      (ob) => ob.revision === activeRevision,
    );

    const payment = order?.payment;
    if (!payment) {
      gate5 = {
        gateName: 'GATE_5_FINANCIAL_SETTLEMENT',
        status: 'BLOCKED',
        details: 'Missing authoritative payment record for order.',
      };
      allowsDispatch = false;
      allowsHandover = false;
    } else if (payment.provider === PaymentProviderName.CASH_ON_DELIVERY) {
      // -----------------------------------------------------------------------
      // Cash on Delivery (COD) Workflow
      // -----------------------------------------------------------------------
      // COD orders allow dispatch with cash collection pending (provided Gates 1-4 pass).
      // However, handover is strictly blocked until authoritative collection evidence
      // confirms full collection of base order amount and any supplemental amount.
      const isBaseCodPaid = payment.status === 'PAID' && Boolean(payment.providerReference?.trim());

      if (!activeObligation || activeObligation.direction === PaymentObligationDirection.NONE) {
        if (isBaseCodPaid) {
          gate5 = {
            gateName: 'GATE_5_FINANCIAL_SETTLEMENT',
            status: 'PASSED',
            details: 'COD base order collection authoritatively confirmed by driver receipt; no supplemental obligation.',
          };
          allowsDispatch = true;
          allowsHandover = true;
        } else {
          gate5 = {
            gateName: 'GATE_5_FINANCIAL_SETTLEMENT',
            status: 'COD_COLLECTION_PENDING',
            details: 'Cash on delivery base collection pending doorstep receipt. Driver-app COD collection deferred.',
          };
          allowsDispatch = true;
          allowsHandover = false;
        }
      } else if (activeObligation.direction === PaymentObligationDirection.CREDIT_DUE_CUSTOMER) {
        if (isBaseCodPaid) {
          gate5 = {
            gateName: 'GATE_5_FINANCIAL_SETTLEMENT',
            status: 'PASSED_CREDIT_QUEUED',
            details: `COD base order collection authoritatively confirmed; customer credit memo of JMD ${activeObligation.amountJmd} queued for administrative issuance.`,
          };
          allowsDispatch = true;
          allowsHandover = true;
        } else {
          gate5 = {
            gateName: 'GATE_5_FINANCIAL_SETTLEMENT',
            status: 'COD_COLLECTION_PENDING',
            details: `Cash on delivery base collection pending doorstep receipt; customer credit memo of JMD ${activeObligation.amountJmd} queued. Driver-app COD collection deferred.`,
          };
          allowsDispatch = true;
          allowsHandover = false;
        }
      } else if (activeObligation.direction === PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE) {
        const balance = await this.settlementService.getObligationBalance(
          activeObligation.id,
          client,
        );

        if (balance.isFullySettled && isBaseCodPaid) {
          gate5 = {
            gateName: 'GATE_5_FINANCIAL_SETTLEMENT',
            status: 'PASSED',
            details: `COD base order and supplemental balance of JMD ${balance.totalAmountJmd} fully collected with authoritative evidence.`,
          };
          allowsDispatch = true;
          allowsHandover = true;
        } else if (balance.isFullySettled && !isBaseCodPaid) {
          // Supplemental amount settled, but base order cash collection remains pending
          gate5 = {
            gateName: 'GATE_5_FINANCIAL_SETTLEMENT',
            status: 'COD_COLLECTION_PENDING',
            details: `Supplemental COD amount of JMD ${balance.totalAmountJmd} discharged, but base order cash collection remains pending doorstep receipt. Driver-app COD collection deferred.`,
          };
          allowsDispatch = true;
          allowsHandover = false;
        } else {
          // Supplemental balance is partially or completely unsettled
          gate5 = {
            gateName: 'GATE_5_FINANCIAL_SETTLEMENT',
            status: 'COD_COLLECTION_PENDING',
            details: `Cash on delivery collection pending doorstep payment of supplemental balance JMD ${balance.remainingBalanceJmd}. Driver-app COD collection deferred.`,
          };
          allowsDispatch = true;
          allowsHandover = false;
        }
      } else {
        gate5 = {
          gateName: 'GATE_5_FINANCIAL_SETTLEMENT',
          status: 'BLOCKED',
          details: `Unknown obligation direction: ${(activeObligation as any).direction}`,
        };
        allowsDispatch = false;
        allowsHandover = false;
      }
    } else {
      // -----------------------------------------------------------------------
      // Prepaid Workflow (WiPay, Card, etc.)
      // -----------------------------------------------------------------------
      // Prepaid orders strictly require base payment status === 'PAID'.
      // Fails closed if PENDING, FAILED, CANCELLED, or UNKNOWN.
      if (payment.status !== 'PAID') {
        gate5 = {
          gateName: 'GATE_5_FINANCIAL_SETTLEMENT',
          status: 'BLOCKED',
          details: `Original prepaid order base payment is not confirmed PAID (status: ${payment.status}). Customer credit or neutral adjustment cannot substitute for base payment.`,
        };
        allowsDispatch = false;
        allowsHandover = false;
      } else if (!activeObligation || activeObligation.direction === PaymentObligationDirection.NONE) {
        gate5 = {
          gateName: 'GATE_5_FINANCIAL_SETTLEMENT',
          status: 'PASSED',
          details: 'Original prepaid order is PAID and no supplemental weight adjustment obligation exists.',
        };
        allowsDispatch = true;
        allowsHandover = true;
      } else if (activeObligation.direction === PaymentObligationDirection.CREDIT_DUE_CUSTOMER) {
        gate5 = {
          gateName: 'GATE_5_FINANCIAL_SETTLEMENT',
          status: 'PASSED_CREDIT_QUEUED',
          details: `Original prepaid order is PAID. Customer credit memo of JMD ${activeObligation.amountJmd} is queued for administrative issuance (non-blocking for physical release).`,
        };
        allowsDispatch = true;
        allowsHandover = true;
      } else if (activeObligation.direction === PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE) {
        const balance = await this.settlementService.getObligationBalance(
          activeObligation.id,
          client,
        );

        if (balance.isFullySettled) {
          gate5 = {
            gateName: 'GATE_5_FINANCIAL_SETTLEMENT',
            status: 'PASSED',
            details: `Original prepaid order is PAID and supplemental balance of JMD ${balance.totalAmountJmd} is fully discharged.`,
          };
          allowsDispatch = true;
          allowsHandover = true;
        } else {
          gate5 = {
            gateName: 'GATE_5_FINANCIAL_SETTLEMENT',
            status: 'BLOCKED',
            details: `Prepaid supplemental balance of JMD ${balance.remainingBalanceJmd} is outstanding. Independent verified payment or vendor absorption required.`,
          };
          allowsDispatch = false;
          allowsHandover = false;
        }
      } else {
        gate5 = {
          gateName: 'GATE_5_FINANCIAL_SETTLEMENT',
          status: 'BLOCKED',
          details: `Unknown obligation direction: ${(activeObligation as any).direction}`,
        };
        allowsDispatch = false;
        allowsHandover = false;
      }
    }

    // =========================================================================
    // Overall Verdict Calculation
    // =========================================================================
    const coreGatesPassed =
      gate1.status === 'PASSED' &&
      gate2.status === 'PASSED' &&
      gate3.status === 'PASSED' &&
      (gate4.status === 'PASSED' || gate4.status === 'NOT_REQUIRED');

    const dispatchReady = coreGatesPassed && allowsDispatch;
    const handoverReady = coreGatesPassed && allowsHandover;

    return {
      weightAdjustmentId: adjustment.id,
      orderItemId: orderItem.id,
      dispatchReady,
      handoverReady,
      gate1Measurement: gate1,
      gate2FoodSafetyAndRegulatory: gate2,
      gate3CustomerApproval: gate3,
      gate4PreparationFulfillment: gate4,
      gate5FinancialSettlement: gate5,
      evaluatedAt: new Date(),
    };
  }
}
