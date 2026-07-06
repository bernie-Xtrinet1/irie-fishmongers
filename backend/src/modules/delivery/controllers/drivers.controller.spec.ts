import { DriverResponseEntity } from '../entities/driver-response.entity';
import { DriversService } from '../services/drivers.service';
import { DriversController } from './drivers.controller';

const driver: DriverResponseEntity = {
  id: 'driver-1',
  userId: 'user-1',
  licensePlate: 'AB 1234',
  vehicleType: 'CAR',
  status: 'PENDING',
  createdAt: new Date(),
};

const user = { id: 'user-1', email: 'a@b.com', roles: ['DRIVER' as const] };

describe('DriversController', () => {
  let driversService: jest.Mocked<
    Pick<DriversService, 'register' | 'getOwnProfile' | 'recordLocation' | 'list' | 'updateStatus'>
  >;
  let controller: DriversController;

  beforeEach(() => {
    driversService = {
      register: jest.fn().mockResolvedValue(driver),
      getOwnProfile: jest.fn().mockResolvedValue(driver),
      recordLocation: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue({ items: [driver], total: 1, page: 1, pageSize: 20 }),
      updateStatus: jest.fn().mockResolvedValue({ ...driver, status: 'APPROVED' }),
    };
    controller = new DriversController(driversService as unknown as DriversService);
  });

  it('registers a driver profile', async () => {
    const dto = { licensePlate: 'AB 1234', vehicleType: 'CAR' as const };
    await expect(controller.register(user, dto)).resolves.toEqual(driver);
    expect(driversService.register).toHaveBeenCalledWith('user-1', dto);
  });

  it("gets the authenticated driver's own profile", async () => {
    await expect(controller.getOwnProfile(user)).resolves.toEqual(driver);
  });

  it('records a GPS location', async () => {
    const dto = { latitude: 17.9714, longitude: -76.7931 };
    await controller.recordLocation(user, dto);
    expect(driversService.recordLocation).toHaveBeenCalledWith('user-1', 17.9714, -76.7931);
  });

  it('lists drivers', async () => {
    const result = await controller.list({ page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
  });

  it('updates a driver status', async () => {
    const result = await controller.updateStatus('driver-1', { status: 'APPROVED' });
    expect(result.status).toBe('APPROVED');
    expect(driversService.updateStatus).toHaveBeenCalledWith('driver-1', 'APPROVED');
  });
});
