import { Injectable } from '@nestjs/common';
import { DispatchDecisionLog, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface ScoredCandidate {
  id: string;
  score: number;
  eligible: boolean;
}

export interface CreateDispatchDecisionLogInput {
  deliveryRunId: string;
  requiresColdChain: boolean;
  totalWeightLbs: number;
  candidateDrivers: ScoredCandidate[];
  candidateAssets: ScoredCandidate[];
  selectedDriverId: string | null;
  selectedAssetId: string | null;
  reason: string;
}

@Injectable()
export class DispatchDecisionLogsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateDispatchDecisionLogInput): Promise<DispatchDecisionLog> {
    return this.prisma.dispatchDecisionLog.create({
      data: {
        deliveryRunId: input.deliveryRunId,
        requiresColdChain: input.requiresColdChain,
        totalWeightLbs: input.totalWeightLbs,
        candidateDrivers: input.candidateDrivers as unknown as Prisma.InputJsonValue,
        candidateAssets: input.candidateAssets as unknown as Prisma.InputJsonValue,
        selectedDriverId: input.selectedDriverId,
        selectedAssetId: input.selectedAssetId,
        reason: input.reason,
      },
    });
  }

  findByDeliveryRunId(deliveryRunId: string): Promise<DispatchDecisionLog[]> {
    return this.prisma.dispatchDecisionLog.findMany({
      where: { deliveryRunId },
      orderBy: { decidedAt: 'desc' },
    });
  }
}
