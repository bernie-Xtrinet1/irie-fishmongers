import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Prisma,
  VendorSettlementAdjustment,
  VendorSettlementDisbursementStatus,
  VendorSettlementStatus,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateAdjustmentInput {
  settlementId: string;
  amount: Prisma.Decimal | number | string;
  reason: string;
  idempotencyKey?: string | null;
  refundId?: string | null;
  allocationId?: string | null;
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
export class VendorSettlementAdjustmentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateAdjustmentInput, tx?: Prisma.TransactionClient): Promise<VendorSettlementAdjustment> {
    const amount = toPrismaDecimal(input.amount, 'amount');

    if (
      (input.refundId !== undefined && input.refundId !== null) ||
      (input.allocationId !== undefined && input.allocationId !== null)
    ) {
      if (
        !input.idempotencyKey ||
        typeof input.idempotencyKey !== 'string' ||
        input.idempotencyKey.trim().length === 0
      ) {
        throw new BadRequestException(
          'idempotencyKey is required and cannot be empty for refund-linked adjustments',
        );
      }
    }

    const executeCreate = async (client: Prisma.TransactionClient): Promise<VendorSettlementAdjustment> => {
      if (amount.lt(0) && typeof (client as any).$queryRaw === 'function') {
        await client.$queryRaw`SELECT "id" FROM "vendor_settlements" WHERE "id" = ${input.settlementId} FOR UPDATE`;
        const settlement = await client.vendorSettlement.findUnique({
          where: { id: input.settlementId },
          select: { id: true, status: true, netAmount: true },
        });
        if (settlement) {
          if (settlement.status === VendorSettlementStatus.FAILED) {
            throw new BadRequestException(
              `Cannot post negative adjustment against FAILED settlement ${settlement.id}`,
            );
          }
          if (settlement.status === VendorSettlementStatus.PAID) {
            throw new BadRequestException(
              `Cannot post negative adjustment against PAID settlement ${settlement.id}`,
            );
          }

          const existingAdjAgg = await client.vendorSettlementAdjustment.aggregate({
            where: { settlementId: input.settlementId },
            _sum: { amount: true },
          });
          const activeDisbAgg = await client.vendorSettlementDisbursement.aggregate({
            where: {
              settlementId: input.settlementId,
              status: {
                in: [
                  VendorSettlementDisbursementStatus.IN_FLIGHT,
                  VendorSettlementDisbursementStatus.CONFIRMED,
                ],
              },
            },
            _sum: { amount: true },
          });
          const existingAdj = new Prisma.Decimal(existingAdjAgg._sum.amount ?? 0);
          const activeDisb = new Prisma.Decimal(activeDisbAgg._sum.amount ?? 0);
          const adjustedAfter = new Prisma.Decimal(settlement.netAmount)
            .plus(existingAdj)
            .plus(amount);

          if (adjustedAfter.lt(0)) {
            throw new BadRequestException(
              `Negative adjustment (${amount}) would make settlement ${settlement.id} adjusted net negative (${adjustedAfter})`,
            );
          }
          if (adjustedAfter.lt(activeDisb)) {
            throw new BadRequestException(
              `Negative adjustment (${amount}) reduces settlement ${settlement.id} payable net (${adjustedAfter}) below active disbursements (${activeDisb})`,
            );
          }
        }
      }

      return client.vendorSettlementAdjustment.create({
        data: {
          settlementId: input.settlementId,
          amount,
          reason: input.reason,
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          ...(input.refundId !== undefined ? { refundId: input.refundId } : {}),
          ...(input.allocationId !== undefined ? { allocationId: input.allocationId } : {}),
        },
      });
    };

    if (tx) {
      return executeCreate(tx);
    }
    if (amount.lt(0) && typeof (this.prisma as any).$transaction === 'function') {
      return this.prisma.$transaction((innerTx) => executeCreate(innerTx));
    }
    return executeCreate(this.prisma);
  }

  findById(id: string, tx?: Prisma.TransactionClient): Promise<VendorSettlementAdjustment | null> {
    const client = tx ?? this.prisma;
    return client.vendorSettlementAdjustment.findUnique({
      where: { id },
    });
  }

  findByIdempotencyKey(idempotencyKey: string, tx?: Prisma.TransactionClient): Promise<VendorSettlementAdjustment | null> {
    const client = tx ?? this.prisma;
    return client.vendorSettlementAdjustment.findUnique({
      where: { idempotencyKey },
    });
  }

  findByRefundId(refundId: string, tx?: Prisma.TransactionClient): Promise<VendorSettlementAdjustment[]> {
    const client = tx ?? this.prisma;
    return client.vendorSettlementAdjustment.findMany({
      where: { refundId },
      orderBy: { createdAt: 'asc' },
    });
  }

  findBySettlementId(settlementId: string, tx?: Prisma.TransactionClient): Promise<VendorSettlementAdjustment[]> {
    const client = tx ?? this.prisma;
    return client.vendorSettlementAdjustment.findMany({
      where: { settlementId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async sumBySettlementIdDecimal(settlementId: string, tx?: Prisma.TransactionClient): Promise<Prisma.Decimal> {
    const client = tx ?? this.prisma;
    const result = await client.vendorSettlementAdjustment.aggregate({
      where: { settlementId },
      _sum: { amount: true },
    });
    return result._sum.amount ? new Prisma.Decimal(result._sum.amount) : new Prisma.Decimal(0);
  }

  async sumBySettlementId(settlementId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const decimalSum = await this.sumBySettlementIdDecimal(settlementId, tx);
    return decimalSum.toNumber();
  }
}
