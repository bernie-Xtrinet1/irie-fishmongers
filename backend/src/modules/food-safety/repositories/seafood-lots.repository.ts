import { Injectable } from '@nestjs/common';
import {
  FoodSafetyStatus,
  FreshnessGrade,
  Prisma,
  SeafoodLot,
  SeafoodStorageType,
  WeightUnit,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateLotInput {
  lotNumber: string;
  vendorId: string;
  catchItemId?: string;
  species: string;
  speciesId?: string;
  storageType: SeafoodStorageType;
  catchDate: Date;
  catchLocation?: string;
  landingSite?: string;
  weight: number;
  weightUnit: WeightUnit;
}

export interface Page {
  skip: number;
  take: number;
}

export interface LotFilters {
  vendorId?: string;
  status?: FoodSafetyStatus;
}

const lotWithVendor = Prisma.validator<Prisma.SeafoodLotDefaultArgs>()({
  include: { vendor: true },
});

export type LotWithVendor = Prisma.SeafoodLotGetPayload<typeof lotWithVendor>;

@Injectable()
export class SeafoodLotsRepository {
  constructor(private readonly prisma: PrismaService) {}

  countCreatedThisYear(year: number): Promise<number> {
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year + 1, 0, 1));
    return this.prisma.seafoodLot.count({ where: { createdAt: { gte: start, lt: end } } });
  }

  create(input: CreateLotInput): Promise<SeafoodLot> {
    return this.prisma.seafoodLot.create({ data: input });
  }

  findById(id: string): Promise<SeafoodLot | null> {
    return this.prisma.seafoodLot.findUnique({ where: { id } });
  }

  countByStatus(status: FoodSafetyStatus): Promise<number> {
    return this.prisma.seafoodLot.count({ where: { foodSafetyStatus: status } });
  }

  findAllForExport(): Promise<LotWithVendor[]> {
    return this.prisma.seafoodLot.findMany({
      include: lotWithVendor.include,
      orderBy: { createdAt: 'desc' },
    });
  }

  findByIdWithVendor(id: string): Promise<LotWithVendor | null> {
    return this.prisma.seafoodLot.findUnique({ where: { id }, include: lotWithVendor.include });
  }

  // The Digital Product Passport's public lookup key - never by id/lotNumber
  // (lotNumber is sequential/enumerable), closing the enumeration gap a
  // sequential lookup would otherwise have.
  findByPublicTraceToken(token: string): Promise<LotWithVendor | null> {
    return this.prisma.seafoodLot.findUnique({ where: { publicTraceToken: token }, include: lotWithVendor.include });
  }

  updateStatus(
    id: string,
    status: FoodSafetyStatus,
    statusNotes?: string,
  ): Promise<SeafoodLot> {
    return this.prisma.seafoodLot.update({ where: { id }, data: { foodSafetyStatus: status, statusNotes } });
  }

  updateGrading(
    id: string,
    data: { freshnessGrade: FreshnessGrade; qualityScore: number },
  ): Promise<SeafoodLot> {
    return this.prisma.seafoodLot.update({
      where: { id },
      data: { freshnessGrade: data.freshnessGrade, qualityScore: data.qualityScore },
    });
  }

  async findManyByVendor(
    vendorId: string,
    page: Page,
  ): Promise<{ items: SeafoodLot[]; total: number }> {
    const where: Prisma.SeafoodLotWhereInput = { vendorId };

    const [items, total] = await Promise.all([
      this.prisma.seafoodLot.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.seafoodLot.count({ where }),
    ]);

    return { items, total };
  }

  // Phase 13D: the "as of" date for a lot's public qualityScore.
  // SeafoodLot itself has no inspection-timestamp column - queried
  // directly against QualityInspection here (rather than injecting
  // QualityInspectionsRepository, which lives in QualityModule and
  // imports SeafoodLotsModule - injecting it back would create a module
  // cycle) since a Prisma query against a table isn't scoped by NestJS
  // module boundaries the way service injection is.
  async findLatestInspectedAt(lotId: string): Promise<Date | null> {
    const latest = await this.prisma.qualityInspection.findFirst({
      where: { lotId },
      orderBy: { inspectedAt: 'desc' },
      select: { inspectedAt: true },
    });
    return latest?.inspectedAt ?? null;
  }

  async findMany(
    filters: LotFilters,
    page: Page,
  ): Promise<{ items: SeafoodLot[]; total: number }> {
    const where: Prisma.SeafoodLotWhereInput = {
      ...(filters.vendorId ? { vendorId: filters.vendorId } : {}),
      ...(filters.status ? { foodSafetyStatus: filters.status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.seafoodLot.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.seafoodLot.count({ where }),
    ]);

    return { items, total };
  }
}
