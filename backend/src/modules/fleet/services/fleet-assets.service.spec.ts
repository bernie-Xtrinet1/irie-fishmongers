import { ConflictException, NotFoundException } from '@nestjs/common';
import { FleetAsset } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { FleetAssetsRepository } from '../repositories/fleet-assets.repository';
import { FleetAssetsService } from './fleet-assets.service';

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

describe('FleetAssetsService', () => {
  let fleetAssetsRepository: jest.Mocked<
    Pick<
      FleetAssetsRepository,
      'create' | 'findById' | 'findByLicensePlate' | 'update' | 'findMany' | 'countByZoneAndStatus'
    >
  >;
  let prisma: { deliveryZone: { findUnique: jest.Mock }; driver: { findUnique: jest.Mock } };
  let service: FleetAssetsService;

  beforeEach(() => {
    fleetAssetsRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      findByLicensePlate: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      countByZoneAndStatus: jest.fn(),
    };
    prisma = {
      deliveryZone: { findUnique: jest.fn() },
      driver: { findUnique: jest.fn() },
    };
    service = new FleetAssetsService(
      fleetAssetsRepository as unknown as FleetAssetsRepository,
      prisma as unknown as PrismaService,
    );
  });

  describe('create', () => {
    const dto = {
      zoneId: 'zone-1',
      assetType: 'TRUCK' as const,
      ownership: 'COMPANY_OWNED' as const,
      licensePlate: 'FL 1234',
      capacityLbs: 2000,
    };

    it('creates a fleet asset when the zone exists and the plate is free', async () => {
      prisma.deliveryZone.findUnique.mockResolvedValue({ id: 'zone-1' });
      fleetAssetsRepository.findByLicensePlate.mockResolvedValue(null);
      fleetAssetsRepository.create.mockResolvedValue(buildAsset());

      const result = await service.create(dto);

      expect(result.id).toBe('asset-1');
      expect(fleetAssetsRepository.create).toHaveBeenCalledWith(dto);
    });

    it('throws when the zone does not exist', async () => {
      prisma.deliveryZone.findUnique.mockResolvedValue(null);
      await expect(service.create(dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(fleetAssetsRepository.create).not.toHaveBeenCalled();
    });

    it('throws when the license plate is already taken', async () => {
      prisma.deliveryZone.findUnique.mockResolvedValue({ id: 'zone-1' });
      fleetAssetsRepository.findByLicensePlate.mockResolvedValue(buildAsset());
      await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
      expect(fleetAssetsRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns the asset when found', async () => {
      const asset = buildAsset();
      fleetAssetsRepository.findById.mockResolvedValue(asset);
      await expect(service.findById('asset-1')).resolves.toEqual(asset);
    });

    it('throws when the asset does not exist', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    it('updates a fleet asset', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(buildAsset());
      fleetAssetsRepository.update.mockResolvedValue(buildAsset({ status: 'RETIRED' }));

      const result = await service.update('asset-1', { status: 'RETIRED' });
      expect(result.status).toBe('RETIRED');
    });

    it('validates the driver exists when assigning currentDriverId', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(buildAsset());
      prisma.driver.findUnique.mockResolvedValue(null);

      await expect(
        service.update('asset-1', { currentDriverId: 'missing-driver' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fleetAssetsRepository.update).not.toHaveBeenCalled();
    });

    it('throws when the asset does not exist', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(null);
      await expect(service.update('missing', { status: 'RETIRED' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('list', () => {
    it('paginates fleet assets', async () => {
      fleetAssetsRepository.findMany.mockResolvedValue({ items: [buildAsset()], total: 1 });
      const result = await service.list({ page: 1, pageSize: 20 });
      expect(result.total).toBe(1);
      expect(fleetAssetsRepository.findMany).toHaveBeenCalledWith(
        { zoneId: undefined, status: undefined },
        { skip: 0, take: 20 },
      );
    });
  });

  describe('getZoneSummary', () => {
    it('delegates to the repository rollup', async () => {
      fleetAssetsRepository.countByZoneAndStatus.mockResolvedValue([
        { zoneId: 'zone-1', status: 'ACTIVE', count: 3 },
        { zoneId: 'zone-1', status: 'MAINTENANCE', count: 1 },
      ]);

      const result = await service.getZoneSummary();

      expect(result).toEqual([
        { zoneId: 'zone-1', status: 'ACTIVE', count: 3 },
        { zoneId: 'zone-1', status: 'MAINTENANCE', count: 1 },
      ]);
    });
  });
});
