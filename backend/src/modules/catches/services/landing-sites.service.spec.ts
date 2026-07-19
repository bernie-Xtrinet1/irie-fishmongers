import { NotFoundException } from '@nestjs/common';
import { LandingSite } from '@prisma/client';

import { CreateLandingSiteDto } from '../dto/create-landing-site.dto';
import { UpdateLandingSiteDto } from '../dto/update-landing-site.dto';
import { LandingSitesRepository } from '../repositories/landing-sites.repository';
import { LandingSitesService } from './landing-sites.service';

describe('LandingSitesService', () => {
  let repo: jest.Mocked<Pick<LandingSitesRepository, 'create' | 'findById' | 'update' | 'findAll'>>;
  let service: LandingSitesService;

  const site = { id: 'site-1', name: 'Old Harbour' } as unknown as LandingSite;

  beforeEach(() => {
    repo = { create: jest.fn(), findById: jest.fn(), update: jest.fn(), findAll: jest.fn() };
    service = new LandingSitesService(repo as unknown as LandingSitesRepository);
  });

  it('creates a landing site', async () => {
    const dto = { name: 'Old Harbour', parish: 'ST_CATHERINE' } as unknown as CreateLandingSiteDto;
    repo.create.mockResolvedValue(site);

    await expect(service.create(dto)).resolves.toBe(site);
    expect(repo.create).toHaveBeenCalledWith(dto);
  });

  it('updates an existing site', async () => {
    const dto = { name: 'New name' } as unknown as UpdateLandingSiteDto;
    repo.findById.mockResolvedValue(site);
    repo.update.mockResolvedValue(site);

    await expect(service.update('site-1', dto)).resolves.toBe(site);
    expect(repo.update).toHaveBeenCalledWith('site-1', dto);
  });

  it('rejects updating a missing site', async () => {
    repo.findById.mockResolvedValue(null);

    await expect(service.update('missing', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('lists all sites', async () => {
    repo.findAll.mockResolvedValue([site]);

    await expect(service.list()).resolves.toEqual([site]);
  });

  it('gets a site by id', async () => {
    repo.findById.mockResolvedValue(site);

    await expect(service.getById('site-1')).resolves.toBe(site);
  });

  it('throws when getting a missing site', async () => {
    repo.findById.mockResolvedValue(null);

    await expect(service.getById('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
