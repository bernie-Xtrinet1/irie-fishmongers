import { RouteStop } from './route-optimization-strategy.interface';
import { SingleStopRouteOptimizationStrategy } from './single-stop-route-optimization.strategy';

describe('SingleStopRouteOptimizationStrategy', () => {
  it('preserves the input order and returns the default strategy name', () => {
    const strategy = new SingleStopRouteOptimizationStrategy();
    const stops: RouteStop[] = [
      { deliveryId: 'delivery-1', vendorOrderId: 'vo-1', zoneId: 'zone-1' },
      { deliveryId: 'delivery-2', vendorOrderId: 'vo-2', zoneId: 'zone-1' },
    ];

    const plan = strategy.planRoute(stops);

    expect(plan.strategyName).toBe('single-stop-default');
    expect(plan.orderedStops).toEqual(stops);
  });

  it('returns an empty plan for no stops', () => {
    const strategy = new SingleStopRouteOptimizationStrategy();
    const plan = strategy.planRoute([]);
    expect(plan.orderedStops).toEqual([]);
  });
});
