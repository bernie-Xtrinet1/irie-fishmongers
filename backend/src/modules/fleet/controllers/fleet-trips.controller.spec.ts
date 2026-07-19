import { FleetTripResponseEntity } from '../entities/fleet-trip-response.entity';
import { FleetTripsService } from '../services/fleet-trips.service';
import { FleetTripsController } from './fleet-trips.controller';

const trip: FleetTripResponseEntity = {
  id: 'trip-1',
  fleetAssetId: 'asset-1',
  driverId: 'driver-1',
  zoneId: 'zone-1',
  startedAt: new Date(),
  endedAt: null,
  fuelCost: null,
  driverWage: null,
  maintenanceAllocation: null,
  insuranceAllocation: null,
  createdAt: new Date(),
};

describe('FleetTripsController', () => {
  let fleetTripsService: jest.Mocked<Pick<FleetTripsService, 'create' | 'list' | 'findById' | 'update'>>;
  let controller: FleetTripsController;

  beforeEach(() => {
    fleetTripsService = {
      create: jest.fn().mockResolvedValue(trip),
      list: jest.fn().mockResolvedValue({ items: [trip], total: 1, page: 1, pageSize: 20 }),
      findById: jest.fn().mockResolvedValue(trip),
      update: jest.fn().mockResolvedValue({ ...trip, endedAt: new Date() }),
    };
    controller = new FleetTripsController(fleetTripsService as unknown as FleetTripsService);
  });

  it('creates a fleet trip', async () => {
    const dto = {
      fleetAssetId: 'asset-1',
      driverId: 'driver-1',
      zoneId: 'zone-1',
      startedAt: '2026-07-08T08:00:00.000Z',
    };
    await expect(controller.create(dto)).resolves.toEqual(trip);
    expect(fleetTripsService.create).toHaveBeenCalledWith(dto);
  });

  it('lists fleet trips', async () => {
    const result = await controller.list({ page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
  });

  it('gets a fleet trip by id', async () => {
    await expect(controller.findById('trip-1')).resolves.toEqual(trip);
  });

  it('updates a fleet trip', async () => {
    const result = await controller.update('trip-1', { endedAt: '2026-07-08T09:00:00.000Z' });
    expect(result.endedAt).not.toBeNull();
  });
});
