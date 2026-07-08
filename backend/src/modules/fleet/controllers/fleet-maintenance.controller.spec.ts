import { FleetMaintenanceResponseEntity } from '../entities/fleet-maintenance-response.entity';
import { FleetMaintenanceService } from '../services/fleet-maintenance.service';
import { FleetMaintenanceController } from './fleet-maintenance.controller';

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

describe('FleetMaintenanceController', () => {
  let fleetMaintenanceService: jest.Mocked<Pick<FleetMaintenanceService, 'update'>>;
  let controller: FleetMaintenanceController;

  beforeEach(() => {
    fleetMaintenanceService = {
      update: jest.fn().mockResolvedValue({ ...maintenance, status: 'COMPLETED' }),
    };
    controller = new FleetMaintenanceController(
      fleetMaintenanceService as unknown as FleetMaintenanceService,
    );
  });

  it('updates a fleet maintenance record', async () => {
    const result = await controller.update('maintenance-1', { status: 'COMPLETED' });
    expect(result.status).toBe('COMPLETED');
    expect(fleetMaintenanceService.update).toHaveBeenCalledWith('maintenance-1', {
      status: 'COMPLETED',
    });
  });
});
