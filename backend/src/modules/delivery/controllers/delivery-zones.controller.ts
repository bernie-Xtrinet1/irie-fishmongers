import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { DeliveryZone, RoleName } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateDeliveryZoneDto } from '../dto/create-delivery-zone.dto';
import { ResolveZoneDto } from '../dto/resolve-zone.dto';
import { UpdateDeliveryZoneDto } from '../dto/update-delivery-zone.dto';
import { DeliveryZoneResponseEntity } from '../entities/delivery-zone-response.entity';
import { ResolvedZoneEntity } from '../entities/resolved-zone.entity';
import { DeliveryZonesService } from '../services/delivery-zones.service';
import { ZoneResolutionService } from '../services/zone-resolution.service';

@ApiTags('delivery-zones')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('delivery-zones')
export class DeliveryZonesController {
  constructor(
    private readonly deliveryZonesService: DeliveryZonesService,
    private readonly zoneResolutionService: ZoneResolutionService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List delivery zones (registration-form zone pickers, dispatch views)' })
  @ApiResponseDoc({ status: 200, type: DeliveryZoneResponseEntity, isArray: true })
  list(): Promise<DeliveryZone[]> {
    return this.deliveryZonesService.list();
  }

  @Get('resolve')
  @ApiOperation({ summary: 'Resolve the delivery zone mapped to a given parish' })
  @ApiResponseDoc({ status: 200, type: ResolvedZoneEntity })
  async resolve(@Query() dto: ResolveZoneDto): Promise<ResolvedZoneEntity> {
    const zoneId = await this.zoneResolutionService.resolveZoneForParish(dto.parish);
    return { zoneId };
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Create a delivery zone (admin only)' })
  @ApiResponseDoc({ status: 201, type: DeliveryZoneResponseEntity })
  create(@Body() dto: CreateDeliveryZoneDto): Promise<DeliveryZone> {
    return this.deliveryZonesService.create(dto);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Update a delivery zone (admin only)' })
  @ApiResponseDoc({ status: 200, type: DeliveryZoneResponseEntity })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDeliveryZoneDto,
  ): Promise<DeliveryZone> {
    return this.deliveryZonesService.update(id, dto);
  }
}
