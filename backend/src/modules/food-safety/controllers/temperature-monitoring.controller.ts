import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateTemperatureReadingDto } from '../dto/create-temperature-reading.dto';
import { ListTemperatureAlertsDto } from '../dto/list-temperature-alerts.dto';
import { PaginatedTemperatureAlertsEntity } from '../entities/paginated-temperature-alerts.entity';
import { PaginatedTemperatureReadingsEntity } from '../entities/paginated-temperature-readings.entity';
import { RecordReadingResultEntity } from '../entities/record-reading-result.entity';
import { TemperatureAlertResponseEntity } from '../entities/temperature-alert-response.entity';
import { TemperatureMonitoringService } from '../services/temperature-monitoring.service';

@ApiTags('temperature-monitoring')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class TemperatureMonitoringController {
  constructor(private readonly temperatureMonitoringService: TemperatureMonitoringService) {}

  @Post('temperature-readings')
  @Roles(RoleName.VENDOR, RoleName.DRIVER)
  @ApiOperation({ summary: 'Record a temperature reading for a seafood lot' })
  @ApiResponseDoc({ status: 201, type: RecordReadingResultEntity })
  recordReading(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateTemperatureReadingDto,
  ): Promise<RecordReadingResultEntity> {
    return this.temperatureMonitoringService.recordReading(user.id, dto);
  }

  @Get('temperature-readings/lot/:lotId')
  @Roles(RoleName.VENDOR, RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Get the temperature reading history for a lot (owning vendor or admin)' })
  @ApiResponseDoc({ status: 200, type: PaginatedTemperatureReadingsEntity })
  getReadingsForLot(
    @CurrentUser() user: RequestUser,
    @Param('lotId') lotId: string,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedTemperatureReadingsEntity> {
    return this.temperatureMonitoringService.getReadingsForLot(user, lotId, dto);
  }

  @Get('temperature-alerts')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'List temperature alerts, optionally filtered (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedTemperatureAlertsEntity })
  listAlerts(@Query() dto: ListTemperatureAlertsDto): Promise<PaginatedTemperatureAlertsEntity> {
    return this.temperatureMonitoringService.listAlerts(dto);
  }

  @Patch('temperature-alerts/:id/resolve')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Mark a temperature alert as resolved (admin only)' })
  @ApiResponseDoc({ status: 200, type: TemperatureAlertResponseEntity })
  resolveAlert(@Param('id') id: string): Promise<TemperatureAlertResponseEntity> {
    return this.temperatureMonitoringService.resolveAlert(id);
  }
}
