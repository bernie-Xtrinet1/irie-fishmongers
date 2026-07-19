import { Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ListSLABreachesDto } from '../dto/list-sla-breaches.dto';
import { PaginatedSLABreachesEntity } from '../entities/paginated-sla-breaches.entity';
import { SLABreachResponseEntity } from '../entities/sla-breach-response.entity';
import { ZoneBreachSummaryEntity } from '../entities/zone-breach-summary.entity';
import { SLABreachesService } from '../services/sla-breaches.service';

@ApiTags('sla-breaches')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('sla-breaches')
export class SLABreachesController {
  constructor(private readonly slaBreachesService: SLABreachesService) {}

  @Get()
  @ApiOperation({
    summary: 'List SLA breaches, optionally filtered by resolution status or type (admin only)',
  })
  @ApiResponseDoc({ status: 200, type: PaginatedSLABreachesEntity })
  list(@Query() dto: ListSLABreachesDto): Promise<PaginatedSLABreachesEntity> {
    return this.slaBreachesService.list(dto);
  }

  @Get('zone-summary')
  @ApiOperation({
    summary: '10D fleet/zone rollup: SLA breach counts per zone (admin only)',
  })
  @ApiResponseDoc({ status: 200, type: ZoneBreachSummaryEntity, isArray: true })
  getZoneSummary(): Promise<ZoneBreachSummaryEntity[]> {
    return this.slaBreachesService.getZoneSummary();
  }

  @Patch(':id/resolve')
  @ApiOperation({ summary: 'Mark an SLA breach resolved (admin only)' })
  @ApiResponseDoc({ status: 200, type: SLABreachResponseEntity })
  resolve(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<SLABreachResponseEntity> {
    return this.slaBreachesService.resolve(id, user.id);
  }
}
