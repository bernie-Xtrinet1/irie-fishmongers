import { Injectable, Logger } from '@nestjs/common';
import { ComplianceAuditLog, Prisma } from '@prisma/client';

import { PaginatedAuditLogsEntity } from '../entities/paginated-audit-logs.entity';
import {
  ComplianceAuditLogsRepository,
  CreateComplianceAuditLogInput,
} from '../repositories/compliance-audit-logs.repository';

export interface RecordAuditLogInput {
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeValue?: Prisma.InputJsonValue;
  afterValue?: Prisma.InputJsonValue;
  ipAddress?: string;
  reason?: string;
}

// Deliberately scoped to the food-safety module's own compliance mutations
// (lot/recall/incident status changes, inspections, fisherman approval) -
// not a platform-wide audit log for every module. Never blocks the
// mutation it's auditing: called after the mutation already succeeded, and
// a logging failure here is caught and logged rather than surfaced to the
// caller - the compliance action itself must not fail because its own
// audit trail couldn't be written.
@Injectable()
export class ComplianceAuditLogService {
  private readonly logger = new Logger(ComplianceAuditLogService.name);

  constructor(private readonly auditLogsRepository: ComplianceAuditLogsRepository) {}

  async record(input: RecordAuditLogInput): Promise<ComplianceAuditLog | null> {
    const data: CreateComplianceAuditLogInput = {
      userId: input.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      beforeValue: input.beforeValue,
      afterValue: input.afterValue,
      ipAddress: input.ipAddress,
      reason: input.reason,
    };
    try {
      return await this.auditLogsRepository.create(data);
    } catch (error) {
      this.logger.error(
        `Failed to record compliance audit log for ${input.entityType} ${input.entityId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }

  async list(
    filters: { entityType?: string; entityId?: string },
    page: { page: number; pageSize: number },
  ): Promise<PaginatedAuditLogsEntity> {
    const { items, total } = await this.auditLogsRepository.findMany(filters, {
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    return {
      items: items.map((item) => ({
        id: item.id,
        userId: item.userId,
        action: item.action,
        entityType: item.entityType,
        entityId: item.entityId,
        beforeValue: item.beforeValue,
        afterValue: item.afterValue,
        ipAddress: item.ipAddress,
        reason: item.reason,
        createdAt: item.createdAt,
      })),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }
}
