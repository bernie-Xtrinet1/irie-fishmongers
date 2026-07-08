import { Injectable } from '@nestjs/common';

import {
  RouteOptimizationStrategy,
  RoutePlan,
  RouteStop,
} from './route-optimization-strategy.interface';

/**
 * Honest no-op default: preserves input order rather than fabricating an
 * optimization the platform doesn't yet compute. Swap the
 * ROUTE_OPTIMIZATION_STRATEGY provider in DeliveryModule for a real
 * algorithm when one exists.
 */
@Injectable()
export class SingleStopRouteOptimizationStrategy implements RouteOptimizationStrategy {
  planRoute(stops: RouteStop[]): RoutePlan {
    return { strategyName: 'single-stop-default', orderedStops: stops };
  }
}
