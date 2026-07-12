import { Injectable } from '@nestjs/common';

import {
  RouteOptimizationStrategy,
  RoutePlan,
  RouteStop,
} from './route-optimization-strategy.interface';

/**
 * Real ordering heuristic, not a distance-minimizing haversine solver:
 * no Vendor/Order/Customer latitude/longitude exists anywhere in this
 * schema (confirmed - the only coordinates on record are DriverLocation
 * GPS pings and food-safety catch/landing-site/reading locations, none of
 * which represent a pickup or dropoff point). Building real distance
 * scoring would require adding geocoding infrastructure, which is out of
 * scope for this pass (same "zone-match substitutes for distance" scope
 * decision the 10A Fleet Dispatch Engine already made and documented).
 *
 * What IS real and available: every stop already carries which Parish its
 * delivery address falls in and which vendor it picks up from. Grouping
 * stops by parish first (so the driver finishes one geographic cluster
 * before moving to the next, rather than zig-zagging across the zone
 * stop-by-stop) and by vendor second (so consecutive same-vendor pickups
 * aren't split apart) is a genuine, deterministic routing improvement
 * over "whatever order deliveries were assigned in" - it just isn't
 * distance-optimal in the haversine sense.
 */
@Injectable()
export class ParishClusteringRouteOptimizationStrategy implements RouteOptimizationStrategy {
  planRoute(stops: RouteStop[]): RoutePlan {
    const orderedStops = [...stops].sort((a, b) => {
      if (a.deliveryParish !== b.deliveryParish) {
        return a.deliveryParish.localeCompare(b.deliveryParish);
      }
      if (a.vendorId !== b.vendorId) {
        return a.vendorId.localeCompare(b.vendorId);
      }
      return a.deliveryId.localeCompare(b.deliveryId);
    });

    return { strategyName: 'single-stop-parish-clustered', orderedStops };
  }
}
