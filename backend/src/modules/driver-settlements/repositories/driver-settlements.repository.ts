import { Injectable } from '@nestjs/common';
import { DriverSettlement, Prisma, SettlementStatus, VehicleOwnership } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

const deliveryForSettlement = Prisma.validator<Prisma.DeliveryDefaultArgs>()({
  include: {
    driver: true,
    vendorOrder: { include: { items: true } },
  },
});

export type DeliveryForSettlement = Prisma.DeliveryGetPayload<typeof deliveryForSettlement>;

export interface CreateSettlementInput {
  driverId: string;
  deliveryId?: string;
  vehicleOwnership: VehicleOwnership;
  baseFee: number;
  distanceKm: number;
  distanceFee: number;
  heavyLoadBonus: number;
  peakBonus: number;
  volumeBonus: number;
  totalPayout: number;
  settlementPeriodStart: Date;
  settlementPeriodEnd: Date;
}

export interface Page {
  skip: number;
  take: number;
}

export interface SettlementFilters {
  driverId?: string;
  status?: SettlementStatus;
}

@Injectable()
export class DriverSettlementsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findUnsettledDeliveries(periodStart: Date, periodEnd: Date): Promise<DeliveryForSettlement[]> {
    return this.prisma.delivery.findMany({
      where: {
        deliveredAt: { gte: periodStart, lte: periodEnd },
        settlement: null,
      },
      include: deliveryForSettlement.include,
      orderBy: { deliveredAt: 'asc' },
    });
  }

  create(input: CreateSettlementInput): Promise<DriverSettlement> {
    return this.prisma.driverSettlement.create({ data: input });
  }

  findById(id: string): Promise<DriverSettlement | null> {
    return this.prisma.driverSettlement.findUnique({ where: { id } });
  }

  countDeliveriesInPeriod(driverId: string, periodStart: Date, periodEnd: Date): Promise<number> {
    return this.prisma.driverSettlement.count({
      where: {
        driverId,
        settlementPeriodStart: periodStart,
        settlementPeriodEnd: periodEnd,
        deliveryId: { not: null },
      },
    });
  }

  findVolumeBonusRow(
    driverId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<DriverSettlement | null> {
    return this.prisma.driverSettlement.findFirst({
      where: {
        driverId,
        settlementPeriodStart: periodStart,
        settlementPeriodEnd: periodEnd,
        deliveryId: null,
      },
    });
  }

  updateStatus(
    id: string,
    status: SettlementStatus,
    data: { payoutDate?: Date; notes?: string } = {},
  ): Promise<DriverSettlement> {
    return this.prisma.driverSettlement.update({ where: { id }, data: { status, ...data } });
  }

  async findManyByDriver(
    driverId: string,
    page: Page,
  ): Promise<{ items: DriverSettlement[]; total: number }> {
    const where: Prisma.DriverSettlementWhereInput = { driverId };

    const [items, total] = await Promise.all([
      this.prisma.driverSettlement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.driverSettlement.count({ where }),
    ]);

    return { items, total };
  }

  async findMany(
    filters: SettlementFilters,
    page: Page,
  ): Promise<{ items: DriverSettlement[]; total: number }> {
    const where: Prisma.DriverSettlementWhereInput = {
      ...(filters.driverId ? { driverId: filters.driverId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.driverSettlement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.driverSettlement.count({ where }),
    ]);

    return { items, total };
  }
}
