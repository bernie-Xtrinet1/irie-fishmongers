import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Driver } from '@prisma/client';

import { DeliveryRunsRepository, DeliveryRunWithStops } from '../repositories/delivery-runs.repository';
import { DriversRepository } from '../repositories/drivers.repository';
import { DeliveryRunsService } from './delivery-runs.service';

function buildDriver(overrides: Partial<Driver> = {}): Driver {
  return {
    id: 'driver-1',
    userId: 'driver-user-1',
    licensePlate: 'AB 1234',
    vehicleType: 'CAR',
    vehicleOwnership: 'PERSONAL_VEHICLE',
    status: 'APPROVED',
    availabilityStatus: 'ONLINE',
    capacityLbs: null,
    coldChainCapable: false,
    assignedZoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildRun(overrides: Partial<DeliveryRunWithStops> = {}): DeliveryRunWithStops {
  return {
    id: 'delivery-run-1',
    zoneId: 'zone-1',
    driverId: null,
    fleetAssetId: null,
    status: 'PLANNED',
    createdAt: new Date(),
    updatedAt: new Date(),
    stops: [{ id: 'stop-1', deliveryRunId: 'delivery-run-1', deliveryId: 'delivery-1', sequence: 1 }],
    ...overrides,
  };
}

describe('DeliveryRunsService', () => {
  let deliveryRunsRepository: jest.Mocked<Pick<DeliveryRunsRepository, 'findById' | 'assign'>>;
  let driversRepository: jest.Mocked<Pick<DriversRepository, 'findById'>>;
  let service: DeliveryRunsService;

  beforeEach(() => {
    deliveryRunsRepository = { findById: jest.fn(), assign: jest.fn() };
    driversRepository = { findById: jest.fn() };
    service = new DeliveryRunsService(
      deliveryRunsRepository as unknown as DeliveryRunsRepository,
      driversRepository as unknown as DriversRepository,
    );
  });

  describe('getById', () => {
    it('returns a delivery run with its ordered stops', async () => {
      deliveryRunsRepository.findById.mockResolvedValue(buildRun());
      const result = await service.getById('delivery-run-1');
      expect(result.stops).toHaveLength(1);
    });

    it('throws when the run does not exist', async () => {
      deliveryRunsRepository.findById.mockResolvedValue(null);
      await expect(service.getById('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('assign', () => {
    it('assigns a driver to a planned run and transitions it to IN_PROGRESS', async () => {
      deliveryRunsRepository.findById.mockResolvedValue(buildRun());
      driversRepository.findById.mockResolvedValue(buildDriver());
      deliveryRunsRepository.assign.mockResolvedValue(
        buildRun({ driverId: 'driver-1', status: 'IN_PROGRESS' }),
      );

      const result = await service.assign('delivery-run-1', { driverId: 'driver-1' });

      expect(result.status).toBe('IN_PROGRESS');
      expect(result.driverId).toBe('driver-1');
      expect(deliveryRunsRepository.assign).toHaveBeenCalledWith('delivery-run-1', {
        driverId: 'driver-1',
      });
    });

    it('rejects assigning a run that is not PLANNED', async () => {
      deliveryRunsRepository.findById.mockResolvedValue(buildRun({ status: 'IN_PROGRESS' }));
      await expect(
        service.assign('delivery-run-1', { driverId: 'driver-1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(deliveryRunsRepository.assign).not.toHaveBeenCalled();
    });

    it('throws when the driver does not exist', async () => {
      deliveryRunsRepository.findById.mockResolvedValue(buildRun());
      driversRepository.findById.mockResolvedValue(null);
      await expect(
        service.assign('delivery-run-1', { driverId: 'missing' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(deliveryRunsRepository.assign).not.toHaveBeenCalled();
    });

    it('throws when the run does not exist', async () => {
      deliveryRunsRepository.findById.mockResolvedValue(null);
      await expect(
        service.assign('missing', { driverId: 'driver-1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
