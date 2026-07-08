import { ConflictException, NotFoundException } from '@nestjs/common';
import { DeliveryZone } from '@prisma/client';

import { DeliveryZonesRepository } from '../repositories/delivery-zones.repository';
import { DeliveryZonesService } from './delivery-zones.service';

function buildZone(overrides: Partial<DeliveryZone> = {}): DeliveryZone {
  return {
    id: 'zone-1',
    name: 'Zone 1',
    code: 'ZONE_1',
    description: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('DeliveryZonesService', () => {
  let deliveryZonesRepository: jest.Mocked<
    Pick<DeliveryZonesRepository, 'findAll' | 'findById' | 'findByCode' | 'create' | 'update'>
  >;
  let service: DeliveryZonesService;

  beforeEach(() => {
    deliveryZonesRepository = {
      findAll: jest.fn(),
      findById: jest.fn(),
      findByCode: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    service = new DeliveryZonesService(
      deliveryZonesRepository as unknown as DeliveryZonesRepository,
    );
  });

  describe('list', () => {
    it('returns all delivery zones', async () => {
      const zone = buildZone();
      deliveryZonesRepository.findAll.mockResolvedValue([zone]);
      await expect(service.list()).resolves.toEqual([zone]);
    });
  });

  describe('create', () => {
    it('creates a zone when the code is not already taken', async () => {
      const zone = buildZone();
      deliveryZonesRepository.findByCode.mockResolvedValue(null);
      deliveryZonesRepository.create.mockResolvedValue(zone);

      const dto = { name: 'Zone 1', code: 'ZONE_1' };
      await expect(service.create(dto)).resolves.toEqual(zone);
      expect(deliveryZonesRepository.create).toHaveBeenCalledWith(dto);
    });

    it('throws when the zone code already exists', async () => {
      deliveryZonesRepository.findByCode.mockResolvedValue(buildZone());
      await expect(
        service.create({ name: 'Zone 1', code: 'ZONE_1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(deliveryZonesRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('updates an existing zone', async () => {
      deliveryZonesRepository.findById.mockResolvedValue(buildZone());
      deliveryZonesRepository.update.mockResolvedValue(buildZone({ active: false }));

      const result = await service.update('zone-1', { active: false });
      expect(result.active).toBe(false);
      expect(deliveryZonesRepository.update).toHaveBeenCalledWith('zone-1', { active: false });
    });

    it('throws when the zone does not exist', async () => {
      deliveryZonesRepository.findById.mockResolvedValue(null);
      await expect(service.update('missing', { active: false })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(deliveryZonesRepository.update).not.toHaveBeenCalled();
    });
  });
});
