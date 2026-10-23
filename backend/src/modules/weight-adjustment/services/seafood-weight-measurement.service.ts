import { Injectable, Logger } from '@nestjs/common';
import {
  ApprovalChallengeStatus,
  CertificationStatus,
  CustomerWeightApprovalStatus,
  FishermanStatus,
  Prisma,
  RoleName,
  SeafoodPricingBasis,
  UserStatus,
  VendorStatus,
  WeightMeasurementStatus,
  WeightUnit,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../database/prisma.service';
import { SeafoodPricingEngine } from '../domain/seafood-pricing-engine';
import { ApprovalReason } from '../domain/seafood-pricing-engine.types';
import {
  AdjustmentNotFoundError,
  MissingAuthoritativeLotProvenanceError,
  ProvenanceMismatchError,
  StaleRevisionConflictError,
} from '../repositories/errors/weight-adjustment-repository.errors';
import { SeafoodOrderWeightAdjustmentRepository } from '../repositories/seafood-order-weight-adjustment.repository';
import { SeafoodWeightMeasurementEventRepository } from '../repositories/seafood-weight-measurement-event.repository';
import { WeightAdjustmentSafetyGateService } from './weight-adjustment-safety-gate.service';
import {
  InvalidScaleEvidenceError,
  MeasurementCorrectionProhibitedError,
  MissingCorrectionReasonError,
  PreparationCommencementIndeterminateError,
  RecordWeightMeasurementInput,
  UnauthorizedMeasurementOperatorError,
  WeightMeasurementResult,
} from './types/weight-measurement-fulfillment.types';

@Injectable()
export class SeafoodWeightMeasurementService {
  private readonly logger = new Logger(SeafoodWeightMeasurementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly safetyGate: WeightAdjustmentSafetyGateService,
    private readonly adjustmentRepo: SeafoodOrderWeightAdjustmentRepository,
    private readonly measurementRepo: SeafoodWeightMeasurementEventRepository,
  ) {}

  /**
   * Records an authoritative seafood weight measurement event and atomically updates the parent projection.
   *
   * Invariants:
   * 1. Physical lot must match immutable original-lot provenance.
   * 2. Seafood safety gate must pass immediately before accepting measurement.
   * 3. Net catch weight must be positive, finite, and exclude all tare/ice/packaging.
   * 4. For WHOLE_RAW, billable weight is established before preparation; post-preparation weight does not alter price.
   * 5. Exceptional corrections require non-empty reason, must precede preparation, and invalidate earlier approvals.
   * 6. Fails closed when preparation commencement cannot be definitively disproven under WHOLE_RAW.
   * 7. Recalculates financial subtotals and customer ceiling compliance via WP1 SeafoodPricingEngine.
   */
  async recordAuthoritativeMeasurement(
    input: RecordWeightMeasurementInput,
    tx?: Prisma.TransactionClient,
  ): Promise<WeightMeasurementResult> {
    // 1. Validate Net Weight Scale Evidence
    if (input.measuredWeight === undefined || input.measuredWeight === null) {
      throw new InvalidScaleEvidenceError('Measured weight is required.');
    }

    let weightDecimal: Decimal;
    try {
      weightDecimal = new Decimal(input.measuredWeight);
    } catch {
      throw new InvalidScaleEvidenceError('Measured net weight must be a valid numeric value.');
    }
    if (weightDecimal.isNaN() || !weightDecimal.isFinite() || weightDecimal.lessThanOrEqualTo(0)) {
      throw new InvalidScaleEvidenceError('Measured net weight must be a finite positive number.');
    }

    if (!input.scalePhotoUrl || input.scalePhotoUrl.trim() === '') {
      throw new InvalidScaleEvidenceError('Scale photographic evidence (scalePhotoUrl) is required.');
    }

    if (input.tareIsolated === false) {
      throw new InvalidScaleEvidenceError(
        'Gross weight readings including tare, ice, water or packaging are prohibited. Net weight must be isolated.',
      );
    }

    if (!input.operatorUserId || input.operatorUserId.trim() === '') {
      throw new UnauthorizedMeasurementOperatorError('Operator user ID is required.');
    }

    if (!input.authenticatedActor) {
      throw new UnauthorizedMeasurementOperatorError(
        'Missing trusted authentication context: authenticated actor must be provided.',
      );
    }

    if (input.authenticatedActor.id !== input.operatorUserId) {
      throw new UnauthorizedMeasurementOperatorError(
        `Forged operator identity: caller-supplied operatorUserId "${input.operatorUserId}" does not match authenticated actor "${input.authenticatedActor.id}".`,
      );
    }

    const authenticatedActor = input.authenticatedActor;

    const executeInTransaction = async (txClient: Prisma.TransactionClient): Promise<WeightMeasurementResult> => {
      // 2. Resolve parent weight adjustment with complete order item graph
      const adjustment = await txClient.seafoodOrderWeightAdjustment.findUnique({
        where: { id: input.weightAdjustmentId },
        include: {
          orderItem: {
            include: {
              vendorOrder: {
                include: {
                  order: true,
                  vendor: true,
                },
              },
              product: {
                include: { lot: true },
              },
            },
          },
          checkoutCeilingConsent: true,
        },
      });

      if (!adjustment) {
        throw new AdjustmentNotFoundError(input.weightAdjustmentId);
      }

      // 3. Verify operator authorization, vendor ownership, and regulatory eligibility
      const vendor = adjustment.orderItem.vendorOrder.vendor;
      const orderVendorId = vendor.id;
      const vendorOwnerUserId = vendor.userId;

      // 3a. Verify Vendor account is approved and eligible to operate
      if (vendor.status !== VendorStatus.APPROVED) {
        throw new UnauthorizedMeasurementOperatorError(
          `Vendor "${orderVendorId}" is not eligible to conduct marketplace operations (status: ${vendor.status}).`,
        );
      }

      const operator = await txClient.user.findUnique({
        where: { id: authenticatedActor.id },
        include: {
          roles: {
            include: { role: true },
          },
          fisherman: {
            include: {
              certifications: {
                include: {
                  issuingAuthority: true,
                },
              },
            },
          },
        },
      });

      if (!operator || operator.status !== UserStatus.ACTIVE) {
        throw new UnauthorizedMeasurementOperatorError(
          `Operator "${input.operatorUserId}" is not an active authenticated platform user.`,
        );
      }

      const operatorRoleNames = operator.roles.map((r) => r.role.name);
      const hasVendorRole = operatorRoleNames.includes(RoleName.VENDOR);
      const hasFishermanRole = operatorRoleNames.includes(RoleName.FISHERMAN);

      if (!hasVendorRole && !hasFishermanRole) {
        throw new UnauthorizedMeasurementOperatorError(
          `Operator "${input.operatorUserId}" does not hold an authorized seller role (VENDOR or FISHERMAN).`,
        );
      }

      // 3b. Verify Order Ownership: exact ownership of the VendorOrder through operator.id === vendor.userId
      // Multi-tenant boundary: ADMINISTRATOR cannot bypass ownership; assigned subordinate path removed from WP3.3.
      if (operator.id !== vendorOwnerUserId) {
        throw new UnauthorizedMeasurementOperatorError(
          `Operator "${input.operatorUserId}" is not authorized for vendor "${orderVendorId}". Exact ownership required: operator must own the vendor account.`,
        );
      }

      // 3c. Fisherman Regulatory Verification
      if (hasFishermanRole) {
        const fisherman = operator.fisherman;
        if (!fisherman) {
          throw new UnauthorizedMeasurementOperatorError(
            `Operator "${input.operatorUserId}" possesses the FISHERMAN role but lacks an authoritative Fisherman profile.`,
          );
        }

        if (fisherman.status !== FishermanStatus.APPROVED) {
          throw new UnauthorizedMeasurementOperatorError(
            `Fisherman profile for operator "${input.operatorUserId}" is not approved (status: ${fisherman.status}).`,
          );
        }

        const now = new Date();
        const certs = (fisherman.certifications ?? []) as Array<
          Prisma.RegulatoryCertificationGetPayload<{ include: { issuingAuthority: true } }>
        >;

        const isFisheriesLicenceCategory = (type: string) => {
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

        const isFisheriesAuthority = (authorityName?: string | null) => {
          if (!authorityName) return false;
          const a = authorityName.toUpperCase().trim();
          return (
            a.includes('FISHERIES') ||
            a.includes('NFA') ||
            a.includes('NATIONAL FISHERIES AUTHORITY')
          );
        };

        // Check for any invalid, suspended, revoked, or expired fisheries credentials
        for (const cert of certs) {
          if (isFisheriesLicenceCategory(cert.certificateType)) {
            if (
              cert.status === CertificationStatus.SUSPENDED ||
              cert.status === CertificationStatus.REVOKED ||
              cert.status === CertificationStatus.EXPIRED ||
              (cert.expiryDate && cert.expiryDate < now)
            ) {
              throw new UnauthorizedMeasurementOperatorError(
                `Fisherman fisheries licence "${cert.certificateType}" (${cert.certificateNumber}) is invalid, expired, revoked or suspended (status: ${cert.status}).`,
              );
            }
          }
        }

        // Require affirmative platform verification evidence: active licence in fisheries category by verified fisheries authority
        const validFisheriesLicence = certs.find((cert) => {
          const isCategory = isFisheriesLicenceCategory(cert.certificateType);
          const isAuthority = isFisheriesAuthority(cert.issuingAuthority?.name);
          const isActive = cert.status === CertificationStatus.ACTIVE;
          const isNotExpired = !cert.expiryDate || cert.expiryDate >= now;
          return isCategory && isAuthority && isActive && isNotExpired;
        });

        if (!validFisheriesLicence) {
          throw new UnauthorizedMeasurementOperatorError(
            `Fisherman "${fisherman.id}" lacks affirmative platform-verified fisheries licensing. An active commercial fishing licence issued by an authorized fisheries authority is required. Nonempty license number string alone is insufficient without verified credentials.`,
          );
        }
      }

      // 4. Resolve and verify authoritative original-lot provenance
      const orderItem = adjustment.orderItem;
      const persistedLotId = ((orderItem as any).originalLotId ?? (orderItem as any).lotId) as string | undefined;

      if (!persistedLotId) {
        throw new MissingAuthoritativeLotProvenanceError(
          orderItem.id,
          `OrderItem "${orderItem.id}" lacks authoritative, immutable persisted original-lot provenance in database.`,
        );
      }

      if (input.physicalLotId && input.physicalLotId !== persistedLotId) {
        throw new ProvenanceMismatchError(
          `Physical lot "${input.physicalLotId}" does not match authoritative order lot "${persistedLotId}".`,
        );
      }

      // 5. Authoritative food-safety gate verification
      await this.safetyGate.assertLotSafeForFulfillment(
        {
          seafoodLotId: persistedLotId,
          vendorId: orderItem.vendorOrder.vendorId,
          atDate: new Date(),
        },
        txClient,
      );

      // 6. Revision sequencing and correction validation
      const currentRevision = adjustment.activeMeasurementRevision ?? 0;
      if (input.expectedRevision !== currentRevision + 1) {
        throw new StaleRevisionConflictError(
          adjustment.id,
          input.expectedRevision,
          currentRevision,
        );
      }

      // Handle exceptional measurement correction rules beyond initial revision
      if (currentRevision >= 1) {
        if (!input.correctionReason || input.correctionReason.trim() === '') {
          throw new MissingCorrectionReasonError(
            'A documented correction reason is mandatory for measurement corrections beyond revision 1.',
          );
        }

        // For WHOLE_RAW, measurement must precede physical cutting
        if (adjustment.pricingBasis === SeafoodPricingBasis.WHOLE_RAW) {
          if (adjustment.activePreparationRevision && adjustment.activePreparationRevision > 0) {
            throw new MeasurementCorrectionProhibitedError(
              'Cannot re-weigh whole raw catch: preparation has already been fulfilled.',
            );
          }

          // Fencing against indeterminate commencement:
          // Because current database schema lacks an authoritative commencement tracker,
          // relying solely on absence of a completed preparation event is prohibited.
          // Unless explicit pre-commencement status is established, fail closed.
          const hasVerifiedPreCommencement = (adjustment as any).preparationCommenced === false;
          if (!hasVerifiedPreCommencement) {
            throw new PreparationCommencementIndeterminateError(
              adjustment.id,
              `Cannot execute WHOLE_RAW measurement correction on adjustment "${adjustment.id}": the database schema lacks an authoritative preparation commencement tracker. Prohibiting correction because absence of completed preparation does not prove physical cutting has not begun.`,
            );
          }
        }
      }

      // 7. Calculate revised pricing, subtotals and customer ceiling compliance via WP1 SeafoodPricingEngine
      const pricingBasis = adjustment.pricingBasis;
      const unit = adjustment.unit === WeightUnit.KILOGRAMS ? 'PER_KILOGRAM' : 'PER_POUND';
      const unitPrice = new Decimal(adjustment.unitPrice.toString());
      const estimatedWeight = new Decimal(adjustment.estimatedBillableWeight.toString());
      const customerAuthorizedCeilingJmd = new Decimal(adjustment.customerAuthorizedCeilingJmd.toString());

      const pricingResult = SeafoodPricingEngine.calculate({
        pricingBasis: pricingBasis as any,
        unit,
        unitPrice,
        estimatedWeight,
        verifiedWeight: weightDecimal,
        customerAuthorizedCeilingJmd,
        preparation: {
          feeStructure: adjustment.preparationFeeStructure as any,
          feeRate: new Decimal(adjustment.preparationFeeRate.toString()),
        },
      });

      const finalProductSubtotal = pricingResult.finalProductSubtotal!;
      const finalPreparationFee = pricingResult.finalPreparationFee!;
      const finalItemTotal = pricingResult.finalItemTotal!;
      const totalAdjustmentAmount = pricingResult.totalAdjustmentAmount!;
      const weightDifference = pricingResult.weightDifference!;
      const productSubtotalDifference = pricingResult.productSubtotalDifference!;
      const preparationFeeDifference = pricingResult.preparationFeeDifference!;

      // Determine ceiling compliance and approval status
      let newCustomerApprovalStatus: CustomerWeightApprovalStatus;
      let newMeasurementStatus: WeightMeasurementStatus;
      let approvalReason: string;

      if (pricingResult.requiresCustomerApproval) {
        newCustomerApprovalStatus = CustomerWeightApprovalStatus.AWAITING_APPROVAL;
        newMeasurementStatus = WeightMeasurementStatus.MEASURED_EXCEEDS_CEILING;
        approvalReason = ApprovalReason.EXCEEDS_AUTHORIZED_CEILING;
      } else {
        newCustomerApprovalStatus = CustomerWeightApprovalStatus.NOT_REQUIRED;
        newMeasurementStatus = WeightMeasurementStatus.MEASURED_WITHIN_CEILING;
        approvalReason = ApprovalReason.NO_APPROVAL_REQUIRED;
      }

      // 8. Append immutable measurement event via WP2 repository
      const { event, isReplay } = await this.measurementRepo.appendMeasurementEvent(
        {
          weightAdjustmentId: adjustment.id,
          expectedRevision: input.expectedRevision,
          idempotencyKey: input.idempotencyKey,
          pricingBasis: adjustment.pricingBasis,
          unit: adjustment.unit,
          measuredWeight: weightDecimal,
          scalePhotoUrl: input.scalePhotoUrl,
          scaleDeviceIdentifier: input.scaleDeviceIdentifier,
          scaleCalibrationDate: input.scaleCalibrationDate,
          operatorUserId: input.operatorUserId,
          correctionReason: input.correctionReason,
        },
        txClient,
      );

      if (isReplay) {
        return {
          status: 'IDEMPOTENT_REPLAY',
          measurementEvent: event,
          weightAdjustment: adjustment,
          isReplay: true,
          pricingResult,
          requiresCustomerApproval: pricingResult.requiresCustomerApproval,
          customerApprovalStatus: adjustment.customerApprovalStatus,
        };
      }

      // 9. Atomic parent projection update with finalized financial terms
      const updatedAdjustment = await txClient.seafoodOrderWeightAdjustment.update({
        where: { id: adjustment.id },
        data: {
          verifiedBillableWeight: new Prisma.Decimal(weightDecimal.toFixed(3)),
          weightDifference: new Prisma.Decimal(weightDifference.toFixed(3)),
          finalProductSubtotal: new Prisma.Decimal(finalProductSubtotal.toFixed(2)),
          productSubtotalDifference: new Prisma.Decimal(productSubtotalDifference.toFixed(2)),
          finalPreparationFee: new Prisma.Decimal(finalPreparationFee.toFixed(2)),
          preparationFeeDifference: new Prisma.Decimal(preparationFeeDifference.toFixed(2)),
          finalItemTotal: new Prisma.Decimal(finalItemTotal.toFixed(2)),
          totalAdjustmentAmount: new Prisma.Decimal(totalAdjustmentAmount.toFixed(2)),
          measurementStatus: newMeasurementStatus,
          customerApprovalStatus: newCustomerApprovalStatus,
          approvalReason,
          boundApprovalRevision: null, // Any prior approval is strictly invalidated on revision advance
        },
      });

      // 10. Invalidate and revoke any open challenges bound to earlier measurement revisions
      if (currentRevision >= 1) {
        await txClient.customerWeightApprovalChallenge.updateMany({
          where: {
            weightAdjustmentId: adjustment.id,
            status: ApprovalChallengeStatus.OPEN,
          },
          data: {
            status: ApprovalChallengeStatus.REVOKED,
            revokedAt: new Date(),
            revocationReason: 'SUPERSEDED_BY_MEASUREMENT_CORRECTION',
          },
        });
      }

      return {
        status: pricingResult.requiresCustomerApproval
          ? 'MEASURED_EXCEEDS_CEILING'
          : 'MEASURED_WITHIN_CEILING',
        measurementEvent: event,
        weightAdjustment: updatedAdjustment,
        isReplay: false,
        pricingResult,
        requiresCustomerApproval: pricingResult.requiresCustomerApproval,
        customerApprovalStatus: newCustomerApprovalStatus,
      };
    };

    if (tx) {
      return await executeInTransaction(tx);
    }
    return await this.prisma.$transaction(executeInTransaction);
  }
}
