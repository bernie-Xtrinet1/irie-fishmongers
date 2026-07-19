import { RoutePlanResponseEntity } from '../entities/route-plan-response.entity';
import { RouteOptimizationService } from '../services/route-optimization.service';
import { RouteOptimizationController } from './route-optimization.controller';

const plan: RoutePlanResponseEntity = {
  strategyName: 'single-stop-parish-clustered',
  orderedStops: [
    {
      deliveryId: 'delivery-1',
      vendorOrderId: 'vo-1',
      zoneId: 'zone-1',
      vendorId: 'vendor-1',
      deliveryParish: 'KINGSTON',
    },
  ],
  routeOptimizationRunId: 'run-1',
  deliveryRunId: 'delivery-run-1',
};

describe('RouteOptimizationController', () => {
  let routeOptimizationService: jest.Mocked<Pick<RouteOptimizationService, 'optimizeRoute'>>;
  let controller: RouteOptimizationController;

  beforeEach(() => {
    routeOptimizationService = { optimizeRoute: jest.fn().mockResolvedValue(plan) };
    controller = new RouteOptimizationController(
      routeOptimizationService as unknown as RouteOptimizationService,
    );
  });

  it('optimizes a route for a zone', async () => {
    await expect(controller.optimizeRoute('zone-1')).resolves.toEqual(plan);
    expect(routeOptimizationService.optimizeRoute).toHaveBeenCalledWith('zone-1');
  });
});
