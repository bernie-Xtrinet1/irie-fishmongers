import { Injectable } from '@nestjs/common';
import { Prisma, SeafoodOrderWeightAdjustment } from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../database/prisma.service';
import {
  CreateAdjustmentSnapshotInput,
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

  async createAdjustmentSnapshot(
    input: CreateAdjustmentSnapshotInput,
    tx?: Prisma.TransactionClient,
  ): Promise<SeafoodOrderWeightAdjustment> {
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
