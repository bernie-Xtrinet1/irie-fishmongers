import { Injectable } from '@nestjs/common';
import { DeliveryRunStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

const deliveryRunWithStops = Prisma.validator<Prisma.DeliveryRunDefaultArgs>()({
  include: { stops: { orderBy: { sequence: 'asc' } } },
});

export type DeliveryRunWithStops = Prisma.DeliveryRunGetPayload<typeof deliveryRunWithStops>;

// Everything the 10A dispatch-scoring algorithm needs to compute a run's
// total weight and cold-chain requirement in one query, rather than N+1
// per-stop lookups against DeliveriesRepository.
const deliveryRunWithDispatchContext = Prisma.validator<Prisma.DeliveryRunDefaultArgs>()({
  include: {
    stops: {
      include: {
        delivery: {
          include: {
            vendorOrder: {
              include: {
                items: { include: { product: { select: { weightLbs: true, lotId: true } } } },
              },
            },
          },
        },
      },
    },
  },
});

export type DeliveryRunWithDispatchContext = Prisma.DeliveryRunGetPayload<
  typeof deliveryRunWithDispatchContext
>;

export interface CreateDeliveryRunInput {
  zoneId: string;
  stops: { deliveryId: string; sequence: number }[];
}

export interface AssignDeliveryRunInput {
  driverId: string;
  fleetAssetId?: string;
}

export interface DeliveryRunFilters {
  status?: DeliveryRunStatus;
  zoneId?: string;
}

export interface Page {
  skip: number;
  take: number;
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

  findByIdWithDispatchContext(id: string): Promise<DeliveryRunWithDispatchContext | null> {
    return this.prisma.deliveryRun.findUnique({
      where: { id },
      include: deliveryRunWithDispatchContext.include,
    });
  }

  assign(id: string, input: AssignDeliveryRunInput): Promise<DeliveryRunWithStops> {
    return this.prisma.deliveryRun.update({
      where: { id },
      data: { driverId: input.driverId, fleetAssetId: input.fleetAssetId, status: 'IN_PROGRESS' },
      include: deliveryRunWithStops.include,
    });
  }

  // Dispatcher-facing list (10B: Delivery Operations Center) - status/zone
  // filters let the dashboard separate "needs dispatch" (PLANNED) from
  // "active" (IN_PROGRESS) without two hand-rolled queries client-side.
  async findMany(
    filters: DeliveryRunFilters,
    page: Page,
  ): Promise<{ items: DeliveryRunWithStops[]; total: number }> {
    const where: Prisma.DeliveryRunWhereInput = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.zoneId ? { zoneId: filters.zoneId } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.deliveryRun.findMany({
        where,
        include: deliveryRunWithStops.include,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.deliveryRun.count({ where }),
    ]);

    return { items, total };
  }
}
