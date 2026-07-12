import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { DashboardSummaryQueryDto } from '../dto/dashboard-summary-query.dto';
import { DashboardSummaryEntity } from '../entities/dashboard-summary.entity';
import { SalesAnalyticsEntity } from '../entities/sales-analytics.entity';
import { VendorDashboardEntity } from '../entities/vendor-dashboard.entity';
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
    return this.analyticsService.getDashboardSummary(AnalyticsController.parseRange(query));
  }

  @Get('vendor-dashboard')
  @ApiOperation({
    summary:
      'Vendor Dashboard: vendor counts by status/tier, average compliance score, top vendors by revenue - admin only',
  })
  @ApiResponseDoc({ status: 200, type: VendorDashboardEntity })
  getVendorDashboard(@Query() query: DashboardSummaryQueryDto): Promise<VendorDashboardEntity> {
    return this.analyticsService.getVendorDashboard(AnalyticsController.parseRange(query));
  }

  @Get('sales-analytics')
  @ApiOperation({
    summary:
      'Sales Analytics: top products and categories by revenue, sales by payment method, average order value - admin only',
  })
  @ApiResponseDoc({ status: 200, type: SalesAnalyticsEntity })
  getSalesAnalytics(@Query() query: DashboardSummaryQueryDto): Promise<SalesAnalyticsEntity> {
    return this.analyticsService.getSalesAnalytics(AnalyticsController.parseRange(query));
  }

  private static parseRange(query: DashboardSummaryQueryDto): { from?: Date; to?: Date } {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;

    if (from && to && from > to) {
      throw new BadRequestException('`from` must not be later than `to`');
    }

    return { from, to };
  }
}
