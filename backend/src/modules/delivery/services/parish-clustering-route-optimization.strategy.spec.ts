import { RouteStop } from './route-optimization-strategy.interface';
import { ParishClusteringRouteOptimizationStrategy } from './parish-clustering-route-optimization.strategy';

function stop(overrides: Partial<RouteStop> = {}): RouteStop {
  return {
    deliveryId: 'delivery-1',
    vendorOrderId: 'vo-1',
    zoneId: 'zone-1',
    vendorId: 'vendor-1',
    deliveryParish: 'KINGSTON',
    ...overrides,
  };
}

describe('ParishClusteringRouteOptimizationStrategy', () => {
  const strategy = new ParishClusteringRouteOptimizationStrategy();

  it('returns an empty plan for no stops', () => {
    const plan = strategy.planRoute([]);
    expect(plan.orderedStops).toEqual([]);
    expect(plan.strategyName).toBe('single-stop-parish-clustered');
  });

  it('clusters stops by parish so the driver finishes one area before moving to the next', () => {
    const stops = [
      stop({ deliveryId: 'd-1', deliveryParish: 'ST_ANDREW' }),
      stop({ deliveryId: 'd-2', deliveryParish: 'KINGSTON' }),
      stop({ deliveryId: 'd-3', deliveryParish: 'ST_ANDREW' }),
      stop({ deliveryId: 'd-4', deliveryParish: 'KINGSTON' }),
    ];

    const plan = strategy.planRoute(stops);

    expect(plan.orderedStops.map((s) => s.deliveryParish)).toEqual([
      'KINGSTON',
      'KINGSTON',
      'ST_ANDREW',
      'ST_ANDREW',
    ]);
  });

  it('within the same parish, groups consecutive stops by vendor', () => {
    const stops = [
      stop({ deliveryId: 'd-1', vendorId: 'vendor-b' }),
      stop({ deliveryId: 'd-2', vendorId: 'vendor-a' }),
      stop({ deliveryId: 'd-3', vendorId: 'vendor-b' }),
    ];

    const plan = strategy.planRoute(stops);

    expect(plan.orderedStops.map((s) => s.vendorId)).toEqual(['vendor-a', 'vendor-b', 'vendor-b']);
  });

  it('does not mutate the input array', () => {
    const stops = [stop({ deliveryId: 'd-1', deliveryParish: 'ST_ANDREW' }), stop({ deliveryId: 'd-2', deliveryParish: 'KINGSTON' })];
    const original = [...stops];

    strategy.planRoute(stops);

    expect(stops).toEqual(original);
  });
});
