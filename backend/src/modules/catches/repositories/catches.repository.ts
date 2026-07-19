import { Injectable } from '@nestjs/common';
import { Catch, CatchItem, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateCatchItemInput {
  speciesId: string;
  weight: number;
  weightUnit: Prisma.CatchItemCreateInput['weightUnit'];
  estimatedFreshness?: Prisma.CatchItemCreateInput['estimatedFreshness'];
}

export interface CreateCatchInput {
  catchNumber: string;
  fishermanId: string;
  vesselId?: string;
  landingSiteId: string;
  catchDate: Date;
  latitude?: number;
  longitude?: number;
  fishingArea?: string;
  photos?: string[];
  items: CreateCatchItemInput[];
}

export interface Page {
  skip: number;
  take: number;
}

export type CatchWithItems = Catch & { items: CatchItem[] };

@Injectable()
export class CatchesRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateCatchInput): Promise<CatchWithItems> {
    const { items, ...catchFields } = input;
    return this.prisma.catch.create({
      data: { ...catchFields, items: { create: items } },
      include: { items: true },
    });
  }

  findById(id: string): Promise<CatchWithItems | null> {
    return this.prisma.catch.findUnique({ where: { id }, include: { items: true } });
  }

  countCreatedThisYear(year: number): Promise<number> {
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year + 1, 0, 1));
    return this.prisma.catch.count({ where: { createdAt: { gte: start, lt: end } } });
  }

  async findMany(
    filters: { fishermanId?: string },
    page: Page,
  ): Promise<{ items: CatchWithItems[]; total: number }> {
    const where: Prisma.CatchWhereInput = filters.fishermanId
      ? { fishermanId: filters.fishermanId }
      : {};

    const [items, total] = await Promise.all([
      this.prisma.catch.findMany({
        where,
        include: { items: true },
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.catch.count({ where }),
    ]);

    return { items, total };
  }
}
