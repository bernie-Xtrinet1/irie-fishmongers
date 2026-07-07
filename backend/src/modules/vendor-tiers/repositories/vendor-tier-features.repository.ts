import { Injectable } from '@nestjs/common';
import { VendorTier, VendorTierFeature } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class VendorTierFeaturesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByTier(tier: VendorTier): Promise<VendorTierFeature[]> {
    return this.prisma.vendorTierFeature.findMany({ where: { tier } });
  }
}
