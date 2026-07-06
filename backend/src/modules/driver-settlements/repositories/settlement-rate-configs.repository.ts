import { Injectable } from '@nestjs/common';
import { SettlementRateConfig } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateRateConfigInput {
  baseFee: number;
  distanceCompensationEnabled: boolean;
  distanceRatePerKm: number;
  heavyLoadThresholdLbs: number;
  heavyLoadBonus: number;
  peakBonus: number;
  volumeBonusTier1Threshold: number;
  volumeBonusTier1Amount: number;
  volumeBonusTier2Threshold: number;
  volumeBonusTier2Amount: number;
  volumeBonusTier3Threshold: number;
  volumeBonusTier3Amount: number;
}

@Injectable()
export class SettlementRateConfigsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findCurrent(): Promise<SettlementRateConfig | null> {
    return this.prisma.settlementRateConfig.findFirst({ orderBy: { createdAt: 'desc' } });
  }

  create(input: CreateRateConfigInput): Promise<SettlementRateConfig> {
    return this.prisma.settlementRateConfig.create({ data: input });
  }
}
