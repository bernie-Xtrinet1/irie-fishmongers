import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName, TemperatureThreshold } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateTemperatureThresholdDto } from '../dto/create-temperature-threshold.dto';
import { UpdateTemperatureThresholdDto } from '../dto/update-temperature-threshold.dto';
import { TemperatureThresholdResponseEntity } from '../entities/temperature-threshold-response.entity';
import { TemperatureThresholdsService } from '../services/temperature-thresholds.service';

@ApiTags('temperature-thresholds')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('temperature-thresholds')
export class TemperatureThresholdsController {
  constructor(private readonly thresholdsService: TemperatureThresholdsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a device-specific or platform-default temperature threshold (admin only)' })
  @ApiResponseDoc({ status: 201, type: TemperatureThresholdResponseEntity })
  create(@Body() dto: CreateTemperatureThresholdDto): Promise<TemperatureThreshold> {
    return this.thresholdsService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List temperature thresholds (admin only)' })
  @ApiResponseDoc({ status: 200, type: TemperatureThresholdResponseEntity, isArray: true })
  list(): Promise<TemperatureThreshold[]> {
    return this.thresholdsService.list();
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a temperature threshold (admin only)' })
  @ApiResponseDoc({ status: 200, type: TemperatureThresholdResponseEntity })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTemperatureThresholdDto,
  ): Promise<TemperatureThreshold> {
    return this.thresholdsService.update(id, dto);
  }
}
