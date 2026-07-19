import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Fisherman, LandingSite, Prisma, Species, Vessel } from '@prisma/client';

import { CatchRegisteredEvent } from '../../../common/events/catch-registered.event';
import { ListCatchesDto } from '../dto/list-catches.dto';
import { RegisterCatchDto } from '../dto/register-catch.dto';
import { CatchWithItems, CatchesRepository } from '../repositories/catches.repository';
import { FishermenRepository } from '../repositories/fishermen.repository';
import { LandingSitesRepository } from '../repositories/landing-sites.repository';
import { SpeciesRepository } from '../repositories/species.repository';
import { VesselsRepository } from '../repositories/vessels.repository';
import { CatchesService } from './catches.service';

describe('CatchesService', () => {
  let catchesRepo: jest.Mocked<
    Pick<CatchesRepository, 'findById' | 'findMany' | 'create' | 'countCreatedThisYear'>
  >;
  let fishermenRepo: jest.Mocked<Pick<FishermenRepository, 'findByUserId'>>;
  let landingSitesRepo: jest.Mocked<Pick<LandingSitesRepository, 'findById'>>;
  let speciesRepo: jest.Mocked<Pick<SpeciesRepository, 'findById'>>;
  let vesselsRepo: jest.Mocked<Pick<VesselsRepository, 'findById'>>;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emitAsync'>>;
  let service: CatchesService;

  const approvedFisherman = { id: 'fisher-1', status: 'APPROVED' } as unknown as Fisherman;
  const landingSite = { id: 'site-1' } as unknown as LandingSite;
  const sellableSpecies = {
    id: 'sp-1',
    commercialName: 'Snapper',
    regulatoryStatus: 'ALLOWED',
    seasonalStartMonth: null,
    seasonalEndMonth: null,
  } as unknown as Species;
  const created = { id: 'catch-1', items: [] } as unknown as CatchWithItems;

  function validDto(overrides: Partial<RegisterCatchDto> = {}): RegisterCatchDto {
    return {
      landingSiteId: 'site-1',
      catchDate: '2026-07-18',
      latitude: 17.9,
      longitude: -76.8,
      items: [{ speciesId: 'sp-1', weight: 10, weightUnit: 'POUNDS' }],
      ...overrides,
    } as unknown as RegisterCatchDto;
  }

  beforeEach(() => {
    catchesRepo = {
      findById: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      countCreatedThisYear: jest.fn().mockResolvedValue(0),
    };
    fishermenRepo = { findByUserId: jest.fn() };
    landingSitesRepo = { findById: jest.fn() };
    speciesRepo = { findById: jest.fn() };
    vesselsRepo = { findById: jest.fn() };
    eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) };
    service = new CatchesService(
      catchesRepo as unknown as CatchesRepository,
      fishermenRepo as unknown as FishermenRepository,
      landingSitesRepo as unknown as LandingSitesRepository,
      speciesRepo as unknown as SpeciesRepository,
      vesselsRepo as unknown as VesselsRepository,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('register', () => {
    it('registers a catch and emits CatchRegisteredEvent', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(approvedFisherman);
      landingSitesRepo.findById.mockResolvedValue(landingSite);
      speciesRepo.findById.mockResolvedValue(sellableSpecies);
      catchesRepo.create.mockResolvedValue(created);

      await expect(service.register('user-1', validDto())).resolves.toBe(created);
      expect(catchesRepo.create).toHaveBeenCalledTimes(1);
      expect(catchesRepo.create.mock.calls[0]?.[0].catchNumber).toMatch(/^CATCH-\d{4}-000001$/);
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        CatchRegisteredEvent.eventName,
        expect.any(CatchRegisteredEvent),
      );
    });

    it('validates an owned vessel when provided', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(approvedFisherman);
      landingSitesRepo.findById.mockResolvedValue(landingSite);
      vesselsRepo.findById.mockResolvedValue({ id: 'vessel-1', ownerFishermanId: 'fisher-1' } as unknown as Vessel);
      speciesRepo.findById.mockResolvedValue(sellableSpecies);
      catchesRepo.create.mockResolvedValue(created);

      await expect(service.register('user-1', validDto({ vesselId: 'vessel-1' }))).resolves.toBe(created);
    });

    it('throws when the caller has no fisherman profile', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(null);

      await expect(service.register('user-1', validDto())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('forbids non-approved fishermen', async () => {
      fishermenRepo.findByUserId.mockResolvedValue({ ...approvedFisherman, status: 'PENDING' });

      await expect(service.register('user-1', validDto())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws when the landing site is missing', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(approvedFisherman);
      landingSitesRepo.findById.mockResolvedValue(null);

      await expect(service.register('user-1', validDto())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when a provided vessel is missing', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(approvedFisherman);
      landingSitesRepo.findById.mockResolvedValue(landingSite);
      vesselsRepo.findById.mockResolvedValue(null);

      await expect(service.register('user-1', validDto({ vesselId: 'missing' }))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('forbids using a vessel owned by someone else', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(approvedFisherman);
      landingSitesRepo.findById.mockResolvedValue(landingSite);
      vesselsRepo.findById.mockResolvedValue({ id: 'vessel-1', ownerFishermanId: 'other' } as unknown as Vessel);

      await expect(service.register('user-1', validDto({ vesselId: 'vessel-1' }))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws when a catch-item species is missing', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(approvedFisherman);
      landingSitesRepo.findById.mockResolvedValue(landingSite);
      speciesRepo.findById.mockResolvedValue(null);

      await expect(service.register('user-1', validDto())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('retries catch-number generation on a unique-violation collision', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(approvedFisherman);
      landingSitesRepo.findById.mockResolvedValue(landingSite);
      speciesRepo.findById.mockResolvedValue(sellableSpecies);
      const collision = new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: '6.19.3',
        meta: { target: ['catchNumber'] },
      });
      catchesRepo.create.mockRejectedValueOnce(collision).mockResolvedValueOnce(created);

      await expect(service.register('user-1', validDto())).resolves.toBe(created);
      expect(catchesRepo.create).toHaveBeenCalledTimes(2);
    });

    it('rethrows a non-collision repository error', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(approvedFisherman);
      landingSitesRepo.findById.mockResolvedValue(landingSite);
      speciesRepo.findById.mockResolvedValue(sellableSpecies);
      catchesRepo.create.mockRejectedValue(new Error('boom'));

      await expect(service.register('user-1', validDto())).rejects.toThrow('boom');
    });
  });

  describe('getById', () => {
    it('returns a catch', async () => {
      catchesRepo.findById.mockResolvedValue(created);

      await expect(service.getById('catch-1')).resolves.toBe(created);
    });

    it('throws when the catch is missing', async () => {
      catchesRepo.findById.mockResolvedValue(null);

      await expect(service.getById('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getMine', () => {
    it('paginates the callers catches', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(approvedFisherman);
      catchesRepo.findMany.mockResolvedValue({ items: [created], total: 1 });

      const result = await service.getMine('user-1', { page: 1, pageSize: 20 });

      expect(result).toEqual({ items: [created], total: 1, page: 1, pageSize: 20 });
      expect(catchesRepo.findMany).toHaveBeenCalledWith({ fishermanId: 'fisher-1' }, { skip: 0, take: 20 });
    });

    it('throws when the caller has no fisherman profile', async () => {
      fishermenRepo.findByUserId.mockResolvedValue(null);

      await expect(service.getMine('user-1', { page: 1, pageSize: 20 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('list', () => {
    it('paginates and filters by fisherman', async () => {
      catchesRepo.findMany.mockResolvedValue({ items: [created], total: 1 });

      const dto = { fishermanId: 'fisher-9', page: 1, pageSize: 20 } as unknown as ListCatchesDto;
      const result = await service.list(dto);

      expect(result).toEqual({ items: [created], total: 1, page: 1, pageSize: 20 });
      expect(catchesRepo.findMany).toHaveBeenCalledWith({ fishermanId: 'fisher-9' }, { skip: 0, take: 20 });
    });
  });
});
