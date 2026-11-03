import { Injectable } from '@nestjs/common';
import { PreparationChargeMethod, Prisma, SeafoodOrderWeightAdjustment } from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../database/prisma.service';
import {
  CreateAdjustmentSnapshotInput,
  InvalidAdjustmentInputError,
  UpdateAdjustmentStateInput,
} from './types/weight-adjustment-repository.types';
import { AdjustmentNotFoundError } from './errors/weight-adjustment-repository.errors';

export type AdjustmentWithRelations = Prisma.SeafoodOrderWeightAdjustmentGetPayload<{
  include: {
    measurementEvents: true;
    preparationEvents: true;
    checkoutCeilingConsent: true;
    approvalRecords: true;
    financialObligations: {
      include: {
        settlementRecords: true;
      };
    };
  };
}>;

@Injectable()
export class SeafoodOrderWeightAdjustmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Performs structural validation on optional V2 adjustment input fields.
   *
   * RESPONSIBILITY NOTE:
   * Repository validation checks method-parameter consistency and numeric positivity.
   * It DOES NOT establish customer consent authorization or cryptographic quote authenticity,
   * which are verified upstream by CheckoutQuoteService and the checkout transaction boundary.
   * Historical V1 behavior is strictly preserved when V2 fields are omitted.
   */
  private validateV2AdjustmentInput(input: CreateAdjustmentSnapshotInput): void {
    // 1. If method is FIXED_PER_FISH, fishCount is strictly required, integer >= 1
    if (input.preparationChargeMethod === PreparationChargeMethod.FIXED_PER_FISH) {
      if (input.fishCount === undefined || input.fishCount === null) {
        throw new InvalidAdjustmentInputError(
          'FIXED_PER_FISH preparation method requires a positive integer fishCount (>= 1).',
        );
      }
    }

    // 2. If fishCount is provided, must be a finite integer >= 1
    if (input.fishCount !== undefined && input.fishCount !== null) {
      if (
        typeof input.fishCount !== 'number' ||
        !Number.isInteger(input.fishCount) ||
        input.fishCount < 1
      ) {
        throw new InvalidAdjustmentInputError(
          `fishCount must be a positive integer (>= 1), got ${input.fishCount}.`,
        );
      }
    }

    // 3. If method is FIXED_PER_POUND, originalWholeWeightLbs and originalWholeWeightUnit are strictly required
    if (input.preparationChargeMethod === PreparationChargeMethod.FIXED_PER_POUND) {
      if (
        input.originalWholeWeightLbs === undefined ||
        input.originalWholeWeightLbs === null
      ) {
        throw new InvalidAdjustmentInputError(
          'FIXED_PER_POUND preparation method requires originalWholeWeightLbs to be provided.',
        );
      }
      if (!input.originalWholeWeightUnit) {
        throw new InvalidAdjustmentInputError(
          'FIXED_PER_POUND preparation method requires originalWholeWeightUnit to be provided.',
        );
      }
    }

    // 4. If originalWholeWeightLbs is provided, must be a finite positive Decimal/number (> 0)
    // and must satisfy the lossless representability contract for PostgreSQL DECIMAL(16,8)
    if (
      input.originalWholeWeightLbs !== undefined &&
      input.originalWholeWeightLbs !== null
    ) {
      let weightDec: Decimal;
      try {
        weightDec = new Decimal(input.originalWholeWeightLbs);
      } catch {
        throw new InvalidAdjustmentInputError(
          `originalWholeWeightLbs "${input.originalWholeWeightLbs}" cannot be parsed as a valid decimal number.`,
        );
      }
      if (!weightDec.isFinite() || weightDec.lte(0)) {
        throw new InvalidAdjustmentInputError(
          `originalWholeWeightLbs must be a finite positive number (> 0), got ${input.originalWholeWeightLbs}.`,
        );
      }
      // Lossless representability contract: DECIMAL(16,8) enforces scale <= 8
      if (weightDec.decimalPlaces() > 8) {
        throw new InvalidAdjustmentInputError(
          `originalWholeWeightLbs cannot exceed 8 decimal places for exact lossless DECIMAL(16,8) persistence (got ${input.originalWholeWeightLbs}).`,
        );
      }
      // Lossless representability contract: DECIMAL(16,8) enforces precision 16, scale 8 (max integer digits = 8, strictly < 10^8)
      if (weightDec.gte(new Decimal('100000000'))) {
        throw new InvalidAdjustmentInputError(
          `originalWholeWeightLbs exceeds maximum integer capacity for DECIMAL(16,8) (must be strictly less than 100,000,000, got ${input.originalWholeWeightLbs}).`,
        );
      }
      if (!input.originalWholeWeightUnit) {
        throw new InvalidAdjustmentInputError(
          'originalWholeWeightUnit must be specified when originalWholeWeightLbs is provided.',
        );
      }
    }

    // 5. If method is NO_PREPARATION, preparation fee must be 0
    if (input.preparationChargeMethod === PreparationChargeMethod.NO_PREPARATION) {
      if (input.estimatedPreparationFee !== undefined && input.estimatedPreparationFee !== null) {
        const fee = new Decimal(input.estimatedPreparationFee);
        if (!fee.isZero()) {
          throw new InvalidAdjustmentInputError(
            `NO_PREPARATION method requires estimatedPreparationFee to be 0.00, got ${fee.toFixed(2)}.`,
          );
        }
      }
    }
  }

  async createAdjustmentSnapshot(
    input: CreateAdjustmentSnapshotInput,
    tx?: Prisma.TransactionClient,
  ): Promise<SeafoodOrderWeightAdjustment> {
    this.validateV2AdjustmentInput(input);
    const client = tx ?? this.prisma;

    return client.seafoodOrderWeightAdjustment.create({
      data: {
        orderItemId: input.orderItemId,
        pricingBasis: input.pricingBasis,
        unit: input.unit,
        unitPrice: new Prisma.Decimal(new Decimal(input.unitPrice).toFixed(2)),
        pieceCount: input.pieceCount ?? 1,
        estimatedBillableWeight: new Prisma.Decimal(new Decimal(input.estimatedBillableWeight).toFixed(3)),
        preparationServiceName: input.preparationServiceName,
        usablePartsPreference: input.usablePartsPreference,
        preparationFeeStructure: input.preparationFeeStructure,
        preparationFeeRate: new Prisma.Decimal(new Decimal(input.preparationFeeRate ?? 0).toFixed(2)),
        estimatedPreparationFee: new Prisma.Decimal(new Decimal(input.estimatedPreparationFee ?? 0).toFixed(2)),
        estimatedProductSubtotal: new Prisma.Decimal(new Decimal(input.estimatedProductSubtotal).toFixed(2)),
        estimatedItemTotal: new Prisma.Decimal(new Decimal(input.estimatedItemTotal).toFixed(2)),
        customerAuthorizedCeilingJmd: new Prisma.Decimal(new Decimal(input.customerAuthorizedCeilingJmd).toFixed(2)),
        // Phase 16D WP4.3B.4C Additions: Additive V2 preparation & physical measures
        preparationChargeMethod: input.preparationChargeMethod ?? null,
        fishCount: input.fishCount ?? null,
        originalWholeWeightLbs:
          input.originalWholeWeightLbs !== undefined && input.originalWholeWeightLbs !== null
            ? new Prisma.Decimal(new Decimal(input.originalWholeWeightLbs).toString())
            : null,
        originalWholeWeightUnit: input.originalWholeWeightUnit ?? null,
      },
    });
  }

  async findById(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<AdjustmentWithRelations | null> {
    const client = tx ?? this.prisma;
    return client.seafoodOrderWeightAdjustment.findUnique({
      where: { id },
      include: {
        measurementEvents: { orderBy: { revision: 'asc' } },
        preparationEvents: { orderBy: { revision: 'asc' } },
        checkoutCeilingConsent: true,
        approvalRecords: { orderBy: { decidedAt: 'desc' } },
        financialObligations: {
          orderBy: { revision: 'asc' },
          include: { settlementRecords: { orderBy: { settledAt: 'asc' } } },
        },
      },
    });
  }

  async findByOrderItemId(
    orderItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<SeafoodOrderWeightAdjustment | null> {
    const client = tx ?? this.prisma;
    return client.seafoodOrderWeightAdjustment.findUnique({
      where: { orderItemId },
    });
  }

  async updateActiveState(
    id: string,
    input: UpdateAdjustmentStateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<SeafoodOrderWeightAdjustment> {
    const client = tx ?? this.prisma;

    const data: Prisma.SeafoodOrderWeightAdjustmentUpdateInput = {};

    if (input.verifiedBillableWeight !== undefined) {
      data.verifiedBillableWeight = input.verifiedBillableWeight !== null
        ? new Prisma.Decimal(new Decimal(input.verifiedBillableWeight).toFixed(3))
        : null;
    }
    if (input.preparedNetWeight !== undefined) {
      data.preparedNetWeight = input.preparedNetWeight !== null
        ? new Prisma.Decimal(new Decimal(input.preparedNetWeight).toFixed(3))
        : null;
    }
    if (input.weightDifference !== undefined) {
      data.weightDifference = input.weightDifference !== null
        ? new Prisma.Decimal(new Decimal(input.weightDifference).toFixed(3))
        : null;
    }
    if (input.yieldLossWeight !== undefined) {
      data.yieldLossWeight = input.yieldLossWeight !== null
        ? new Prisma.Decimal(new Decimal(input.yieldLossWeight).toFixed(3))
        : null;
    }
    if (input.yieldLossPercent !== undefined) {
      data.yieldLossPercent = input.yieldLossPercent !== null
        ? new Prisma.Decimal(new Decimal(input.yieldLossPercent).toFixed(2))
        : null;
    }
    if (input.finalPreparationFee !== undefined) {
      data.finalPreparationFee = input.finalPreparationFee !== null
        ? new Prisma.Decimal(new Decimal(input.finalPreparationFee).toFixed(2))
        : null;
    }
    if (input.preparationFeeDifference !== undefined) {
      data.preparationFeeDifference = input.preparationFeeDifference !== null
        ? new Prisma.Decimal(new Decimal(input.preparationFeeDifference).toFixed(2))
        : null;
    }
    if (input.finalProductSubtotal !== undefined) {
      data.finalProductSubtotal = input.finalProductSubtotal !== null
        ? new Prisma.Decimal(new Decimal(input.finalProductSubtotal).toFixed(2))
        : null;
    }
    if (input.productSubtotalDifference !== undefined) {
      data.productSubtotalDifference = input.productSubtotalDifference !== null
        ? new Prisma.Decimal(new Decimal(input.productSubtotalDifference).toFixed(2))
        : null;
    }
    if (input.finalItemTotal !== undefined) {
      data.finalItemTotal = input.finalItemTotal !== null
        ? new Prisma.Decimal(new Decimal(input.finalItemTotal).toFixed(2))
        : null;
    }
    if (input.totalAdjustmentAmount !== undefined) {
      data.totalAdjustmentAmount = input.totalAdjustmentAmount !== null
        ? new Prisma.Decimal(new Decimal(input.totalAdjustmentAmount).toFixed(2))
        : null;
    }
    if (input.customerApprovalStatus !== undefined) {
      data.customerApprovalStatus = input.customerApprovalStatus;
    }
    if (input.boundApprovalRevision !== undefined) {
      data.boundApprovalRevision = input.boundApprovalRevision;
    }
    if (input.approvalReason !== undefined) {
      data.approvalReason = input.approvalReason;
    }
    if (input.measurementStatus !== undefined) {
      data.measurementStatus = input.measurementStatus;
    }
    if (input.activeMeasurementRevision !== undefined) {
      data.activeMeasurementRevision = input.activeMeasurementRevision;
    }
    if (input.activePreparationRevision !== undefined) {
      data.activePreparationRevision = input.activePreparationRevision;
    }
    if (input.usablePartsOutcome !== undefined) {
      data.usablePartsOutcome = input.usablePartsOutcome;
    }
    if (input.foodSafetyStatus !== undefined) {
      data.foodSafetyStatus = input.foodSafetyStatus;
    }

    try {
      return await client.seafoodOrderWeightAdjustment.update({
        where: { id },
        data,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new AdjustmentNotFoundError(id);
      }
      throw err;
    }
  }
}
