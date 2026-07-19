import { NotFoundException } from '@nestjs/common';
import { TemperatureThreshold } from '@prisma/client';

import { CreateTemperatureThresholdDto } from '../dto/create-temperature-threshold.dto';
import { UpdateTemperatureThresholdDto } from '../dto/update-temperature-threshold.dto';
import { TemperatureThresholdsRepository } from '../repositories/temperature-thresholds.repository';
import { TemperatureThresholdsService } from './temperature-thresholds.service';

describe('TemperatureThresholdsService', () => {
  let repo: jest.Mocked<Pick<TemperatureThresholdsRepository, 'create' | 'findById' | 'update' | 'findAll'>>;
  let service: TemperatureThresholdsService;

  const threshold = { id: 'thr-1', checkpoint: 'VENDOR_STORAGE' } as unknown as TemperatureThreshold;

  beforeEach(() => {
    repo = { create: jest.fn(), findById: jest.fn(), update: jest.fn(), findAll: jest.fn() };
    service = new TemperatureThresholdsService(repo as unknown as TemperatureThresholdsRepository);
  });

  it('creates a threshold', async () => {
    const dto = { checkpoint: 'VENDOR_STORAGE', maxC: -18 } as unknown as CreateTemperatureThresholdDto;
    repo.create.mockResolvedValue(threshold);

    await expect(service.create(dto)).resolves.toBe(threshold);
    expect(repo.create).toHaveBeenCalledWith(dto);
  });

  it('updates an existing threshold', async () => {
    const dto = { maxC: -20 } as unknown as UpdateTemperatureThresholdDto;
    repo.findById.mockResolvedValue(threshold);
    repo.update.mockResolvedValue(threshold);

    await expect(service.update('thr-1', dto)).resolves.toBe(threshold);
    expect(repo.update).toHaveBeenCalledWith('thr-1', dto);
  });

  it('rejects updating a missing threshold', async () => {
    repo.findById.mockResolvedValue(null);

    await expect(service.update('missing', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('lists all thresholds', async () => {
    repo.findAll.mockResolvedValue([threshold]);

    await expect(service.list()).resolves.toEqual([threshold]);
  });
});
