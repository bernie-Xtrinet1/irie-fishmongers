import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateRateConfigDto } from '../dto/create-rate-config.dto';
import { GenerateSettlementsDto } from '../dto/generate-settlements.dto';
import { ListDriverSettlementsDto } from '../dto/list-driver-settlements.dto';
import { UpdateSettlementStatusDto } from '../dto/update-settlement-status.dto';
import { DriverSettlementResponseEntity } from '../entities/driver-settlement-response.entity';
import { GenerateSettlementsResultEntity } from '../entities/generate-settlements-result.entity';
import { PaginatedDriverSettlementsEntity } from '../entities/paginated-driver-settlements.entity';
import { RateConfigResponseEntity } from '../entities/rate-config-response.entity';
import { DriverSettlementsService } from '../services/driver-settlements.service';

@ApiTags('driver-settlements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('driver-settlements')
export class DriverSettlementsController {
  constructor(private readonly driverSettlementsService: DriverSettlementsService) {}

  @Post('generate')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Generate driver settlements for a weekly period (admin only)' })
  @ApiResponseDoc({ status: 201, type: GenerateSettlementsResultEntity })
  generate(@Body() dto: GenerateSettlementsDto): Promise<GenerateSettlementsResultEntity> {
    return this.driverSettlementsService.generateWeeklySettlements(dto.weekStart);
  }

  @Get('mine')
  @Roles(RoleName.DRIVER)
  @ApiOperation({ summary: "List the authenticated driver's settlements" })
  @ApiResponseDoc({ status: 200, type: PaginatedDriverSettlementsEntity })
  getMine(
    @CurrentUser() user: RequestUser,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedDriverSettlementsEntity> {
    return this.driverSettlementsService.getMine(user.id, dto);
  }

  @Get()
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'List driver settlements, optionally filtered (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedDriverSettlementsEntity })
  list(@Query() dto: ListDriverSettlementsDto): Promise<PaginatedDriverSettlementsEntity> {
    return this.driverSettlementsService.list(dto);
  }

  @Patch(':id/status')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Approve, pay, fail, or dispute a settlement (admin only)' })
  @ApiResponseDoc({ status: 200, type: DriverSettlementResponseEntity })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateSettlementStatusDto,
  ): Promise<DriverSettlementResponseEntity> {
    return this.driverSettlementsService.updateStatus(id, dto.status, dto.notes);
  }

  @Get('rate-config')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Get the current settlement rate configuration (admin only)' })
  @ApiResponseDoc({ status: 200, type: RateConfigResponseEntity })
  getRateConfig(): Promise<RateConfigResponseEntity> {
    return this.driverSettlementsService.getCurrentRateConfig();
  }

  @Post('rate-config')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Publish a new settlement rate configuration (admin only)' })
  @ApiResponseDoc({ status: 201, type: RateConfigResponseEntity })
  createRateConfig(@Body() dto: CreateRateConfigDto): Promise<RateConfigResponseEntity> {
    return this.driverSettlementsService.createRateConfig(dto);
  }
}
