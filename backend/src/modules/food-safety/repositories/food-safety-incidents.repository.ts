import { Injectable } from '@nestjs/common';
import { FoodSafetyIncident, IncidentSeverity, IncidentStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateIncidentInput {
  lotId: string;
  reportedById: string;
  severity: IncidentSeverity;
  description: string;
  photoUrl?: string;
}

export interface Page {
  skip: number;
  take: number;
}

export interface IncidentFilters {
  severity?: IncidentSeverity;
  status?: IncidentStatus;
}

@Injectable()
export class FoodSafetyIncidentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateIncidentInput): Promise<FoodSafetyIncident> {
    return this.prisma.foodSafetyIncident.create({ data: input });
  }

  findById(id: string): Promise<FoodSafetyIncident | null> {
    return this.prisma.foodSafetyIncident.findUnique({ where: { id } });
  }

  updateStatus(
    id: string,
    status: IncidentStatus,
    data: { correctiveAction?: string; resolvedAt?: Date } = {},
  ): Promise<FoodSafetyIncident> {
    return this.prisma.foodSafetyIncident.update({ where: { id }, data: { status, ...data } });
  }

  async findByLotId(
    lotId: string,
    page: Page,
  ): Promise<{ items: FoodSafetyIncident[]; total: number }> {
    const where = { lotId };

    const [items, total] = await Promise.all([
      this.prisma.foodSafetyIncident.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.foodSafetyIncident.count({ where }),
    ]);

    return { items, total };
  }

  async findMany(
    filters: IncidentFilters,
    page: Page,
  ): Promise<{ items: FoodSafetyIncident[]; total: number }> {
    const where: Prisma.FoodSafetyIncidentWhereInput = {
      ...(filters.severity ? { severity: filters.severity } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.foodSafetyIncident.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.foodSafetyIncident.count({ where }),
    ]);

    return { items, total };
  }
}
