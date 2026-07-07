import { Injectable } from '@nestjs/common';
import { VendorTier, VendorTierConfig } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class VendorTierConfigsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByTier(tier: VendorTier): Promise<VendorTierConfig | null> {
    return this.prisma.vendorTierConfig.findUnique({ where: { tier } });
  }

  findAll(): Promise<VendorTierConfig[]> {
    return this.prisma.vendorTierConfig.findMany({ orderBy: { tier: 'asc' } });
  }
}
