import { Injectable } from '@nestjs/common';
import { RouteOptimizationRun } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateRouteOptimizationRunInput {
  zoneId: string;
  strategyName: string;
  deliveryIds: string[];
}

@Injectable()
export class RouteOptimizationRunsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateRouteOptimizationRunInput): Promise<RouteOptimizationRun> {
    return this.prisma.routeOptimizationRun.create({ data: input });
  }
}
