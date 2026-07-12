import { DeliveryRunResponseEntity } from '../entities/delivery-run-response.entity';
import { DeliveryRunsService } from '../services/delivery-runs.service';
import { DeliveryRunsController } from './delivery-runs.controller';

const run: DeliveryRunResponseEntity = {
  id: 'delivery-run-1',
  zoneId: 'zone-1',
  driverId: null,
  fleetAssetId: null,
  status: 'PLANNED',
  stops: [{ id: 'stop-1', deliveryId: 'delivery-1', sequence: 1 }],
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('DeliveryRunsController', () => {
  let deliveryRunsService: jest.Mocked<Pick<DeliveryRunsService, 'getById' | 'assign' | 'list'>>;
  let controller: DeliveryRunsController;

  beforeEach(() => {
    deliveryRunsService = {
      getById: jest.fn().mockResolvedValue(run),
      assign: jest.fn().mockResolvedValue({ ...run, driverId: 'driver-1', status: 'IN_PROGRESS' }),
      list: jest.fn().mockResolvedValue({ items: [run], total: 1, page: 1, pageSize: 20 }),
    };
    controller = new DeliveryRunsController(deliveryRunsService as unknown as DeliveryRunsService);
  });

  it('lists delivery runs', async () => {
    const result = await controller.list({ page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
    expect(deliveryRunsService.list).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
  });

  it('gets a delivery run', async () => {
    await expect(controller.getById('delivery-run-1')).resolves.toEqual(run);
  });

  it('assigns a driver to a delivery run', async () => {
    const result = await controller.assign('delivery-run-1', { driverId: 'driver-1' });
    expect(result.status).toBe('IN_PROGRESS');
    expect(deliveryRunsService.assign).toHaveBeenCalledWith('delivery-run-1', {
      driverId: 'driver-1',
    });
  });
});
