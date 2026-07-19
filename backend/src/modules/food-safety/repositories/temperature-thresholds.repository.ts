import { Injectable } from '@nestjs/common';
import { SeafoodStorageType, TemperatureThreshold } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateTemperatureThresholdInput {
  deviceId?: string;
  storageType: SeafoodStorageType;
  minC: number;
  maxC: number;
  warningBandC: number;
}

export interface UpdateTemperatureThresholdInput {
  minC?: number;
  maxC?: number;
  warningBandC?: number;
}

@Injectable()
export class TemperatureThresholdsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateTemperatureThresholdInput): Promise<TemperatureThreshold> {
    return this.prisma.temperatureThreshold.create({ data: input });
  }

  findById(id: string): Promise<TemperatureThreshold | null> {
    return this.prisma.temperatureThreshold.findUnique({ where: { id } });
  }

  update(id: string, input: UpdateTemperatureThresholdInput): Promise<TemperatureThreshold> {
    return this.prisma.temperatureThreshold.update({ where: { id }, data: input });
  }

  findByDeviceAndStorageType(
    deviceId: string,
    storageType: SeafoodStorageType,
  ): Promise<TemperatureThreshold | null> {
    return this.prisma.temperatureThreshold.findFirst({ where: { deviceId, storageType } });
  }

  findPlatformDefault(storageType: SeafoodStorageType): Promise<TemperatureThreshold | null> {
    return this.prisma.temperatureThreshold.findFirst({ where: { deviceId: null, storageType } });
  }

  findAll(): Promise<TemperatureThreshold[]> {
    return this.prisma.temperatureThreshold.findMany({ orderBy: { createdAt: 'desc' } });
  }
}
