import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { RoutePlanResponseEntity } from '../entities/route-plan-response.entity';
import { DeliveriesRepository } from '../repositories/deliveries.repository';
import { DeliveryRunsRepository } from '../repositories/delivery-runs.repository';
import { DeliveryZonesRepository } from '../repositories/delivery-zones.repository';
import { RouteOptimizationRunsRepository } from '../repositories/route-optimization-runs.repository';
import {
  ROUTE_OPTIMIZATION_STRATEGY,
  RouteOptimizationStrategy,
  RouteStop,
} from './route-optimization-strategy.interface';

@Injectable()
export class RouteOptimizationService {
  constructor(
    private readonly deliveryZonesRepository: DeliveryZonesRepository,
    private readonly deliveriesRepository: DeliveriesRepository,
    private readonly routeOptimizationRunsRepository: RouteOptimizationRunsRepository,
    private readonly deliveryRunsRepository: DeliveryRunsRepository,
    @Inject(ROUTE_OPTIMIZATION_STRATEGY) private readonly strategy: RouteOptimizationStrategy,
  ) {}

  async optimizeRoute(zoneId: string): Promise<RoutePlanResponseEntity> {
    const zone = await this.deliveryZonesRepository.findById(zoneId);
    if (!zone) {
      throw new NotFoundException('Delivery zone not found');
    }

    const deliveries = await this.deliveriesRepository.findScheduledForZone(zoneId);
    const stops: RouteStop[] = deliveries.map((delivery) => ({
      deliveryId: delivery.id,
      vendorOrderId: delivery.vendorOrderId,
      zoneId,
      vendorId: delivery.vendorOrder.vendorId,
      deliveryParish: delivery.vendorOrder.order.deliveryParish,
    }));

    const plan = this.strategy.planRoute(stops);

    const routeOptimizationRun = await this.routeOptimizationRunsRepository.create({
      zoneId,
      strategyName: plan.strategyName,
      deliveryIds: plan.orderedStops.map((stop) => stop.deliveryId),
    });

    const deliveryRun = await this.deliveryRunsRepository.create({
      zoneId,
      stops: plan.orderedStops.map((stop, index) => ({
        deliveryId: stop.deliveryId,
        sequence: index + 1,
      })),
    });

    return {
      strategyName: plan.strategyName,
      orderedStops: plan.orderedStops,
      routeOptimizationRunId: routeOptimizationRun.id,
      deliveryRunId: deliveryRun.id,
    };
  }
}
