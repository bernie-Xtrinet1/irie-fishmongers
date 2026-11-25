import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { isAdministratorRole } from '../../../common/auth/admin-roles';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { DashboardSummaryQueryDto } from '../dto/dashboard-summary-query.dto';
import { DashboardSummaryEntity } from '../entities/dashboard-summary.entity';
import { DeliveryAnalyticsEntity } from '../entities/delivery-analytics.entity';
import { InventoryAnalyticsEntity } from '../entities/inventory-analytics.entity';
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
  @Roles(RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF)
  @ApiOperation({
    summary:
      'Admin dashboard overview KPIs (financials omitted for operations staff)',
  })
  @ApiResponseDoc({ status: 200, type: DashboardSummaryEntity })
  getDashboardSummary(
    @Query() query: DashboardSummaryQueryDto,
    @CurrentUser() user: RequestUser,
  ): Promise<DashboardSummaryEntity> {
    return this.analyticsService.getDashboardSummary(AnalyticsController.parseRange(query), {
      includeFinancials: isAdministratorRole(user.roles),
    });
  }

  @Get('vendor-dashboard')
  @Roles(RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF)
  @ApiOperation({
    summary:
      'Vendor Dashboard: vendor counts by status/tier, average compliance score (revenue ranking omitted for operations staff)',
  })
  @ApiResponseDoc({ status: 200, type: VendorDashboardEntity })
  getVendorDashboard(
    @Query() query: DashboardSummaryQueryDto,
    @CurrentUser() user: RequestUser,
  ): Promise<VendorDashboardEntity> {
    return this.analyticsService.getVendorDashboard(AnalyticsController.parseRange(query), {
      includeFinancials: isAdministratorRole(user.roles),
    });
  }

  @Get('sales-analytics')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({
    summary:
      'Sales Analytics: top products and categories by revenue, sales by payment method, average order value - admin only',
  })
  @ApiResponseDoc({ status: 200, type: SalesAnalyticsEntity })
  getSalesAnalytics(@Query() query: DashboardSummaryQueryDto): Promise<SalesAnalyticsEntity> {
    return this.analyticsService.getSalesAnalytics(AnalyticsController.parseRange(query));
  }

  @Get('delivery-analytics')
  @Roles(RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF)
  @ApiOperation({
    summary:
      'Delivery Analytics: SLA breaches by zone, fleet asset counts by zone, delivery customer-acceptance breakdown',
  })
  @ApiResponseDoc({ status: 200, type: DeliveryAnalyticsEntity })
  getDeliveryAnalytics(@Query() query: DashboardSummaryQueryDto): Promise<DeliveryAnalyticsEntity> {
    return this.analyticsService.getDeliveryAnalytics(AnalyticsController.parseRange(query));
  }

  @Get('inventory-analytics')
  @Roles(RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF)
  @ApiOperation({
    summary:
      'Inventory Analytics: product counts by availability, low-stock products, inventory event activity by type',
  })
  @ApiResponseDoc({ status: 200, type: InventoryAnalyticsEntity })
  getInventoryAnalytics(@Query() query: DashboardSummaryQueryDto): Promise<InventoryAnalyticsEntity> {
    return this.analyticsService.getInventoryAnalytics(AnalyticsController.parseRange(query));
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
