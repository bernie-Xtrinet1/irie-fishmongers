import { Injectable } from '@nestjs/common';
import { Prisma, VendorOrder, VendorSettlement, VendorSettlementStatus } from '@prisma/client';

import { DateRange } from '../../../common/dto/date-range.type';
import { PrismaService } from '../../../database/prisma.service';

export interface CreateSettlementInput {
  vendorId: string;
  vendorOrderId: string;
  grossAmount: number;
  platformFee: number;
  netAmount: number;
}

export interface Page {
  skip: number;
  take: number;
}

export interface SettlementFilters {
  vendorId?: string;
  status?: VendorSettlementStatus;
}

@Injectable()
export class VendorSettlementsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findEligibleVendorOrders(): Promise<VendorOrder[]> {
    return this.prisma.vendorOrder.findMany({
      where: {
        status: 'DELIVERED',
        settlement: null,
        order: { payment: { status: 'PAID' } },
      },
      orderBy: { updatedAt: 'asc' },
    });
  }

  create(input: CreateSettlementInput): Promise<VendorSettlement> {
    return this.prisma.vendorSettlement.create({ data: input });
  }

  findById(id: string): Promise<VendorSettlement | null> {
    return this.prisma.vendorSettlement.findUnique({ where: { id } });
  }

  updateStatus(
    id: string,
    status: VendorSettlementStatus,
    data: { paymentDate?: Date; notes?: string } = {},
  ): Promise<VendorSettlement> {
    return this.prisma.vendorSettlement.update({ where: { id }, data: { status, ...data } });
  }

  async findManyByVendor(
    vendorId: string,
    page: Page,
  ): Promise<{ items: VendorSettlement[]; total: number }> {
    const where: Prisma.VendorSettlementWhereInput = { vendorId };

    const [items, total] = await Promise.all([
      this.prisma.vendorSettlement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.vendorSettlement.count({ where }),
    ]);

    return { items, total };
  }

  async findMany(
    filters: SettlementFilters,
    page: Page,
  ): Promise<{ items: VendorSettlement[]; total: number }> {
    const where: Prisma.VendorSettlementWhereInput = {
      ...(filters.vendorId ? { vendorId: filters.vendorId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.vendorSettlement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.vendorSettlement.count({ where }),
    ]);

    return { items, total };
  }

  async sumPlatformFeeByStatus(status: VendorSettlementStatus, range?: DateRange): Promise<Prisma.Decimal> {
    const result = await this.prisma.vendorSettlement.aggregate({
      _sum: { platformFee: true },
      where: {
        status,
        ...(range?.from || range?.to
          ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
          : {}),
      },
    });
    return result._sum.platformFee ?? new Prisma.Decimal(0);
  }

  // 12B Vendor Dashboard: highest-grossing vendors by settled (PAID)
  // revenue. Prisma's groupBy has no relation-include, so vendor
  // businessName is fetched in a second query and merged here rather than
  // leaving the caller to do it - "top vendors by revenue" is one cohesive
  // concept, not two separate reads for a caller to stitch together.
  async getTopVendorsByRevenue(
    limit: number,
    range?: DateRange,
  ): Promise<{ vendorId: string; businessName: string; grossAmount: string }[]> {
    const groups = await this.prisma.vendorSettlement.groupBy({
      by: ['vendorId'],
      _sum: { grossAmount: true },
      where: {
        status: 'PAID',
        ...(range?.from || range?.to
          ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
          : {}),
      },
      orderBy: { _sum: { grossAmount: 'desc' } },
      take: limit,
    });

    if (groups.length === 0) {
      return [];
    }

    const vendors = await this.prisma.vendor.findMany({
      where: { id: { in: groups.map((group) => group.vendorId) } },
      select: { id: true, businessName: true },
    });
    const businessNameById = new Map(vendors.map((vendor) => [vendor.id, vendor.businessName]));

    return groups.map((group) => ({
      vendorId: group.vendorId,
      businessName: businessNameById.get(group.vendorId) ?? 'Unknown vendor',
      grossAmount: (group._sum.grossAmount ?? new Prisma.Decimal(0)).toString(),
    }));
  }
}
