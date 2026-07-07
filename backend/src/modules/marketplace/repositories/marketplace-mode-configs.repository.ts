import { Injectable } from '@nestjs/common';
import { MarketplaceModeConfig } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateModeConfigInput {
  customerSelectedEnabled: boolean;
  bestAvailableEnabled: boolean;
  updatedById: string;
}

@Injectable()
export class MarketplaceModeConfigsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findCurrent(): Promise<MarketplaceModeConfig | null> {
    return this.prisma.marketplaceModeConfig.findFirst({ orderBy: { createdAt: 'desc' } });
  }

  create(input: CreateModeConfigInput): Promise<MarketplaceModeConfig> {
    return this.prisma.marketplaceModeConfig.create({ data: input });
  }
}
