import { FleetAssetResponseEntity } from '../entities/fleet-asset-response.entity';
import { FleetMaintenanceResponseEntity } from '../entities/fleet-maintenance-response.entity';
import { FleetAssetsService } from '../services/fleet-assets.service';
import { FleetMaintenanceService } from '../services/fleet-maintenance.service';
import { FleetAssetsController } from './fleet-assets.controller';

const asset: FleetAssetResponseEntity = {
  id: 'asset-1',
  zoneId: 'zone-1',
  assetType: 'TRUCK',
  ownership: 'COMPANY_OWNED',
  licensePlate: 'FL 1234',
  capacityLbs: { toString: () => '2000' } as unknown as FleetAssetResponseEntity['capacityLbs'],
  coldChainCapable: false,
  status: 'ACTIVE',
  currentDriverId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const maintenance: FleetMaintenanceResponseEntity = {
  id: 'maintenance-1',
  fleetAssetId: 'asset-1',
  serviceDate: new Date(),
  mileage: null,
  technician: null,
  cost: null,
  nextServiceDue: null,
  status: 'SCHEDULED',
  notes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('FleetAssetsController', () => {
  let fleetAssetsService: jest.Mocked<
    Pick<FleetAssetsService, 'create' | 'list' | 'findById' | 'update' | 'getZoneSummary'>
  >;
  let fleetMaintenanceService: jest.Mocked<Pick<FleetMaintenanceService, 'create' | 'findByFleetAssetId'>>;
  let controller: FleetAssetsController;

  beforeEach(() => {
    fleetAssetsService = {
      create: jest.fn().mockResolvedValue(asset),
      list: jest.fn().mockResolvedValue({ items: [asset], total: 1, page: 1, pageSize: 20 }),
      findById: jest.fn().mockResolvedValue(asset),
      update: jest.fn().mockResolvedValue({ ...asset, status: 'RETIRED' }),
      getZoneSummary: jest
        .fn()
        .mockResolvedValue([{ zoneId: 'zone-1', status: 'ACTIVE', count: 3 }]),
    };
    fleetMaintenanceService = {
      create: jest.fn().mockResolvedValue(maintenance),
      findByFleetAssetId: jest.fn().mockResolvedValue({
        items: [maintenance],
        total: 1,
        page: 1,
        pageSize: 20,
      }),
    };
    controller = new FleetAssetsController(
      fleetAssetsService as unknown as FleetAssetsService,
      fleetMaintenanceService as unknown as FleetMaintenanceService,
    );
  });

  it('creates a fleet asset', async () => {
    const dto = {
      zoneId: 'zone-1',
      assetType: 'TRUCK' as const,
      ownership: 'COMPANY_OWNED' as const,
      licensePlate: 'FL 1234',
      capacityLbs: 2000,
    };
    await expect(controller.create(dto)).resolves.toEqual(asset);
    expect(fleetAssetsService.create).toHaveBeenCalledWith(dto);
  });

  it('lists fleet assets', async () => {
    const result = await controller.list({ page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
  });

  it('gets a fleet asset by id', async () => {
    await expect(controller.findById('asset-1')).resolves.toEqual(asset);
  });

  it('updates a fleet asset', async () => {
    const result = await controller.update('asset-1', { status: 'RETIRED' });
    expect(result.status).toBe('RETIRED');
  });

  it('creates a maintenance record for a fleet asset', async () => {
    const dto = { serviceDate: '2026-07-08T00:00:00.000Z' };
    await expect(controller.createMaintenance('asset-1', dto)).resolves.toEqual(maintenance);
    expect(fleetMaintenanceService.create).toHaveBeenCalledWith('asset-1', dto);
  });

  it('lists maintenance records for a fleet asset', async () => {
    const result = await controller.listMaintenance('asset-1', { page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
  });

  it('gets the fleet zone summary rollup', async () => {
    const result = await controller.getZoneSummary();
    expect(result).toEqual([{ zoneId: 'zone-1', status: 'ACTIVE', count: 3 }]);
  });
});
