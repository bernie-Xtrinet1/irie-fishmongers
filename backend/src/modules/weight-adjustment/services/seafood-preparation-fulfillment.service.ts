import { Injectable, Logger } from '@nestjs/common';
import {
  CertificationStatus,
  FishermanStatus,
  Prisma,
  RoleName,
  SeafoodPricingBasis,
  UsablePartsFulfillmentOutcome,
  UserStatus,
  VendorStatus,
  WeightMeasurementStatus,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../database/prisma.service';
import { PreparedWeightExceedsBillableError } from '../domain/seafood-pricing-engine.errors';
import {
  AdjustmentNotFoundError,
  MissingAuthoritativeLotProvenanceError,
  ProvenanceMismatchError,
  StaleRevisionConflictError,
} from '../repositories/errors/weight-adjustment-repository.errors';
import { SeafoodOrderWeightAdjustmentRepository } from '../repositories/seafood-order-weight-adjustment.repository';
import { SeafoodPreparationFulfillmentEventRepository } from '../repositories/seafood-preparation-fulfillment-event.repository';
import { WeightAdjustmentSafetyGateService } from './weight-adjustment-safety-gate.service';
import {
  InvalidPreparationWeightError,
  InvalidUsablePartsOutcomeError,
  PreparationFulfillmentResult,
  PreparationServiceMismatchError,
  RecordPreparationFulfillmentInput,
  UnauthorizedPreparationOperatorError,
  UnmeasuredPreparationError,
  UnselectedPreparationError,
} from './types/weight-measurement-fulfillment.types';

@Injectable()
export class SeafoodPreparationFulfillmentService {
  private readonly logger = new Logger(SeafoodPreparationFulfillmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly safetyGate: WeightAdjustmentSafetyGateService,
    private readonly adjustmentRepo: SeafoodOrderWeightAdjustmentRepository,
    private readonly preparationRepo: SeafoodPreparationFulfillmentEventRepository,
  ) {}

  /**
   * Records butchery preparation fulfillment, usable parts disposition, and optional QC yield metrics.
   *
   * Invariants:
   * 1. Requires an existing, accepted authoritative weight measurement.
   * 2. Physical lot must match immutable original-lot provenance.
   * 3. Current food-safety clearance must be re-verified immediately before cutting.
   * 4. Authenticated operator must be authorized for the order vendor.
   * 5. Vendor holds final biological discretion to exclude unsuitable parts without customer re-approval.
   * 6. Prepared net weight is optional under WHOLE_RAW and operates as QC evidence only.
   * 7. Prepared net weight NEVER recalculates customer seafood subtotal, prep fee, or item total under WHOLE_RAW.
   */
  async recordPreparationFulfillment(
    input: RecordPreparationFulfillmentInput,
    tx?: Prisma.TransactionClient,
  ): Promise<PreparationFulfillmentResult> {
    if (!input.operatorUserId || input.operatorUserId.trim() === '') {
      throw new UnauthorizedPreparationOperatorError('Operator user ID is required.');
    }

    if (!input.authenticatedActor) {
      throw new UnauthorizedPreparationOperatorError(
        'Missing trusted authentication context: authenticated actor must be provided.',
      );
    }

    if (input.authenticatedActor.id !== input.operatorUserId) {
      throw new UnauthorizedPreparationOperatorError(
        `Forged operator identity: caller-supplied operatorUserId "${input.operatorUserId}" does not match authenticated actor "${input.authenticatedActor.id}".`,
      );
    }

    const authenticatedActor = input.authenticatedActor;

    // Validate Usable Parts Outcome
    const validOutcomes = Object.values(UsablePartsFulfillmentOutcome);
    if (!input.partsOutcome || !validOutcomes.includes(input.partsOutcome)) {
      throw new InvalidUsablePartsOutcomeError(
        `Invalid usable parts outcome: "${input.partsOutcome}". Valid outcomes are: ${validOutcomes.join(', ')}.`,
      );
    }

    if (
      (input.partsOutcome === UsablePartsFulfillmentOutcome.NO_SUITABLE_PARTS_AVAILABLE ||
        input.partsOutcome === UsablePartsFulfillmentOutcome.PARTIALLY_RETURNED) &&
      (!input.partsDisposalReason || input.partsDisposalReason.trim() === '')
    ) {
      throw new InvalidUsablePartsOutcomeError(
        'A biological disposal reason is mandatory when suitable parts are not available or partially returned.',
      );
    }

    const executeInTransaction = async (txClient: Prisma.TransactionClient): Promise<PreparationFulfillmentResult> => {
      // 1. Resolve parent weight adjustment with complete graph
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
        },
      });

      if (!adjustment) {
        throw new AdjustmentNotFoundError(input.weightAdjustmentId);
      }

      // 2. Prerequisite Check: Item must have authoritative measurement
      if (
        !adjustment.activeMeasurementRevision ||
        adjustment.measurementStatus === WeightMeasurementStatus.PENDING_MEASUREMENT ||
        adjustment.verifiedBillableWeight === null
      ) {
        throw new UnmeasuredPreparationError(
          adjustment.id,
          `Preparation fulfillment prohibited on adjustment "${adjustment.id}": order item has not received an authoritative weight measurement.`,
        );
      }

      // Customer preparation selection requirement
      if (!adjustment.preparationServiceName || adjustment.preparationServiceName.trim() === '') {
        throw new UnselectedPreparationError(
          adjustment.id,
          `Preparation fulfillment prohibited on adjustment "${adjustment.id}": customer did not select a preparation service for this seafood item.`,
        );
      }

      if (
        input.preparationServiceName &&
        input.preparationServiceName.trim() !== adjustment.preparationServiceName.trim()
      ) {
        throw new PreparationServiceMismatchError(
          `Specified preparation service "${input.preparationServiceName}" does not match customer-selected preparation service "${adjustment.preparationServiceName}".`,
        );
      }

      // 3. Verify operator authorization, vendor ownership, and regulatory eligibility
      const vendor = adjustment.orderItem.vendorOrder.vendor;
      const orderVendorId = vendor.id;
      const vendorOwnerUserId = vendor.userId;

      // 3a. Verify Vendor account is approved and eligible to operate
      if (vendor.status !== VendorStatus.APPROVED) {
        throw new UnauthorizedPreparationOperatorError(
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
        throw new UnauthorizedPreparationOperatorError(
          `Operator "${input.operatorUserId}" is not an active authenticated platform user.`,
        );
      }

      const operatorRoleNames = operator.roles.map((r) => r.role.name);
      const hasVendorRole = operatorRoleNames.includes(RoleName.VENDOR);
      const hasFishermanRole = operatorRoleNames.includes(RoleName.FISHERMAN);

      if (!hasVendorRole && !hasFishermanRole) {
        throw new UnauthorizedPreparationOperatorError(
          `Operator "${input.operatorUserId}" does not hold an authorized seller role (VENDOR or FISHERMAN).`,
        );
      }

      // 3b. Verify Order Ownership: exact ownership of the VendorOrder through operator.id === vendor.userId
      // Multi-tenant boundary: ADMINISTRATOR cannot bypass ownership; assigned subordinate path removed from WP3.3.
      if (operator.id !== vendorOwnerUserId) {
        throw new UnauthorizedPreparationOperatorError(
          `Operator "${input.operatorUserId}" is not authorized for vendor "${orderVendorId}". Exact ownership required: operator must own the vendor account.`,
        );
      }

      // 3c. Fisherman Regulatory Verification
      if (hasFishermanRole) {
        const fisherman = operator.fisherman;
        if (!fisherman) {
          throw new UnauthorizedPreparationOperatorError(
            `Operator "${input.operatorUserId}" possesses the FISHERMAN role but lacks an authoritative Fisherman profile.`,
          );
        }

        if (fisherman.status !== FishermanStatus.APPROVED) {
          throw new UnauthorizedPreparationOperatorError(
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
              throw new UnauthorizedPreparationOperatorError(
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
          throw new UnauthorizedPreparationOperatorError(
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

      // 6. Revision sequencing check
      const currentRevision = adjustment.activePreparationRevision ?? 0;
      if (input.expectedRevision !== currentRevision + 1) {
        throw new StaleRevisionConflictError(
          adjustment.id,
          input.expectedRevision,
          currentRevision,
        );
      }

      // 7. Optional Prepared Net Weight QC & Yield Loss Calculation
      let preparedNetWeightDecimal: Decimal | null = null;
      let yieldLossWeightDecimal: Decimal | null = null;
      let yieldLossPercentDecimal: Decimal | null = null;

      if (input.preparedNetWeight !== undefined && input.preparedNetWeight !== null) {
        if (!input.unit) {
          throw new InvalidPreparationWeightError(
            'Measurement unit (unit) is required when reporting prepared net weight.',
          );
        }
        if (input.unit !== adjustment.unit) {
          throw new InvalidPreparationWeightError(
            `Prepared net weight unit "${input.unit}" does not match order item unit "${adjustment.unit}".`,
          );
        }

        try {
          preparedNetWeightDecimal = new Decimal(input.preparedNetWeight);
        } catch {
          throw new InvalidPreparationWeightError('Prepared net weight must be a valid numeric value.');
        }
        if (
          preparedNetWeightDecimal.isNaN() ||
          !preparedNetWeightDecimal.isFinite() ||
          preparedNetWeightDecimal.lessThan(0)
        ) {
          throw new InvalidPreparationWeightError(
            'Prepared net weight must be a finite non-negative number.',
          );
        }

        const verifiedBillable = new Decimal(adjustment.verifiedBillableWeight.toString());

        if (
          adjustment.pricingBasis === SeafoodPricingBasis.WHOLE_RAW &&
          preparedNetWeightDecimal.greaterThan(verifiedBillable)
        ) {
          throw new PreparedWeightExceedsBillableError(
            `Prepared net weight (${preparedNetWeightDecimal.toString()}) cannot exceed whole raw catch weight (${verifiedBillable.toString()}).`,
          );
        }

        yieldLossWeightDecimal = verifiedBillable.minus(preparedNetWeightDecimal);
        yieldLossPercentDecimal = yieldLossWeightDecimal
          .dividedBy(verifiedBillable)
          .times(100)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      }

      // 8. Append immutable preparation event via WP2 repository
      const { event, isReplay } = await this.preparationRepo.appendPreparationEvent(
        {
          weightAdjustmentId: adjustment.id,
          expectedRevision: input.expectedRevision,
          idempotencyKey: input.idempotencyKey,
          preparedNetWeight: preparedNetWeightDecimal ?? undefined,
          partsOutcome: input.partsOutcome,
          partsDisposalReason: input.partsDisposalReason,
          preparedPhotoUrl: input.preparedPhotoUrl,
          operatorUserId: input.operatorUserId,
          correctionReason: input.correctionReason,
        },
        txClient,
      );

      if (isReplay) {
        return {
          status: 'IDEMPOTENT_REPLAY',
          preparationEvent: event,
          weightAdjustment: adjustment,
          isReplay: true,
          yieldLossWeight: yieldLossWeightDecimal ?? undefined,
          yieldLossPercent: yieldLossPercentDecimal ?? undefined,
        };
      }

      // 9. Atomic parent projection update
      // CRITICAL: Under WHOLE_RAW, finalProductSubtotal, finalPreparationFee, and finalItemTotal
      // are NEVER recalculated. They remain locked to the authoritative whole raw measurement.
      const updateData: Prisma.SeafoodOrderWeightAdjustmentUpdateInput = {
        activePreparationRevision: input.expectedRevision,
        usablePartsOutcome: input.partsOutcome,
      };

      if (preparedNetWeightDecimal !== null) {
        updateData.preparedNetWeight = new Prisma.Decimal(preparedNetWeightDecimal.toFixed(3));
        updateData.yieldLossWeight = new Prisma.Decimal(yieldLossWeightDecimal!.toFixed(3));
        updateData.yieldLossPercent = new Prisma.Decimal(yieldLossPercentDecimal!.toFixed(2));
      }

      const updatedAdjustment = await txClient.seafoodOrderWeightAdjustment.update({
        where: { id: adjustment.id },
        data: updateData,
      });

      return {
        status: 'FULFILLED',
        preparationEvent: event,
        weightAdjustment: updatedAdjustment,
        isReplay: false,
        yieldLossWeight: yieldLossWeightDecimal ?? undefined,
        yieldLossPercent: yieldLossPercentDecimal ?? undefined,
      };
    };

    if (tx) {
      return await executeInTransaction(tx);
    }
    return await this.prisma.$transaction(executeInTransaction);
  }
}
