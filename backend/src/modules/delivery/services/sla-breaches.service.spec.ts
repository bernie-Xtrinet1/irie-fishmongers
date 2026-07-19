import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SLABreach } from '@prisma/client';

import { SLABreachesRepository } from '../repositories/sla-breaches.repository';
import { SLABreachesService } from './sla-breaches.service';

function buildBreach(overrides: Partial<SLABreach> = {}): SLABreach {
  return {
    id: 'breach-1',
    deliveryId: 'delivery-1',
    type: 'OVERDUE_IN_TRANSIT',
    scheduledEnd: new Date('2026-07-08T10:00:00.000Z'),
    minutesLate: 20,
    detectedAt: new Date(),
    resolved: false,
    resolvedAt: null,
    resolvedById: null,
    ...overrides,
  };
}

describe('SLABreachesService', () => {
  let slaBreachesRepository: jest.Mocked<
    Pick<SLABreachesRepository, 'findMany' | 'findById' | 'resolve' | 'getBreachCountsByZone'>
  >;
  let service: SLABreachesService;

  beforeEach(() => {
    slaBreachesRepository = {
      findMany: jest.fn(),
      findById: jest.fn(),
      resolve: jest.fn(),
      getBreachCountsByZone: jest.fn(),
    };
    service = new SLABreachesService(slaBreachesRepository as unknown as SLABreachesRepository);
  });

  describe('list', () => {
    it('paginates breaches filtered by resolution status and type', async () => {
      slaBreachesRepository.findMany.mockResolvedValue({ items: [buildBreach()], total: 1 });

      const result = await service.list({ resolved: false, page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(slaBreachesRepository.findMany).toHaveBeenCalledWith(
        { resolved: false, type: undefined },
        { skip: 0, take: 20 },
      );
    });
  });

  describe('resolve', () => {
    it('resolves an unresolved breach', async () => {
      slaBreachesRepository.findById.mockResolvedValue(buildBreach());
      slaBreachesRepository.resolve.mockResolvedValue(
        buildBreach({ resolved: true, resolvedAt: new Date(), resolvedById: 'admin-1' }),
      );

      const result = await service.resolve('breach-1', 'admin-1');

      expect(result.resolved).toBe(true);
      expect(slaBreachesRepository.resolve).toHaveBeenCalledWith('breach-1', 'admin-1');
    });

    it('rejects resolving an already-resolved breach', async () => {
      slaBreachesRepository.findById.mockResolvedValue(buildBreach({ resolved: true }));
      await expect(service.resolve('breach-1', 'admin-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws when the breach does not exist', async () => {
      slaBreachesRepository.findById.mockResolvedValue(null);
      await expect(service.resolve('missing', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getZoneSummary', () => {
    it('delegates to the repository rollup', async () => {
      slaBreachesRepository.getBreachCountsByZone.mockResolvedValue([
        { zoneId: 'zone-1', totalBreaches: 3, unresolvedBreaches: 1 },
      ]);

      const result = await service.getZoneSummary();

      expect(result).toEqual([{ zoneId: 'zone-1', totalBreaches: 3, unresolvedBreaches: 1 }]);
    });
  });
});
