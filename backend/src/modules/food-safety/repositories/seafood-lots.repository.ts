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
  species: string;
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

  findByIdWithVendor(id: string): Promise<LotWithVendor | null> {
    return this.prisma.seafoodLot.findUnique({ where: { id }, include: lotWithVendor.include });
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
