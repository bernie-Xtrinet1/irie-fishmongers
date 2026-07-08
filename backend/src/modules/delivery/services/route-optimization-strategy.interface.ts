export interface RouteStop {
  deliveryId: string;
  vendorOrderId: string;
  zoneId: string;
}

export interface RoutePlan {
  strategyName: string;
  orderedStops: RouteStop[];
}

export const ROUTE_OPTIMIZATION_STRATEGY = Symbol('ROUTE_OPTIMIZATION_STRATEGY');

/**
 * DI extension point: swap the provider bound to ROUTE_OPTIMIZATION_STRATEGY
 * for a real routing algorithm later without touching RouteOptimizationService.
 */
export interface RouteOptimizationStrategy {
  planRoute(stops: RouteStop[]): RoutePlan;
}
