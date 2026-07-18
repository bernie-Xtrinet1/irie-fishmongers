import { Injectable } from '@nestjs/common';
import { Parish, Prisma, Vendor, VendorStatus, VendorTier } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateVendorInput {
  userId: string;
  businessName: string;
  parish: Parish;
  termsAcceptedAt: Date;
  phone?: string;
  description?: string;
}

export interface UpdateVendorInput {
  businessName?: string;
  description?: string;
  phone?: string;
  parish?: Parish;
  logoUrl?: string;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class VendorsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateVendorInput): Promise<Vendor> {
    return this.prisma.vendor.create({ data: input });
  }

  findById(id: string): Promise<Vendor | null> {
    return this.prisma.vendor.findUnique({ where: { id } });
  }

  findByUserId(userId: string): Promise<Vendor | null> {
    return this.prisma.vendor.findUnique({ where: { userId } });
  }

  updateStatus(id: string, status: VendorStatus): Promise<Vendor> {
    return this.prisma.vendor.update({ where: { id }, data: { status } });
  }

  updateTier(id: string, tier: VendorTier): Promise<Vendor> {
    return this.prisma.vendor.update({ where: { id }, data: { tier } });
  }

  // Write-through cache of the composite compliance score (Phase 13C). The
  // timestamp is written in the same update so any reader can tell how fresh
  // the score is - a bare number with no "as of" is indistinguishable from a
  // stale one.
  updateComplianceScore(id: string, score: number): Promise<Vendor> {
    return this.prisma.vendor.update({
      where: { id },
      data: { complianceScore: score, complianceScoreUpdatedAt: new Date() },
    });
  }

  // Page through APPROVED vendors for the nightly compliance recompute sweep
  // and the one-time backfill, ordered stably so paging is deterministic.
  findApprovedIds(page: Page): Promise<{ id: string; tier: VendorTier }[]> {
    return this.prisma.vendor.findMany({
      where: { status: 'APPROVED' },
      select: { id: true, tier: true },
      orderBy: { createdAt: 'asc' },
      skip: page.skip,
      take: page.take,
    });
  }

  update(id: string, input: UpdateVendorInput): Promise<Vendor> {
    return this.prisma.vendor.update({ where: { id }, data: input });
  }

  async findMany(
    status: VendorStatus | undefined,
    page: Page,
    tier?: VendorTier,
  ): Promise<{ items: Vendor[]; total: number }> {
    const where: Prisma.VendorWhereInput = {
      ...(status ? { status } : {}),
      ...(tier ? { tier } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.vendor.findMany({
        where,
        skip: page.skip,
        take: page.take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.vendor.count({ where }),
    ]);

    return { items, total };
  }

  countDeliveredOrders(vendorId: string): Promise<number> {
    return this.prisma.vendorOrder.count({ where: { vendorId, status: 'DELIVERED' } });
  }

  async getComplianceSummary(): Promise<{
    countByStatus: Record<VendorStatus, number>;
    averageComplianceScore: number | null;
  }> {
    const [groups, aggregate] = await Promise.all([
      this.prisma.vendor.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.vendor.aggregate({ _avg: { complianceScore: true } }),
    ]);

    const countByStatus: Record<VendorStatus, number> = {
      PENDING: 0,
      APPROVED: 0,
      SUSPENDED: 0,
      REJECTED: 0,
    };
    for (const group of groups) {
      countByStatus[group.status] = group._count._all;
    }

    return { countByStatus, averageComplianceScore: aggregate._avg.complianceScore };
  }

  // 12B Vendor Dashboard: tier distribution, mirroring getComplianceSummary's
  // status groupBy pattern.
  async countByTier(): Promise<Record<VendorTier, number>> {
    const groups = await this.prisma.vendor.groupBy({ by: ['tier'], _count: { _all: true } });

    const countByTier: Record<VendorTier, number> = {
      COMMUNITY_FISHER: 0,
      VERIFIED_VENDOR: 0,
      COMMERCIAL_SUPPLIER: 0,
      ENTERPRISE_SUPPLIER: 0,
    };
    for (const group of groups) {
      countByTier[group.tier] = group._count._all;
    }
    return countByTier;
  }
}
