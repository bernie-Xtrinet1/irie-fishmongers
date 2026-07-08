import { Injectable } from '@nestjs/common';
import { RouteHistory } from '@prisma/client';

import { PrismaClientOrTx } from '../../orders/repositories/orders.repository';
import { PrismaService } from '../../../database/prisma.service';

export interface CreateRouteHistoryInput {
  deliveryId: string;
  driverId: string;
  gpsSamples: number;
  distanceKm: number;
  durationMinutes: number;
}

@Injectable()
export class RouteHistoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    input: CreateRouteHistoryInput,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<RouteHistory> {
    return client.routeHistory.create({ data: input });
  }

  findByDeliveryId(deliveryId: string): Promise<RouteHistory | null> {
    return this.prisma.routeHistory.findUnique({ where: { deliveryId } });
  }
}
