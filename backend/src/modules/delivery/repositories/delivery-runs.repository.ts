import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

const deliveryRunWithStops = Prisma.validator<Prisma.DeliveryRunDefaultArgs>()({
  include: { stops: { orderBy: { sequence: 'asc' } } },
});

export type DeliveryRunWithStops = Prisma.DeliveryRunGetPayload<typeof deliveryRunWithStops>;

export interface CreateDeliveryRunInput {
  zoneId: string;
  stops: { deliveryId: string; sequence: number }[];
}

export interface AssignDeliveryRunInput {
  driverId: string;
  fleetAssetId?: string;
}

@Injectable()
export class DeliveryRunsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateDeliveryRunInput): Promise<DeliveryRunWithStops> {
    return this.prisma.deliveryRun.create({
      data: {
        zoneId: input.zoneId,
        stops: { create: input.stops },
      },
      include: deliveryRunWithStops.include,
    });
  }

  findById(id: string): Promise<DeliveryRunWithStops | null> {
    return this.prisma.deliveryRun.findUnique({
      where: { id },
      include: deliveryRunWithStops.include,
    });
  }

  assign(id: string, input: AssignDeliveryRunInput): Promise<DeliveryRunWithStops> {
    return this.prisma.deliveryRun.update({
      where: { id },
      data: { driverId: input.driverId, fleetAssetId: input.fleetAssetId, status: 'IN_PROGRESS' },
      include: deliveryRunWithStops.include,
    });
  }
}
