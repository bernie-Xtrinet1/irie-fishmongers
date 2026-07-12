import { NotFoundException } from '@nestjs/common';
import { FleetAsset, FleetSanitationRecord } from '@prisma/client';

import { FleetAssetsRepository } from '../repositories/fleet-assets.repository';
import { FleetSanitationRecordsRepository } from '../repositories/fleet-sanitation-records.repository';
import { FleetSanitationRecordsService } from './fleet-sanitation-records.service';

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

function buildRecord(overrides: Partial<FleetSanitationRecord> = {}): FleetSanitationRecord {
  return {
    id: 'sanitation-1',
    fleetAssetId: 'asset-1',
    performedAt: new Date('2026-07-08T00:00:00.000Z'),
    performedBy: null,
    method: null,
    notes: null,
    nextDueAt: null,
    status: 'COMPLETED',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('FleetSanitationRecordsService', () => {
  let sanitationRecordsRepository: jest.Mocked<
    Pick<FleetSanitationRecordsRepository, 'create' | 'findByFleetAssetId'>
  >;
  let fleetAssetsRepository: jest.Mocked<Pick<FleetAssetsRepository, 'findById'>>;
  let service: FleetSanitationRecordsService;

  beforeEach(() => {
    sanitationRecordsRepository = { create: jest.fn(), findByFleetAssetId: jest.fn() };
    fleetAssetsRepository = { findById: jest.fn() };
    service = new FleetSanitationRecordsService(
      sanitationRecordsRepository as unknown as FleetSanitationRecordsRepository,
      fleetAssetsRepository as unknown as FleetAssetsRepository,
    );
  });

  describe('create', () => {
    const dto = { performedAt: '2026-07-08T00:00:00.000Z' };

    it('creates a sanitation record for an existing fleet asset', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(buildAsset());
      sanitationRecordsRepository.create.mockResolvedValue(buildRecord());

      const result = await service.create('asset-1', dto);
      expect(result.id).toBe('sanitation-1');
    });

    it('throws when the fleet asset does not exist', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(null);
      await expect(service.create('missing', dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(sanitationRecordsRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('findByFleetAssetId', () => {
    it('paginates sanitation records for a fleet asset', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(buildAsset());
      sanitationRecordsRepository.findByFleetAssetId.mockResolvedValue({
        items: [buildRecord()],
        total: 1,
      });

      const result = await service.findByFleetAssetId('asset-1', { page: 1, pageSize: 20 });
      expect(result.total).toBe(1);
    });

    it('throws when the fleet asset does not exist', async () => {
      fleetAssetsRepository.findById.mockResolvedValue(null);
      await expect(
        service.findByFleetAssetId('missing', { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
