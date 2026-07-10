import { Injectable } from '@nestjs/common';
import { ComplianceAuditLog, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateComplianceAuditLogInput {
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeValue?: Prisma.InputJsonValue;
  afterValue?: Prisma.InputJsonValue;
  ipAddress?: string;
  reason?: string;
}

export interface Page {
  skip: number;
  take: number;
}

export interface ComplianceAuditLogFilters {
  entityType?: string;
  entityId?: string;
}

@Injectable()
export class ComplianceAuditLogsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateComplianceAuditLogInput): Promise<ComplianceAuditLog> {
    return this.prisma.complianceAuditLog.create({ data: input });
  }

  async findMany(
    filters: ComplianceAuditLogFilters,
    page: Page,
  ): Promise<{ items: ComplianceAuditLog[]; total: number }> {
    const where: Prisma.ComplianceAuditLogWhereInput = {
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.complianceAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.complianceAuditLog.count({ where }),
    ]);

    return { items, total };
  }
}
