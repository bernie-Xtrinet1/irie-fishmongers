import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Driver } from '@prisma/client';

import { DriverLocationsRepository } from '../repositories/driver-locations.repository';
import { DriversRepository } from '../repositories/drivers.repository';
import { DriversService } from './drivers.service';

function buildDriver(overrides: Partial<Driver> = {}): Driver {
  return {
    id: 'driver-1',
    userId: 'user-1',
    licensePlate: 'AB 1234',
    vehicleType: 'CAR',
    status: 'PENDING',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('DriversService', () => {
  let driversRepository: jest.Mocked<
    Pick<DriversRepository, 'create' | 'findById' | 'findByUserId' | 'updateStatus' | 'findMany'>
  >;
  let driverLocationsRepository: jest.Mocked<Pick<DriverLocationsRepository, 'record'>>;
  let service: DriversService;

  beforeEach(() => {
    driversRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      findByUserId: jest.fn(),
      updateStatus: jest.fn(),
      findMany: jest.fn(),
    };
    driverLocationsRepository = { record: jest.fn() };
    service = new DriversService(
      driversRepository as unknown as DriversRepository,
      driverLocationsRepository as unknown as DriverLocationsRepository,
    );
  });

  describe('register', () => {
    const dto = { licensePlate: 'AB 1234', vehicleType: 'CAR' as const };

    it('creates a driver profile when none exists', async () => {
      driversRepository.findByUserId.mockResolvedValue(null);
      driversRepository.create.mockResolvedValue(buildDriver());

      const driver = await service.register('user-1', dto);

      expect(driver.status).toBe('PENDING');
      expect(driversRepository.create).toHaveBeenCalledWith({
        userId: 'user-1',
        licensePlate: 'AB 1234',
        vehicleType: 'CAR',
      });
    });

    it('rejects registration when a driver profile already exists', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      await expect(service.register('user-1', dto)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('getOwnProfile', () => {
    it('returns the driver profile when it exists', async () => {
      const driver = buildDriver();
      driversRepository.findByUserId.mockResolvedValue(driver);
      await expect(service.getOwnProfile('user-1')).resolves.toEqual(driver);
    });

    it('throws when no driver profile exists', async () => {
      driversRepository.findByUserId.mockResolvedValue(null);
      await expect(service.getOwnProfile('user-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('updates the status when the driver exists', async () => {
      driversRepository.findById.mockResolvedValue(buildDriver());
      driversRepository.updateStatus.mockResolvedValue(buildDriver({ status: 'APPROVED' }));

      const result = await service.updateStatus('driver-1', 'APPROVED');

      expect(result.status).toBe('APPROVED');
      expect(driversRepository.updateStatus).toHaveBeenCalledWith('driver-1', 'APPROVED');
    });

    it('throws when the driver does not exist', async () => {
      driversRepository.findById.mockResolvedValue(null);
      await expect(service.updateStatus('driver-1', 'APPROVED')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('list', () => {
    it('paginates drivers filtered by status', async () => {
      driversRepository.findMany.mockResolvedValue({ items: [buildDriver()], total: 1 });

      const result = await service.list({ status: 'PENDING', page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(driversRepository.findMany).toHaveBeenCalledWith('PENDING', { skip: 0, take: 20 });
    });
  });

  describe('recordLocation', () => {
    it('records a location for an approved driver', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver({ status: 'APPROVED' }));

      await service.recordLocation('user-1', 17.9714, -76.7931);

      expect(driverLocationsRepository.record).toHaveBeenCalledWith('driver-1', 17.9714, -76.7931);
    });

    it('rejects location reporting for a driver that is not approved', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver({ status: 'PENDING' }));

      await expect(service.recordLocation('user-1', 17.9714, -76.7931)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(driverLocationsRepository.record).not.toHaveBeenCalled();
    });

    it('throws when no driver profile exists', async () => {
      driversRepository.findByUserId.mockResolvedValue(null);
      await expect(service.recordLocation('user-1', 17.9714, -76.7931)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
