import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ComplianceDashboardEntity } from '../entities/compliance-dashboard.entity';
import { ComplianceDashboardService } from '../services/compliance-dashboard.service';

@ApiTags('compliance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('food-safety/compliance-dashboard')
export class ComplianceDashboardController {
  constructor(private readonly complianceDashboardService: ComplianceDashboardService) {}

  @Get()
  @ApiOperation({ summary: 'Compliance overview: active alerts, failed inspections, recalls, vendor/fisherman status (admin only)' })
  @ApiResponseDoc({ status: 200, type: ComplianceDashboardEntity })
  getDashboard(): Promise<ComplianceDashboardEntity> {
    return this.complianceDashboardService.getDashboard();
  }
}
