import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { RoleName, TemperatureDevice, Vendor } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { TemperatureDevicesRepository } from '../repositories/temperature-devices.repository';
import { TemperatureDevicesService } from './temperature-devices.service';

function buildVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'vendor-1',
    userId: 'vendor-user-1',
    businessName: "Vera's Catch",
    description: null,
    phone: null,
    parish: 'KINGSTON',
    logoUrl: null,
    status: 'APPROVED',
    tier: 'COMMUNITY_FISHER',
    complianceScore: null,
    termsAcceptedAt: new Date(),
    primaryZoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildDevice(overrides: Partial<TemperatureDevice> = {}): TemperatureDevice {
  return {
    id: 'device-1',
    vendorId: 'vendor-1',
    deviceCode: 'DEV-001',
    status: 'ACTIVE',
    lastSeenAt: new Date(),
    lastCalibratedAt: null,
    calibrationDueAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('TemperatureDevicesService', () => {
  let devicesRepository: jest.Mocked<
    Pick<TemperatureDevicesRepository, 'create' | 'findById' | 'findByDeviceCode' | 'findMany' | 'calibrate'>
  >;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findByUserId'>>;
  let service: TemperatureDevicesService;

  beforeEach(() => {
    devicesRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      findByDeviceCode: jest.fn(),
      findMany: jest.fn(),
      calibrate: jest.fn(),
    };
    vendorsRepository = { findByUserId: jest.fn() };
    service = new TemperatureDevicesService(
      devicesRepository as unknown as TemperatureDevicesRepository,
      vendorsRepository as unknown as VendorsRepository,
    );
  });

  describe('register', () => {
    it('rejects a duplicate deviceCode', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      devicesRepository.findByDeviceCode.mockResolvedValue(buildDevice());

      await expect(
        service.register('vendor-user-1', { deviceCode: 'DEV-001' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('registers a device for an approved vendor', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      devicesRepository.findByDeviceCode.mockResolvedValue(null);
      devicesRepository.create.mockResolvedValue(buildDevice());

      const result = await service.register('vendor-user-1', { deviceCode: 'DEV-001' });

      expect(result.id).toBe('device-1');
      expect(result.isCalibrationOverdue).toBe(false);
    });
  });

  describe('list', () => {
    it('flags isOffline when lastSeenAt is stale', async () => {
      devicesRepository.findMany.mockResolvedValue([
        buildDevice({ lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }),
      ]);

      const result = await service.list();

      expect(result[0]?.isOffline).toBe(true);
    });
  });

  describe('calibrate', () => {
    const adminUser: RequestUser = {
      id: 'admin-1',
      email: 'admin@example.com',
      roles: [RoleName.ADMINISTRATOR],
    };
    const vendorUser: RequestUser = {
      id: 'vendor-user-1',
      email: 'vendor@example.com',
      roles: [RoleName.VENDOR],
    };

    it('throws when the device does not exist', async () => {
      devicesRepository.findById.mockResolvedValue(null);
      await expect(service.calibrate(adminUser, 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('allows an admin to calibrate any device without an ownership check', async () => {
      devicesRepository.findById.mockResolvedValue(buildDevice());
      devicesRepository.calibrate.mockResolvedValue(
        buildDevice({ lastCalibratedAt: new Date(), calibrationDueAt: new Date(Date.now() + 1000) }),
      );

      const result = await service.calibrate(adminUser, 'device-1');

      expect(result.lastCalibratedAt).not.toBeNull();
      expect(vendorsRepository.findByUserId).not.toHaveBeenCalled();
    });

    it('allows the owning vendor to calibrate their own device', async () => {
      devicesRepository.findById.mockResolvedValue(buildDevice({ vendorId: 'vendor-1' }));
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor({ id: 'vendor-1' }));
      devicesRepository.calibrate.mockResolvedValue(buildDevice());

      await service.calibrate(vendorUser, 'device-1');

      expect(devicesRepository.calibrate).toHaveBeenCalledWith(
        'device-1',
        expect.any(Date),
        expect.any(Date),
      );
    });

    it('rejects a vendor calibrating a device they do not own', async () => {
      devicesRepository.findById.mockResolvedValue(buildDevice({ vendorId: 'someone-elses-vendor' }));
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor({ id: 'vendor-1' }));

      await expect(service.calibrate(vendorUser, 'device-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('sets calibrationDueAt 90 days after lastCalibratedAt', async () => {
      devicesRepository.findById.mockResolvedValue(buildDevice());
      devicesRepository.calibrate.mockImplementation((id, calibratedAt, dueAt) =>
        Promise.resolve(buildDevice({ lastCalibratedAt: calibratedAt, calibrationDueAt: dueAt })),
      );

      await service.calibrate(adminUser, 'device-1');

      const [, calibratedAt, dueAt] = devicesRepository.calibrate.mock.calls[0] as [string, Date, Date];
      expect(dueAt.getTime() - calibratedAt.getTime()).toBe(90 * 24 * 60 * 60 * 1000);
    });
  });
});
