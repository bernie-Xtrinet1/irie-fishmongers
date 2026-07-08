import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Driver, DeliveryException } from '@prisma/client';

import { DeliveriesRepository, DeliveryWithDetails } from '../repositories/deliveries.repository';
import { DeliveryExceptionsRepository } from '../repositories/delivery-exceptions.repository';
import { DriversRepository } from '../repositories/drivers.repository';
import { DeliveryExceptionsService } from './delivery-exceptions.service';

function buildDriver(overrides: Partial<Driver> = {}): Driver {
  return {
    id: 'driver-1',
    userId: 'driver-user-1',
    licensePlate: 'AB 1234',
    vehicleType: 'CAR',
    vehicleOwnership: 'PERSONAL_VEHICLE',
    status: 'APPROVED',
    availabilityStatus: 'BUSY',
    capacityLbs: null,
    coldChainCapable: false,
    assignedZoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildException(overrides: Partial<DeliveryException> = {}): DeliveryException {
  return {
    id: 'exception-1',
    deliveryId: 'delivery-1',
    type: 'CUSTOMER_UNAVAILABLE',
    reason: 'Customer did not answer the door after three attempts',
    photos: [],
    notes: null,
    resolved: false,
    resolvedAt: null,
    resolvedById: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('DeliveryExceptionsService', () => {
  let exceptionsRepository: jest.Mocked<
    Pick<DeliveryExceptionsRepository, 'create' | 'findById' | 'resolve' | 'findMany'>
  >;
  let deliveriesRepository: jest.Mocked<Pick<DeliveriesRepository, 'findById'>>;
  let driversRepository: jest.Mocked<Pick<DriversRepository, 'findByUserId'>>;
  let service: DeliveryExceptionsService;

  beforeEach(() => {
    exceptionsRepository = { create: jest.fn(), findById: jest.fn(), resolve: jest.fn(), findMany: jest.fn() };
    deliveriesRepository = { findById: jest.fn() };
    driversRepository = { findByUserId: jest.fn() };
    service = new DeliveryExceptionsService(
      exceptionsRepository as unknown as DeliveryExceptionsRepository,
      deliveriesRepository as unknown as DeliveriesRepository,
      driversRepository as unknown as DriversRepository,
    );
  });

  describe('create', () => {
    const dto = {
      type: 'CUSTOMER_UNAVAILABLE' as const,
      reason: 'Customer did not answer the door after three attempts',
    };

    it('creates an exception for an owned, open delivery', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(
        { driverId: 'driver-1', deliveredAt: null, failedAt: null } as DeliveryWithDetails,
      );
      exceptionsRepository.create.mockResolvedValue(buildException());

      const result = await service.create('driver-user-1', 'delivery-1', dto);

      expect(result.id).toBe('exception-1');
      expect(exceptionsRepository.create).toHaveBeenCalledWith({
        deliveryId: 'delivery-1',
        type: 'CUSTOMER_UNAVAILABLE',
        reason: dto.reason,
        photos: [],
        notes: undefined,
      });
    });

    it('throws when the delivery does not belong to the driver', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(
        { driverId: 'someone-elses-driver', deliveredAt: null, failedAt: null } as DeliveryWithDetails,
      );

      await expect(service.create('driver-user-1', 'delivery-1', dto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects reporting an exception once the delivery is closed', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(
        { driverId: 'driver-1', deliveredAt: new Date(), failedAt: null } as DeliveryWithDetails,
      );

      await expect(service.create('driver-user-1', 'delivery-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws when the delivery does not exist', async () => {
      driversRepository.findByUserId.mockResolvedValue(buildDriver());
      deliveriesRepository.findById.mockResolvedValue(null);

      await expect(service.create('driver-user-1', 'missing', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws when no driver profile exists', async () => {
      driversRepository.findByUserId.mockResolvedValue(null);
      await expect(service.create('driver-user-1', 'delivery-1', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('resolve', () => {
    it('resolves an unresolved exception', async () => {
      exceptionsRepository.findById.mockResolvedValue(buildException());
      exceptionsRepository.resolve.mockResolvedValue(
        buildException({ resolved: true, resolvedAt: new Date(), resolvedById: 'admin-1' }),
      );

      const result = await service.resolve('exception-1', 'admin-1');

      expect(result.resolved).toBe(true);
      expect(exceptionsRepository.resolve).toHaveBeenCalledWith('exception-1', 'admin-1');
    });

    it('rejects resolving an already-resolved exception', async () => {
      exceptionsRepository.findById.mockResolvedValue(buildException({ resolved: true }));
      await expect(service.resolve('exception-1', 'admin-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws when the exception does not exist', async () => {
      exceptionsRepository.findById.mockResolvedValue(null);
      await expect(service.resolve('missing', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list', () => {
    it('paginates exceptions filtered by resolution status', async () => {
      exceptionsRepository.findMany.mockResolvedValue({ items: [buildException()], total: 1 });

      const result = await service.list({ resolved: false, page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(exceptionsRepository.findMany).toHaveBeenCalledWith(false, { skip: 0, take: 20 });
    });
  });
});
