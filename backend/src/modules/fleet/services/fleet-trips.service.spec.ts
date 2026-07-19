import { NotFoundException } from '@nestjs/common';
import { FleetAsset, FleetTrip } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { FleetAssetsRepository } from '../repositories/fleet-assets.repository';
import { FleetTripsRepository } from '../repositories/fleet-trips.repository';
import { FleetTripsService } from './fleet-trips.service';

function buildAsset(overrides: Partial<FleetAsset> = {}): FleetAsset {
  return {
    id: 'asset-1',
    zoneId: 'zone-1',
    assetType: 'TRUCK',
    ownership: 'COMPANY_OWNED',
    licensePlate: 'FL 1234',
    capacityLbs: { toNumber: () => 2000 } as FleetAsset['capacityLbs'],
    coldChainCapable: false,
    status: 'ACTIVE',
    currentDriverId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildTrip(overrides: Partial<FleetTrip> = {}): FleetTrip {
  return {
    id: 'trip-1',
    fleetAssetId: 'asset-1',
    driverId: 'driver-1',
    zoneId: 'zone-1',
    startedAt: new Date('2026-07-08T08:00:00.000Z'),
    endedAt: null,
    fuelCost: null,
    driverWage: null,
    maintenanceAllocation: null,
    insuranceAllocation: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('FleetTripsService', () => {
  let fleetTripsRepository: jest.Mocked<
    Pick<FleetTripsRepository, 'create' | 'findById' | 'update' | 'findMany'>
  >;
  let fleetAssetsRepository: jest.Mocked<Pick<FleetAssetsRepository, 'findById'>>;
  let prisma: { driver: { findUnique: jest.Mock }; deliveryZone: { findUnique: jest.Mock } };
  let service: FleetTripsService;

  beforeEach(() => {
    fleetTripsRepository = { create: jest.fn(), findById: jest.fn(), update: jest.fn(), findMany: jest.fn() };
    fleetAssetsRepository = { findById: jest.fn() };
    prisma = {
      driver: { findUnique: jest.fn() },
      deliveryZone: { findUnique: jest.fn() },
    };
    service = new FleetTripsService(
      fleetTripsRepository as unknown as FleetTripsRepository,
      fleetAssetsRepository as unknown as FleetAssetsRepository,
      prisma as unknown as PrismaService,
    );
  });

  describe('create', () => {
    const dto = {
      fleetAssetId: 'asset-1',
      driverId: 'driver-1',
      zoneId: 'zone-1',
      startedAt: '2026-07-08T08:00:00.000Z',
    };

    it('creates a fleet trip when the asset, driver, and zone all exist', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(buildAsset());
      prisma.driver.findUnique.mockResolvedValue({ id: 'driver-1' });
      prisma.deliveryZone.findUnique.mockResolvedValue({ id: 'zone-1' });
      fleetTripsRepository.create.mockResolvedValue(buildTrip());

      const result = await service.create(dto);
      expect(result.id).toBe('trip-1');
    });

    it('throws when the fleet asset does not exist', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(null);
      await expect(service.create(dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(fleetTripsRepository.create).not.toHaveBeenCalled();
    });

    it('throws when the driver does not exist', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(buildAsset());
      prisma.driver.findUnique.mockResolvedValue(null);
      await expect(service.create(dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(fleetTripsRepository.create).not.toHaveBeenCalled();
    });

    it('throws when the zone does not exist', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(buildAsset());
      prisma.driver.findUnique.mockResolvedValue({ id: 'driver-1' });
      prisma.deliveryZone.findUnique.mockResolvedValue(null);
      await expect(service.create(dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(fleetTripsRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns the trip when found', async () => {
      const trip = buildTrip();
      fleetTripsRepository.findById.mockResolvedValue(trip);
      await expect(service.findById('trip-1')).resolves.toEqual(trip);
    });

    it('throws when the trip does not exist', async () => {
      fleetTripsRepository.findById.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    it('updates a fleet trip', async () => {
      fleetTripsRepository.findById.mockResolvedValue(buildTrip());
      fleetTripsRepository.update.mockResolvedValue(
        buildTrip({ endedAt: new Date('2026-07-08T09:00:00.000Z') }),
      );

      const result = await service.update('trip-1', { endedAt: '2026-07-08T09:00:00.000Z' });
      expect(result.endedAt).not.toBeNull();
    });

    it('throws when the trip does not exist', async () => {
      fleetTripsRepository.findById.mockResolvedValue(null);
      await expect(service.update('missing', {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list', () => {
    it('paginates fleet trips', async () => {
      fleetTripsRepository.findMany.mockResolvedValue({ items: [buildTrip()], total: 1 });
      const result = await service.list({ page: 1, pageSize: 20 });
      expect(result.total).toBe(1);
    });
  });
});
