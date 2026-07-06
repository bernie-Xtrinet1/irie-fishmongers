import { Injectable } from '@nestjs/common';
import { VendorSettlementAdjustment } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateAdjustmentInput {
  settlementId: string;
  amount: number;
  reason: string;
}

@Injectable()
export class VendorSettlementAdjustmentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateAdjustmentInput): Promise<VendorSettlementAdjustment> {
    return this.prisma.vendorSettlementAdjustment.create({ data: input });
  }

  findBySettlementId(settlementId: string): Promise<VendorSettlementAdjustment[]> {
    return this.prisma.vendorSettlementAdjustment.findMany({
      where: { settlementId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async sumBySettlementId(settlementId: string): Promise<number> {
    const result = await this.prisma.vendorSettlementAdjustment.aggregate({
      where: { settlementId },
      _sum: { amount: true },
    });
    return result._sum.amount?.toNumber() ?? 0;
  }
}
