import { Injectable } from '@nestjs/common';
import { FreshnessGrade, InspectionResult, QualityInspection } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateInspectionInput {
  lotId: string;
  inspectorId: string;
  result: InspectionResult;
  freshnessGrade: FreshnessGrade;
  qualityScore: number;
  notes?: string;
  photoUrl?: string;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class QualityInspectionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateInspectionInput): Promise<QualityInspection> {
    return this.prisma.qualityInspection.create({ data: input });
  }

  async findByLotId(
    lotId: string,
    page: Page,
  ): Promise<{ items: QualityInspection[]; total: number }> {
    const where = { lotId };

    const [items, total] = await Promise.all([
      this.prisma.qualityInspection.findMany({
        where,
        orderBy: { inspectedAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.qualityInspection.count({ where }),
    ]);

    return { items, total };
  }
}
