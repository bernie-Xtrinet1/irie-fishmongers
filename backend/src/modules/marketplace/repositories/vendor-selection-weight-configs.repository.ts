import { Injectable } from '@nestjs/common';
import { VendorSelectionWeightConfig } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateWeightConfigInput {
  inventoryWeight: number;
  freshnessWeight: number;
  complianceWeight: number;
  distanceWeight: number;
  ratingWeight: number;
  deliveryCapacityWeight: number;
  updatedById: string;
}

@Injectable()
export class VendorSelectionWeightConfigsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findCurrent(): Promise<VendorSelectionWeightConfig | null> {
    return this.prisma.vendorSelectionWeightConfig.findFirst({ orderBy: { createdAt: 'desc' } });
  }

  create(input: CreateWeightConfigInput): Promise<VendorSelectionWeightConfig> {
    return this.prisma.vendorSelectionWeightConfig.create({ data: input });
  }
}
