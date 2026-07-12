import { DriverColdChainCertificationResponseEntity } from '../entities/driver-cold-chain-certification-response.entity';
import { DriverPerformanceMetricsEntity } from '../entities/driver-performance-metrics.entity';
import { DriverResponseEntity } from '../entities/driver-response.entity';
import { DriverColdChainCertificationsService } from '../services/driver-cold-chain-certifications.service';
import { DriversService } from '../services/drivers.service';
import { DriversController } from './drivers.controller';

const metrics: DriverPerformanceMetricsEntity = {
  onTimeDeliveryRate: 1,
  averagePickupDelayMinutes: 10,
  customerAcceptanceRate: 1,
  failedDeliveryRate: 0,
  temperatureComplianceRate: 1,
  averageDeliveryDurationMinutes: 30,
};

const certification: DriverColdChainCertificationResponseEntity = {
  id: 'cert-1',
  driverId: 'driver-1',
  issuedBy: 'HACCP Cold Chain Handler',
  issuedAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2027-01-01T00:00:00.000Z'),
  status: 'ACTIVE',
  documentUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const driver: DriverResponseEntity = {
  id: 'driver-1',
  userId: 'user-1',
  licensePlate: 'AB 1234',
  vehicleType: 'CAR',
  status: 'PENDING',
  availabilityStatus: 'OFFLINE',
  capacityLbs: null,
  coldChainCapable: false,
  createdAt: new Date(),
};

const user = { id: 'user-1', email: 'a@b.com', roles: ['DRIVER' as const] };

describe('DriversController', () => {
  let driversService: jest.Mocked<
    Pick<
      DriversService,
      | 'register'
      | 'getOwnProfile'
      | 'recordLocation'
      | 'list'
      | 'updateStatus'
      | 'updateAvailability'
      | 'updateProfile'
      | 'getOwnPerformanceMetrics'
      | 'getPerformanceMetrics'
    >
  >;
  let driverColdChainCertificationsService: jest.Mocked<
    Pick<DriverColdChainCertificationsService, 'create' | 'findByDriverId' | 'revoke'>
  >;
  let controller: DriversController;

  beforeEach(() => {
    driversService = {
      register: jest.fn().mockResolvedValue(driver),
      getOwnProfile: jest.fn().mockResolvedValue(driver),
      recordLocation: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue({ items: [driver], total: 1, page: 1, pageSize: 20 }),
      updateStatus: jest.fn().mockResolvedValue({ ...driver, status: 'APPROVED' }),
      updateAvailability: jest.fn().mockResolvedValue({ ...driver, availabilityStatus: 'ONLINE' }),
      updateProfile: jest.fn().mockResolvedValue({ ...driver, coldChainCapable: true }),
      getOwnPerformanceMetrics: jest.fn().mockResolvedValue(metrics),
      getPerformanceMetrics: jest.fn().mockResolvedValue(metrics),
    };
    driverColdChainCertificationsService = {
      create: jest.fn().mockResolvedValue(certification),
      findByDriverId: jest
        .fn()
        .mockResolvedValue({ items: [certification], total: 1, page: 1, pageSize: 20 }),
      revoke: jest.fn().mockResolvedValue({ ...certification, status: 'REVOKED' }),
    };
    controller = new DriversController(
      driversService as unknown as DriversService,
      driverColdChainCertificationsService as unknown as DriverColdChainCertificationsService,
    );
  });

  it('registers a driver profile', async () => {
    const dto = {
      licensePlate: 'AB 1234',
      vehicleType: 'CAR' as const,
      vehicleOwnership: 'PERSONAL_VEHICLE' as const,
    };
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

  it('updates the authenticated driver availability', async () => {
    const result = await controller.updateAvailability(user, { status: 'ONLINE' });
    expect(result.availabilityStatus).toBe('ONLINE');
    expect(driversService.updateAvailability).toHaveBeenCalledWith('user-1', 'ONLINE');
  });

  it('updates the authenticated driver profile', async () => {
    const dto = { capacityLbs: 500, coldChainCapable: true };
    const result = await controller.updateProfile(user, dto);
    expect(result.coldChainCapable).toBe(true);
    expect(driversService.updateProfile).toHaveBeenCalledWith('user-1', dto);
  });

  it("returns the authenticated driver's own performance metrics", async () => {
    await expect(controller.getOwnPerformanceMetrics(user)).resolves.toEqual(metrics);
    expect(driversService.getOwnPerformanceMetrics).toHaveBeenCalledWith('user-1');
  });

  it("returns a driver's performance metrics for an admin", async () => {
    await expect(controller.getPerformanceMetrics('driver-1')).resolves.toEqual(metrics);
    expect(driversService.getPerformanceMetrics).toHaveBeenCalledWith('driver-1');
  });

  it('issues a cold-chain certification to a driver', async () => {
    const dto = {
      issuedBy: 'HACCP Cold Chain Handler',
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
    };
    await expect(controller.createColdChainCertification('driver-1', dto)).resolves.toEqual(
      certification,
    );
    expect(driverColdChainCertificationsService.create).toHaveBeenCalledWith('driver-1', dto);
  });

  it("lists a driver's cold-chain certifications", async () => {
    const result = await controller.listColdChainCertifications('driver-1', {
      page: 1,
      pageSize: 20,
    });
    expect(result.total).toBe(1);
    expect(driverColdChainCertificationsService.findByDriverId).toHaveBeenCalledWith('driver-1', {
      page: 1,
      pageSize: 20,
    });
  });

  it('revokes a cold-chain certification', async () => {
    const result = await controller.revokeColdChainCertification('cert-1');
    expect(result.status).toBe('REVOKED');
    expect(driverColdChainCertificationsService.revoke).toHaveBeenCalledWith('cert-1');
  });
});
