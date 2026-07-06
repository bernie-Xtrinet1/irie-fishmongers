import { Injectable } from '@nestjs/common';
import { PlatformCommissionConfig } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class CommissionRateConfigsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findCurrent(): Promise<PlatformCommissionConfig | null> {
    return this.prisma.platformCommissionConfig.findFirst({ orderBy: { createdAt: 'desc' } });
  }

  create(commissionRate: number): Promise<PlatformCommissionConfig> {
    return this.prisma.platformCommissionConfig.create({ data: { commissionRate } });
  }
}
