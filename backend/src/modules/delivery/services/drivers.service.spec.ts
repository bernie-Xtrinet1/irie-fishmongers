import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Driver } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { DeliveriesRepository, DeliveryForMetrics } from '../repositories/deliveries.repository';
import { DriverLocationsRepository } from '../repositories/driver-locations.repository';
import { DriversRepository } from '../repositories/drivers.repository';
import { DriversService } from './drivers.service';

function buildDeliveryForMetrics(
  overrides: Partial<DeliveryForMetrics> = {},
): DeliveryForMetrics {
  return {
    id: 'delivery-1',
    assignedAt: new Date('2026-07-08T09:00:00.000Z'),
    pickedUpAt: null,
    deliveredAt: null,
    failedAt: null,
    customerDeliveryWindowEnd: null,
    customerAcceptanceStatus: 'PENDING',
    routeHistory: null,
    vendorOrder: { items: [] },
    ...overrides,
  };
}

function buildDriver(overrides: Partial<Driver> = {}): Driver {
  return {
    id: 'driver-1',
    userId: 'user-1',
    licensePlate: 'AB 1234',
    vehicleType: 'CAR',
    vehicleOwnership: 'PERSONAL_VEHICLE',
    status: 'PENDING',
    availabilityStatus: 'OFFLINE',
    capacityLbs: null,
    coldChainCapable: false,
    assignedZoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('DriversService', () => {
  let driversRepository: jest.Mocked<
    Pick<
      DriversRepository,
      | 'create'
      | 'findById'
      | 'findByUserId'
      | 'updateStatus'
      | 'findMany'
      | 'updateAvailabilityStatus'
      | 'updateProfile'
    >
  >;
  let driverLocationsRepository: jest.Mocked<Pick<DriverLocationsRepository, 'record'>>;
  let deliveriesRepository: jest.Mocked<
    Pick<DeliveriesRepository, 'countActiveByDriverId' | 'findAllByDriverForMetrics'>
  >;
  let prisma: { temperatureReading: { findMany: jest.Mock } };
  let service: DriversService;

  beforeEach(() => {
    driversRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      findByUserId: jest.fn(),
      updateStatus: jest.fn(),
      findMany: jest.fn(),
      updateAvailabilityStatus: jest.fn(),
      updateProfile: jest.fn(),
    };
    driverLocationsRepository = { record: jest.fn() };
    deliveriesRepository = {
      countActiveByDriverId: jest.fn(),
      findAllByDriverForMetrics: jest.fn().mockResolvedValue([]),
    };
    prisma = { temperatureReading: { findMany: jest.fn().mockResolvedValue([]) } };
    service = new DriversService(
      driversRepository as unknown as DriversRepository,
      driverLocationsRepository as unknown as DriverLocationsRepository,
      deliveriesRepository as unknown as DeliveriesRepository,
      prisma as unknown as PrismaService,
    );
  });

  describe('register', () => {
    const dto = {
      licensePlate: 'AB 1234',
      vehicleType: 'CAR' as const,
      vehicleOwnership: 'PERSONAL_VEHICLE' as const,
    };

    it('creates a driver profile when none exists', async () => {
      driversRepository.findByUserId.mockResolvedValue(null);
      driversRepository.create.mockResolvedValue(buildDriver());

      const driver = await service.register('user-1', dto);

      expect(driver.status).toBe('PENDING');
      expect(driversRepository.create).toHaveBeenCalledWith({
        userId: 'user-1',
        licensePlate: 'AB 1234',
        vehicleType: 'CAR',
        vehicleOwnership: 'PERSONAL_VEHICLE',
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

  describe('updateAvailability', () => {
    it('goes online when approved and idle', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver({ status: 'APPROVED' }));
      deliveriesRepository.countActiveByDriverId.mockResolvedValue(0);
      driversRepository.updateAvailabilityStatus.mockResolvedValue(
        buildDriver({ status: 'APPROVED', availabilityStatus: 'ONLINE' }),
      );

      const result = await service.updateAvailability('user-1', 'ONLINE');

      expect(result.availabilityStatus).toBe('ONLINE');
      expect(driversRepository.updateAvailabilityStatus).toHaveBeenCalledWith('driver-1', 'ONLINE');
    });

    it('goes offline when idle', async () => {
      driversRepository.findByUserId.mockResolvedValue(
        buildDriver({ status: 'APPROVED', availabilityStatus: 'ONLINE' }),
      );
      deliveriesRepository.countActiveByDriverId.mockResolvedValue(0);
      driversRepository.updateAvailabilityStatus.mockResolvedValue(buildDriver({ status: 'APPROVED' }));

      await service.updateAvailability('user-1', 'OFFLINE');

      expect(driversRepository.updateAvailabilityStatus).toHaveBeenCalledWith('driver-1', 'OFFLINE');
    });

    it('rejects a manual availability change while an active delivery is in progress', async () => {
      driversRepository.findByUserId.mockResolvedValue(
        buildDriver({ status: 'APPROVED', availabilityStatus: 'BUSY' }),
      );
      deliveriesRepository.countActiveByDriverId.mockResolvedValue(1);

      await expect(service.updateAvailability('user-1', 'OFFLINE')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(driversRepository.updateAvailabilityStatus).not.toHaveBeenCalled();
    });

    it('rejects availability updates for a driver that is not approved', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver({ status: 'PENDING' }));

      await expect(service.updateAvailability('user-1', 'ONLINE')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws when no driver profile exists', async () => {
      driversRepository.findByUserId.mockResolvedValue(null);
      await expect(service.updateAvailability('user-1', 'ONLINE')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('updateProfile', () => {
    it('updates capacity and cold-chain capability for the own driver profile', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      driversRepository.updateProfile.mockResolvedValue(
        buildDriver({ coldChainCapable: true }),
      );

      const dto = { capacityLbs: 500, coldChainCapable: true };
      const result = await service.updateProfile('user-1', dto);

      expect(result.coldChainCapable).toBe(true);
      expect(driversRepository.updateProfile).toHaveBeenCalledWith('driver-1', dto);
    });

    it('throws when no driver profile exists', async () => {
      driversRepository.findByUserId.mockResolvedValue(null);
      await expect(
        service.updateProfile('user-1', { coldChainCapable: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(driversRepository.updateProfile).not.toHaveBeenCalled();
    });
  });

  describe('getPerformanceMetrics', () => {
    it('returns all-null metrics when the driver has no deliveries', async () => {
      driversRepository.findById.mockResolvedValue(buildDriver());
      deliveriesRepository.findAllByDriverForMetrics.mockResolvedValue([]);

      const result = await service.getPerformanceMetrics('driver-1');

      expect(result).toEqual({
        onTimeDeliveryRate: null,
        averagePickupDelayMinutes: null,
        customerAcceptanceRate: null,
        failedDeliveryRate: null,
        temperatureComplianceRate: null,
        averageDeliveryDurationMinutes: null,
      });
      expect(prisma.temperatureReading.findMany).not.toHaveBeenCalled();
    });

    it('computes metrics from a mix of delivered, failed, and cold-chain-tracked deliveries', async () => {
      driversRepository.findById.mockResolvedValue(buildDriver());

      const onTimeDelivery = buildDeliveryForMetrics({
        id: 'delivery-1',
        assignedAt: new Date('2026-07-08T09:00:00.000Z'),
        pickedUpAt: new Date('2026-07-08T09:10:00.000Z'),
        deliveredAt: new Date('2026-07-08T09:40:00.000Z'),
        customerDeliveryWindowEnd: new Date('2026-07-08T09:50:00.000Z'),
        customerAcceptanceStatus: 'ACCEPTED',
        routeHistory: { durationMinutes: 30 },
        vendorOrder: { items: [{ product: { lotId: 'lot-1' } }] },
      });
      const failedDelivery = buildDeliveryForMetrics({
        id: 'delivery-2',
        assignedAt: new Date('2026-07-08T10:00:00.000Z'),
        failedAt: new Date('2026-07-08T10:20:00.000Z'),
        vendorOrder: { items: [{ product: { lotId: null } }] },
      });
      deliveriesRepository.findAllByDriverForMetrics.mockResolvedValue([
        onTimeDelivery,
        failedDelivery,
      ]);
      prisma.temperatureReading.findMany.mockResolvedValue([
        { lotId: 'lot-1', recordedAt: new Date('2026-07-08T09:15:00.000Z'), alert: null },
      ]);

      const result = await service.getPerformanceMetrics('driver-1');

      expect(result.onTimeDeliveryRate).toBe(1);
      expect(result.averagePickupDelayMinutes).toBe(10);
      expect(result.customerAcceptanceRate).toBe(1);
      expect(result.failedDeliveryRate).toBe(0.5);
      expect(result.averageDeliveryDurationMinutes).toBe(30);
      expect(result.temperatureComplianceRate).toBe(1);
      expect(prisma.temperatureReading.findMany).toHaveBeenCalledWith({
        where: {
          recordedById: 'user-1',
          checkpoint: {
            in: ['DRIVER_PICKUP', 'IN_TRANSIT', 'DELIVERY', 'VEHICLE_LOADING', 'CUSTOMER_ACCEPTANCE'],
          },
          lotId: { in: ['lot-1'] },
        },
        select: { lotId: true, recordedAt: true, alert: { select: { id: true } } },
      });
    });

    it('marks temperature compliance as non-compliant when a matched reading triggered an alert', async () => {
      driversRepository.findById.mockResolvedValue(buildDriver());
      deliveriesRepository.findAllByDriverForMetrics.mockResolvedValue([
        buildDeliveryForMetrics({
          assignedAt: new Date('2026-07-08T09:00:00.000Z'),
          deliveredAt: new Date('2026-07-08T09:40:00.000Z'),
          vendorOrder: { items: [{ product: { lotId: 'lot-1' } }] },
        }),
      ]);
      prisma.temperatureReading.findMany.mockResolvedValue([
        { lotId: 'lot-1', recordedAt: new Date('2026-07-08T09:15:00.000Z'), alert: { id: 'alert-1' } },
      ]);

      const result = await service.getPerformanceMetrics('driver-1');
      expect(result.temperatureComplianceRate).toBe(0);
    });

    it('throws when the driver does not exist', async () => {
      driversRepository.findById.mockResolvedValue(null);
      await expect(service.getPerformanceMetrics('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('getOwnPerformanceMetrics', () => {
    it("resolves the caller's own driver profile before computing metrics", async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      driversRepository.findById.mockResolvedValue(buildDriver());
      deliveriesRepository.findAllByDriverForMetrics.mockResolvedValue([]);

      const result = await service.getOwnPerformanceMetrics('user-1');

      expect(result.onTimeDeliveryRate).toBeNull();
      expect(deliveriesRepository.findAllByDriverForMetrics).toHaveBeenCalledWith('driver-1');
    });
  });
});
