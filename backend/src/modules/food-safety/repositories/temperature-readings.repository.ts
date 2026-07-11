import { Injectable } from '@nestjs/common';
import { TemperatureCheckpoint, TemperatureReading } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateReadingInput {
  lotId: string;
  deviceId?: string;
  checkpoint: TemperatureCheckpoint;
  temperatureC: number;
  recordedById: string;
  latitude?: number;
  longitude?: number;
  photoUrl?: string;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class TemperatureReadingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateReadingInput): Promise<TemperatureReading> {
    return this.prisma.temperatureReading.create({ data: input });
  }

  async findByLotId(
    lotId: string,
    page: Page,
  ): Promise<{ items: TemperatureReading[]; total: number }> {
    const where = { lotId };

    const [items, total] = await Promise.all([
      this.prisma.temperatureReading.findMany({
        where,
        orderBy: { recordedAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.temperatureReading.count({ where }),
    ]);

    return { items, total };
  }

  countByLotId(lotId: string): Promise<number> {
    return this.prisma.temperatureReading.count({ where: { lotId } });
  }
}
