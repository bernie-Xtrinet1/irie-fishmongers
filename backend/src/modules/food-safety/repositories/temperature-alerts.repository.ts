import { Injectable } from '@nestjs/common';
import { AlertSeverity, Prisma, TemperatureAlert } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateAlertInput {
  readingId: string;
  lotId: string;
  severity: AlertSeverity;
  actualC: number;
}

export interface Page {
  skip: number;
  take: number;
}

export interface AlertFilters {
  severity?: AlertSeverity;
  resolved?: boolean;
}

@Injectable()
export class TemperatureAlertsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateAlertInput): Promise<TemperatureAlert> {
    return this.prisma.temperatureAlert.create({ data: input });
  }

  findById(id: string): Promise<TemperatureAlert | null> {
    return this.prisma.temperatureAlert.findUnique({ where: { id } });
  }

  resolve(id: string): Promise<TemperatureAlert> {
    return this.prisma.temperatureAlert.update({
      where: { id },
      data: { resolved: true, resolvedAt: new Date() },
    });
  }

  countUnresolvedByLotId(lotId: string): Promise<number> {
    return this.prisma.temperatureAlert.count({ where: { lotId, resolved: false } });
  }

  findUnresolvedByLotId(lotId: string): Promise<TemperatureAlert[]> {
    return this.prisma.temperatureAlert.findMany({ where: { lotId, resolved: false } });
  }

  async countUnresolvedBySeverity(): Promise<Record<AlertSeverity, number>> {
    const groups = await this.prisma.temperatureAlert.groupBy({
      by: ['severity'],
      where: { resolved: false },
      _count: { _all: true },
    });
    const counts: Record<AlertSeverity, number> = { WARNING: 0, CRITICAL: 0, EMERGENCY: 0 };
    for (const group of groups) {
      counts[group.severity] = group._count._all;
    }
    return counts;
  }

  async findMany(
    filters: AlertFilters,
    page: Page,
  ): Promise<{ items: TemperatureAlert[]; total: number }> {
    const where: Prisma.TemperatureAlertWhereInput = {
      ...(filters.severity ? { severity: filters.severity } : {}),
      ...(filters.resolved !== undefined ? { resolved: filters.resolved } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.temperatureAlert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.temperatureAlert.count({ where }),
    ]);

    return { items, total };
  }

  findAllForExport(): Promise<TemperatureAlert[]> {
    return this.prisma.temperatureAlert.findMany({ orderBy: { createdAt: 'desc' } });
  }
}
