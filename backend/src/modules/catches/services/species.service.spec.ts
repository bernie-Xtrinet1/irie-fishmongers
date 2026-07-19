import { ConflictException, NotFoundException } from '@nestjs/common';
import { Species } from '@prisma/client';

import { CreateSpeciesDto } from '../dto/create-species.dto';
import { UpdateSpeciesDto } from '../dto/update-species.dto';
import { SpeciesRepository } from '../repositories/species.repository';
import { SpeciesService } from './species.service';

describe('SpeciesService', () => {
  let repo: jest.Mocked<
    Pick<SpeciesRepository, 'create' | 'findById' | 'update' | 'findAll' | 'findByScientificName'>
  >;
  let service: SpeciesService;

  const species = { id: 'sp-1', scientificName: 'Lutjanus' } as unknown as Species;

  beforeEach(() => {
    repo = {
      create: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      findAll: jest.fn(),
      findByScientificName: jest.fn(),
    };
    service = new SpeciesService(repo as unknown as SpeciesRepository);
  });

  it('creates a new species', async () => {
    const dto = { scientificName: 'Lutjanus', commercialName: 'Snapper' } as unknown as CreateSpeciesDto;
    repo.findByScientificName.mockResolvedValue(null);
    repo.create.mockResolvedValue(species);

    await expect(service.create(dto)).resolves.toBe(species);
    expect(repo.create).toHaveBeenCalledWith(dto);
  });

  it('rejects a duplicate scientific name', async () => {
    const dto = { scientificName: 'Lutjanus' } as unknown as CreateSpeciesDto;
    repo.findByScientificName.mockResolvedValue(species);

    await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('updates an existing species', async () => {
    const dto = { commercialName: 'Red Snapper' } as unknown as UpdateSpeciesDto;
    repo.findById.mockResolvedValue(species);
    repo.update.mockResolvedValue(species);

    await expect(service.update('sp-1', dto)).resolves.toBe(species);
    expect(repo.update).toHaveBeenCalledWith('sp-1', dto);
  });

  it('rejects updating a missing species', async () => {
    repo.findById.mockResolvedValue(null);

    await expect(service.update('missing', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('lists all species', async () => {
    repo.findAll.mockResolvedValue([species]);

    await expect(service.list()).resolves.toEqual([species]);
  });

  it('gets a species by id', async () => {
    repo.findById.mockResolvedValue(species);

    await expect(service.getById('sp-1')).resolves.toBe(species);
  });

  it('throws when getting a missing species', async () => {
    repo.findById.mockResolvedValue(null);

    await expect(service.getById('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
