import { BadRequestException, Injectable } from '@nestjs/common';
import { PlatformCommissionConfig, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export function validateCommissionRate(
  value: number | Prisma.Decimal | string,
  fieldName = 'commissionRate',
): Prisma.Decimal {
  if (value === null || value === undefined) {
    throw new BadRequestException(`${fieldName} is required`);
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || Number.isNaN(value))) {
    throw new BadRequestException(`${fieldName} must be a valid finite number`);
  }

  let dec: Prisma.Decimal;
  try {
    dec = new Prisma.Decimal(typeof value === 'string' ? value.trim() : value);
  } catch {
    throw new BadRequestException(`${fieldName} must be a valid decimal representation`);
  }

  if (!dec.isFinite()) {
    throw new BadRequestException(`${fieldName} must be a valid finite decimal`);
  }

  if (!dec.mul(10000).isInteger()) {
    throw new BadRequestException(
      `${fieldName} must have at most 4 decimal places (received "${dec.toString()}")`,
    );
  }

  if (dec.lt(0) || dec.gt(1)) {
    throw new BadRequestException(
      `${fieldName} must be between 0 and 1 inclusive (received "${dec.toString()}")`,
    );
  }

  return dec.toDecimalPlaces(4);
}

@Injectable()
export class CommissionRateConfigsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findCurrent(tx?: Prisma.TransactionClient): Promise<PlatformCommissionConfig | null> {
    const client = tx ?? this.prisma;
    return client.platformCommissionConfig.findFirst({ orderBy: { createdAt: 'desc' } });
  }

  async create(commissionRate: number | Prisma.Decimal | string): Promise<PlatformCommissionConfig> {
    const validatedRate = validateCommissionRate(commissionRate, 'commissionRate');
    return this.prisma.platformCommissionConfig.create({
      data: { commissionRate: validatedRate },
    });
  }
}
