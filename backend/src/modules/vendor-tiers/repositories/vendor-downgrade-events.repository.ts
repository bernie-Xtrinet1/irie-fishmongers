import { Injectable } from '@nestjs/common';
import { DowngradeReason, VendorDowngradeEvent, VendorTier } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateDowngradeEventInput {
  vendorId: string;
  fromTier: VendorTier;
  toTier: VendorTier;
  reason: DowngradeReason;
  triggeredById?: string;
  notes?: string;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class VendorDowngradeEventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateDowngradeEventInput): Promise<VendorDowngradeEvent> {
    return this.prisma.vendorDowngradeEvent.create({ data: input });
  }

  async findByVendorId(
    vendorId: string,
    page: Page,
  ): Promise<{ items: VendorDowngradeEvent[]; total: number }> {
    const where = { vendorId };

    const [items, total] = await Promise.all([
      this.prisma.vendorDowngradeEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.vendorDowngradeEvent.count({ where }),
    ]);

    return { items, total };
  }
}
