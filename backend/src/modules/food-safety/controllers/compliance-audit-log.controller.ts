import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ListAuditLogsDto } from '../dto/list-audit-logs.dto';
import { PaginatedAuditLogsEntity } from '../entities/paginated-audit-logs.entity';
import { ComplianceAuditLogService } from '../services/compliance-audit-log.service';

@ApiTags('compliance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('food-safety/audit-logs')
export class ComplianceAuditLogController {
  constructor(private readonly auditLogService: ComplianceAuditLogService) {}

  @Get()
  @ApiOperation({ summary: 'List compliance audit log entries, optionally filtered by entity (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedAuditLogsEntity })
  list(@Query() dto: ListAuditLogsDto): Promise<PaginatedAuditLogsEntity> {
    return this.auditLogService.list({ entityType: dto.entityType, entityId: dto.entityId }, dto);
  }
}
