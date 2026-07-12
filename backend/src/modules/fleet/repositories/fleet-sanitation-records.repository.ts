import { Injectable } from '@nestjs/common';
import { FleetSanitationRecord, Prisma, SanitationStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateFleetSanitationRecordInput {
  fleetAssetId: string;
  performedAt: Date;
  performedBy?: string;
  method?: string;
  notes?: string;
  nextDueAt?: Date;
  status?: SanitationStatus;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class FleetSanitationRecordsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateFleetSanitationRecordInput): Promise<FleetSanitationRecord> {
    return this.prisma.fleetSanitationRecord.create({ data: input });
  }

  async findByFleetAssetId(
    fleetAssetId: string,
    page: Page,
  ): Promise<{ items: FleetSanitationRecord[]; total: number }> {
    const where: Prisma.FleetSanitationRecordWhereInput = { fleetAssetId };

    const [items, total] = await Promise.all([
      this.prisma.fleetSanitationRecord.findMany({
        where,
        orderBy: { performedAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.fleetSanitationRecord.count({ where }),
    ]);

    return { items, total };
  }
}
