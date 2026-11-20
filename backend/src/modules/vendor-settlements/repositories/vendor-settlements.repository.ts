import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  VendorOrder,
  VendorReceivableRecoveryType,
  VendorSettlement,
  VendorSettlementDisbursementStatus,
  VendorSettlementStatus,
} from '@prisma/client';

import { DateRange } from '../../../common/dto/date-range.type';
import { PrismaService } from '../../../database/prisma.service';
import { validateCommissionRate } from './commission-rate-configs.repository';

export interface CreateSettlementInput {
  vendorId: string;
  vendorOrderId: string;
  grossAmount: Prisma.Decimal | number | string;
  platformFee: Prisma.Decimal | number | string;
  netAmount: Prisma.Decimal | number | string;
  commissionConfigId?: string | null;
  commissionRateSnapshot?: Prisma.Decimal | number | string | null;
}

export interface Page {
  skip: number;
  take: number;
}

export interface SettlementFilters {
  vendorId?: string;
  status?: VendorSettlementStatus;
}

function toPrismaDecimal(value: Prisma.Decimal | number | string, fieldName: string): Prisma.Decimal {
  if (value === null || value === undefined) {
    throw new BadRequestException(`${fieldName} is required`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      throw new BadRequestException(`${fieldName} must be a valid finite number`);
    }
    return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }
  try {
    const d = new Prisma.Decimal(value);
    if (!d.isFinite()) {
      throw new BadRequestException(`${fieldName} must be a valid finite decimal`);
    }
    return d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  } catch {
    throw new BadRequestException(`${fieldName} must be a valid decimal representation`);
  }
}

@Injectable()
export class VendorSettlementsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findEligibleVendorOrders(tx?: Prisma.TransactionClient): Promise<VendorOrder[]> {
    const client = tx ?? this.prisma;
    return client.vendorOrder.findMany({
      where: {
        status: 'DELIVERED',
        settlement: null,
        order: { payment: { status: 'PAID' } },
      },
      orderBy: { updatedAt: 'asc' },
    });
  }

  async create(input: CreateSettlementInput, tx?: Prisma.TransactionClient): Promise<VendorSettlement> {
    const client = tx ?? this.prisma;
    const grossAmount = toPrismaDecimal(input.grossAmount, 'grossAmount');
    const platformFee = toPrismaDecimal(input.platformFee, 'platformFee');
    const netAmount = toPrismaDecimal(input.netAmount, 'netAmount');

    if (grossAmount.lt(0) || platformFee.lt(0) || netAmount.lt(0)) {
      throw new BadRequestException('Settlement monetary amounts cannot be negative');
    }
    if (!grossAmount.minus(platformFee).equals(netAmount)) {
      throw new BadRequestException(
        `Settlement netAmount (${netAmount}) must equal grossAmount (${grossAmount}) - platformFee (${platformFee})`,
      );
    }

    const commissionRateSnapshot =
      input.commissionRateSnapshot !== undefined && input.commissionRateSnapshot !== null
        ? validateCommissionRate(input.commissionRateSnapshot, 'commissionRateSnapshot')
        : null;

    if (input.commissionConfigId && !commissionRateSnapshot) {
      throw new BadRequestException(
        'commissionRateSnapshot is required when commissionConfigId is supplied',
      );
    }

    return client.vendorSettlement.create({
      data: {
        vendorId: input.vendorId,
        vendorOrderId: input.vendorOrderId,
        grossAmount,
        platformFee,
        netAmount,
        commissionConfigId: input.commissionConfigId ?? null,
        commissionRateSnapshot,
      },
    });
  }

  findById(id: string): Promise<VendorSettlement | null> {
    return this.prisma.vendorSettlement.findUnique({ where: { id } });
  }

  async updateStatus(
    id: string,
    status: VendorSettlementStatus,
    data: { paymentDate?: Date; notes?: string } = {},
  ): Promise<VendorSettlement> {
    const executeUpdate = async (client: Prisma.TransactionClient): Promise<VendorSettlement> => {
      await client.$queryRaw`SELECT "id" FROM "vendor_settlements" WHERE "id" = ${id} FOR UPDATE`;
      const existing = await client.vendorSettlement.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundException(`VendorSettlement ${id} not found`);
      }

      if (status === VendorSettlementStatus.FAILED) {
        const committedOffset = await client.vendorReceivableRecovery.findFirst({
          where: {
            recoveryType: VendorReceivableRecoveryType.SETTLEMENT_OFFSET,
            targetAdjustment: { settlementId: id },
          },
          select: { id: true, receivableId: true },
        });
        if (committedOffset) {
          throw new ConflictException(
            `Cannot mark settlement ${id} as FAILED because SETTLEMENT_OFFSET recovery ${committedOffset.id} (receivable ${committedOffset.receivableId}) depends on it`,
          );
        }

        const activeDisbursement = await client.vendorSettlementDisbursement.findFirst({
          where: {
            settlementId: id,
            status: {
              in: [
                VendorSettlementDisbursementStatus.IN_FLIGHT,
                VendorSettlementDisbursementStatus.CONFIRMED,
              ],
            },
          },
          select: { id: true, status: true },
        });
        if (activeDisbursement) {
          throw new ConflictException(
            `Cannot mark settlement ${id} as FAILED while disbursement ${activeDisbursement.id} is ${activeDisbursement.status}`,
          );
        }
      }

      if (status === VendorSettlementStatus.PAID) {
        const adjSumAgg = await client.vendorSettlementAdjustment.aggregate({
          where: { settlementId: id },
          _sum: { amount: true },
        });
        const adjustedNet = new Prisma.Decimal(existing.netAmount).plus(
          new Prisma.Decimal(adjSumAgg._sum.amount ?? 0),
        );
        if (adjustedNet.lt(0)) {
          throw new BadRequestException(
            `Cannot mark settlement ${id} as PAID with negative adjusted net (${adjustedNet})`,
          );
        }
      }

      return client.vendorSettlement.update({ where: { id }, data: { status, ...data } });
    };

    if (typeof (this.prisma as any).$transaction === 'function') {
      return this.prisma.$transaction((tx) => executeUpdate(tx));
    }
    return executeUpdate(this.prisma);
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
