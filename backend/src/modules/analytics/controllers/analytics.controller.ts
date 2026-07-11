import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { DashboardSummaryQueryDto } from '../dto/dashboard-summary-query.dto';
import { DashboardSummaryEntity } from '../entities/dashboard-summary.entity';
import { AnalyticsService } from '../services/analytics.service';

@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('dashboard-summary')
  @ApiOperation({
    summary:
      'Admin dashboard overview KPIs (financials, orders, vendors, drivers, compliance, system health) - admin only',
  })
  @ApiResponseDoc({ status: 200, type: DashboardSummaryEntity })
  getDashboardSummary(@Query() query: DashboardSummaryQueryDto): Promise<DashboardSummaryEntity> {
    return this.analyticsService.getDashboardSummary({
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }
}
