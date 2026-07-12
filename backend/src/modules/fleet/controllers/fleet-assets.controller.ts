import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateFleetAssetDto } from '../dto/create-fleet-asset.dto';
import { CreateFleetMaintenanceDto } from '../dto/create-fleet-maintenance.dto';
import { CreateFleetSanitationRecordDto } from '../dto/create-fleet-sanitation-record.dto';
import { ListFleetAssetsDto } from '../dto/list-fleet-assets.dto';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { UpdateFleetAssetDto } from '../dto/update-fleet-asset.dto';
import { FleetAssetResponseEntity } from '../entities/fleet-asset-response.entity';
import { FleetMaintenanceResponseEntity } from '../entities/fleet-maintenance-response.entity';
import { FleetSanitationRecordResponseEntity } from '../entities/fleet-sanitation-record-response.entity';
import { FleetZoneSummaryEntity } from '../entities/fleet-zone-summary.entity';
import { PaginatedFleetAssetsEntity } from '../entities/paginated-fleet-assets.entity';
import { PaginatedFleetMaintenanceEntity } from '../entities/paginated-fleet-maintenance.entity';
import { PaginatedFleetSanitationRecordsEntity } from '../entities/paginated-fleet-sanitation-records.entity';
import { FleetAssetsService } from '../services/fleet-assets.service';
import { FleetMaintenanceService } from '../services/fleet-maintenance.service';
import { FleetSanitationRecordsService } from '../services/fleet-sanitation-records.service';

@ApiTags('fleet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('fleet-assets')
export class FleetAssetsController {
  constructor(
    private readonly fleetAssetsService: FleetAssetsService,
    private readonly fleetMaintenanceService: FleetMaintenanceService,
    private readonly fleetSanitationRecordsService: FleetSanitationRecordsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Register a fleet asset (admin only)' })
  @ApiResponseDoc({ status: 201, type: FleetAssetResponseEntity })
  create(@Body() dto: CreateFleetAssetDto): Promise<FleetAssetResponseEntity> {
    return this.fleetAssetsService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List fleet assets, optionally filtered by zone or status (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedFleetAssetsEntity })
  list(@Query() dto: ListFleetAssetsDto): Promise<PaginatedFleetAssetsEntity> {
    return this.fleetAssetsService.list(dto);
  }

  @Get('zone-summary')
  @ApiOperation({
    summary: '10D fleet/zone rollup: asset counts per zone by status (admin only)',
  })
  @ApiResponseDoc({ status: 200, type: FleetZoneSummaryEntity, isArray: true })
  getZoneSummary(): Promise<FleetZoneSummaryEntity[]> {
    return this.fleetAssetsService.getZoneSummary();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a fleet asset by id (admin only)' })
  @ApiResponseDoc({ status: 200, type: FleetAssetResponseEntity })
  findById(@Param('id') id: string): Promise<FleetAssetResponseEntity> {
    return this.fleetAssetsService.findById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a fleet asset status, assigned driver, or cold-chain capability (admin only)' })
  @ApiResponseDoc({ status: 200, type: FleetAssetResponseEntity })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateFleetAssetDto,
  ): Promise<FleetAssetResponseEntity> {
    return this.fleetAssetsService.update(id, dto);
  }

  @Post(':id/maintenance')
  @ApiOperation({ summary: 'Record a maintenance event for a fleet asset (admin only)' })
  @ApiResponseDoc({ status: 201, type: FleetMaintenanceResponseEntity })
  createMaintenance(
    @Param('id') id: string,
    @Body() dto: CreateFleetMaintenanceDto,
  ): Promise<FleetMaintenanceResponseEntity> {
    return this.fleetMaintenanceService.create(id, dto);
  }

  @Get(':id/maintenance')
  @ApiOperation({ summary: 'List maintenance records for a fleet asset (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedFleetMaintenanceEntity })
  listMaintenance(
    @Param('id') id: string,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedFleetMaintenanceEntity> {
    return this.fleetMaintenanceService.findByFleetAssetId(id, dto);
  }

  @Post(':id/sanitation')
  @ApiOperation({
    summary: '10E: record a cold-chain sanitation event for a fleet asset (admin only)',
  })
  @ApiResponseDoc({ status: 201, type: FleetSanitationRecordResponseEntity })
  createSanitationRecord(
    @Param('id') id: string,
    @Body() dto: CreateFleetSanitationRecordDto,
  ): Promise<FleetSanitationRecordResponseEntity> {
    return this.fleetSanitationRecordsService.create(id, dto);
  }

  @Get(':id/sanitation')
  @ApiOperation({ summary: '10E: list sanitation records for a fleet asset (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedFleetSanitationRecordsEntity })
  listSanitationRecords(
    @Param('id') id: string,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedFleetSanitationRecordsEntity> {
    return this.fleetSanitationRecordsService.findByFleetAssetId(id, dto);
  }
}
