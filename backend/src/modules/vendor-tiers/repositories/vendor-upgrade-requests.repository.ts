import { Injectable } from '@nestjs/common';
import { Prisma, TierRequestStatus, VendorTier, VendorUpgradeRequest } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateUpgradeRequestInput {
  vendorId: string;
  requestedTier: VendorTier;
  reason?: string;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class VendorUpgradeRequestsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateUpgradeRequestInput): Promise<VendorUpgradeRequest> {
    return this.prisma.vendorUpgradeRequest.create({ data: input });
  }

  findById(id: string): Promise<VendorUpgradeRequest | null> {
    return this.prisma.vendorUpgradeRequest.findUnique({ where: { id } });
  }

  findPendingByVendorId(vendorId: string): Promise<VendorUpgradeRequest | null> {
    return this.prisma.vendorUpgradeRequest.findFirst({
      where: { vendorId, status: 'PENDING' },
    });
  }

  updateStatus(
    id: string,
    status: TierRequestStatus,
    data: { reviewedById: string; reviewedAt: Date; reviewNotes?: string },
  ): Promise<VendorUpgradeRequest> {
    return this.prisma.vendorUpgradeRequest.update({ where: { id }, data: { status, ...data } });
  }

  async findMany(
    status: TierRequestStatus | undefined,
    page: Page,
  ): Promise<{ items: VendorUpgradeRequest[]; total: number }> {
    const where: Prisma.VendorUpgradeRequestWhereInput = status ? { status } : {};

    const [items, total] = await Promise.all([
      this.prisma.vendorUpgradeRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.vendorUpgradeRequest.count({ where }),
    ]);

    return { items, total };
  }
}
