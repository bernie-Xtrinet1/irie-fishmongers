import { Injectable, NotFoundException } from '@nestjs/common';
import { TemperatureThreshold } from '@prisma/client';

import { CreateTemperatureThresholdDto } from '../dto/create-temperature-threshold.dto';
import { UpdateTemperatureThresholdDto } from '../dto/update-temperature-threshold.dto';
import { TemperatureThresholdsRepository } from '../repositories/temperature-thresholds.repository';

@Injectable()
export class TemperatureThresholdsService {
  constructor(private readonly thresholdsRepository: TemperatureThresholdsRepository) {}

  create(dto: CreateTemperatureThresholdDto): Promise<TemperatureThreshold> {
    return this.thresholdsRepository.create(dto);
  }

  async update(id: string, dto: UpdateTemperatureThresholdDto): Promise<TemperatureThreshold> {
    const threshold = await this.thresholdsRepository.findById(id);
    if (!threshold) {
      throw new NotFoundException('Temperature threshold not found');
    }
    return this.thresholdsRepository.update(id, dto);
  }

  list(): Promise<TemperatureThreshold[]> {
    return this.thresholdsRepository.findAll();
  }
}
