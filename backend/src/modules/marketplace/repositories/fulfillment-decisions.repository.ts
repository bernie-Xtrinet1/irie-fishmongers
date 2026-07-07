import { Injectable } from '@nestjs/common';
import { Parish } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateDecisionInput {
  requestedProductId: string;
  quantity: number;
  deliveryParish: Parish;
  customerId: string;
  decidedAt: Date;
}

export interface CreateScoreInput {
  vendorId: string;
  productId: string;
  inventoryScore: number;
  freshnessScore: number;
  complianceScore: number;
  distanceScore: number;
  ratingScore: number;
  deliveryCapacityScore: number;
  totalScore: number;
  eligible: boolean;
  ineligibilityReason: string | null;
}

export interface CreateAssignmentInput {
  vendorId: string;
  productId: string;
}

@Injectable()
export class FulfillmentDecisionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // A decision persists even when `winner` is null - a "no eligible
  // vendor" outcome is itself an auditable fact, per vendor-selection-
  // engine.md's Audit Requirements, not an error to discard.
  async createDecisionWithScores(
    decision: CreateDecisionInput,
    scores: CreateScoreInput[],
    winner: CreateAssignmentInput | null,
  ): Promise<string> {
    const created = await this.prisma.$transaction(async (tx) => {
      const decisionRow = await tx.fulfillmentDecision.create({ data: decision });

      if (scores.length > 0) {
        await tx.vendorScore.createMany({
          data: scores.map((score) => ({ ...score, fulfillmentDecisionId: decisionRow.id })),
        });
      }

      if (winner) {
        await tx.vendorAssignment.create({
          data: { ...winner, fulfillmentDecisionId: decisionRow.id },
        });
      }

      return decisionRow;
    });

    return created.id;
  }
}
