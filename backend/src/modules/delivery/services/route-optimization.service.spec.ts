import { NotFoundException } from '@nestjs/common';
import { DeliveryZone } from '@prisma/client';

import { DeliveriesRepository, DeliveryWithDetails } from '../repositories/deliveries.repository';
import { DeliveryRunsRepository, DeliveryRunWithStops } from '../repositories/delivery-runs.repository';
import { DeliveryZonesRepository } from '../repositories/delivery-zones.repository';
import { RouteOptimizationRunsRepository } from '../repositories/route-optimization-runs.repository';
import { RouteOptimizationStrategy } from './route-optimization-strategy.interface';
import { RouteOptimizationService } from './route-optimization.service';

function buildZone(overrides: Partial<DeliveryZone> = {}): DeliveryZone {
  return {
    id: 'zone-1',
    name: 'Zone 1',
    code: 'ZONE_1',
    description: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('RouteOptimizationService', () => {
  let deliveryZonesRepository: jest.Mocked<Pick<DeliveryZonesRepository, 'findById'>>;
  let deliveriesRepository: jest.Mocked<Pick<DeliveriesRepository, 'findScheduledForZone'>>;
  let routeOptimizationRunsRepository: jest.Mocked<Pick<RouteOptimizationRunsRepository, 'create'>>;
  let deliveryRunsRepository: jest.Mocked<Pick<DeliveryRunsRepository, 'create'>>;
  let strategy: jest.Mocked<Pick<RouteOptimizationStrategy, 'planRoute'>>;
  let service: RouteOptimizationService;

  beforeEach(() => {
    deliveryZonesRepository = { findById: jest.fn() };
    deliveriesRepository = { findScheduledForZone: jest.fn() };
    routeOptimizationRunsRepository = { create: jest.fn() };
    deliveryRunsRepository = { create: jest.fn() };
    strategy = { planRoute: jest.fn() };
    service = new RouteOptimizationService(
      deliveryZonesRepository as unknown as DeliveryZonesRepository,
      deliveriesRepository as unknown as DeliveriesRepository,
      routeOptimizationRunsRepository as unknown as RouteOptimizationRunsRepository,
      deliveryRunsRepository as unknown as DeliveryRunsRepository,
      strategy,
    );
  });

  it('plans a route, persists the audit run, and persists a DeliveryRun with ordered stops', async () => {
    deliveryZonesRepository.findById.mockResolvedValue(buildZone());
    deliveriesRepository.findScheduledForZone.mockResolvedValue([
      { id: 'delivery-1', vendorOrderId: 'vo-1' } as DeliveryWithDetails,
      { id: 'delivery-2', vendorOrderId: 'vo-2' } as DeliveryWithDetails,
    ]);
    strategy.planRoute.mockReturnValue({
      strategyName: 'single-stop-default',
      orderedStops: [
        { deliveryId: 'delivery-1', vendorOrderId: 'vo-1', zoneId: 'zone-1' },
        { deliveryId: 'delivery-2', vendorOrderId: 'vo-2', zoneId: 'zone-1' },
      ],
    });
    routeOptimizationRunsRepository.create.mockResolvedValue({
      id: 'run-1',
      zoneId: 'zone-1',
      strategyName: 'single-stop-default',
      deliveryIds: ['delivery-1', 'delivery-2'],
      decidedAt: new Date(),
    });
    deliveryRunsRepository.create.mockResolvedValue({
      id: 'delivery-run-1',
      zoneId: 'zone-1',
      driverId: null,
      fleetAssetId: null,
      status: 'PLANNED',
      createdAt: new Date(),
      updatedAt: new Date(),
      stops: [],
    } as unknown as DeliveryRunWithStops);

    const result = await service.optimizeRoute('zone-1');

    expect(strategy.planRoute).toHaveBeenCalledWith([
      { deliveryId: 'delivery-1', vendorOrderId: 'vo-1', zoneId: 'zone-1' },
      { deliveryId: 'delivery-2', vendorOrderId: 'vo-2', zoneId: 'zone-1' },
    ]);
    expect(routeOptimizationRunsRepository.create).toHaveBeenCalledWith({
      zoneId: 'zone-1',
      strategyName: 'single-stop-default',
      deliveryIds: ['delivery-1', 'delivery-2'],
    });
    expect(deliveryRunsRepository.create).toHaveBeenCalledWith({
      zoneId: 'zone-1',
      stops: [
        { deliveryId: 'delivery-1', sequence: 1 },
        { deliveryId: 'delivery-2', sequence: 2 },
      ],
    });
    expect(result.routeOptimizationRunId).toBe('run-1');
    expect(result.deliveryRunId).toBe('delivery-run-1');
  });

  it('throws when the zone does not exist', async () => {
    deliveryZonesRepository.findById.mockResolvedValue(null);
    await expect(service.optimizeRoute('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(deliveriesRepository.findScheduledForZone).not.toHaveBeenCalled();
  });
});
