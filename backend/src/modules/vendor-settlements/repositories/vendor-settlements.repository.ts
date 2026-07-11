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
}
