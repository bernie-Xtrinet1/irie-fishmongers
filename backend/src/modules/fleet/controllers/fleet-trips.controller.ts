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
import { CreateFleetTripDto } from '../dto/create-fleet-trip.dto';
import { ListFleetTripsDto } from '../dto/list-fleet-trips.dto';
import { UpdateFleetTripDto } from '../dto/update-fleet-trip.dto';
import { FleetTripResponseEntity } from '../entities/fleet-trip-response.entity';
import { PaginatedFleetTripsEntity } from '../entities/paginated-fleet-trips.entity';
import { FleetTripsService } from '../services/fleet-trips.service';

@ApiTags('fleet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('fleet-trips')
export class FleetTripsController {
  constructor(private readonly fleetTripsService: FleetTripsService) {}

  @Post()
  @ApiOperation({ summary: 'Record a fleet trip (admin only)' })
  @ApiResponseDoc({ status: 201, type: FleetTripResponseEntity })
  create(@Body() dto: CreateFleetTripDto): Promise<FleetTripResponseEntity> {
    return this.fleetTripsService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List fleet trips, optionally filtered by asset or driver (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedFleetTripsEntity })
  list(@Query() dto: ListFleetTripsDto): Promise<PaginatedFleetTripsEntity> {
    return this.fleetTripsService.list(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a fleet trip by id (admin only)' })
  @ApiResponseDoc({ status: 200, type: FleetTripResponseEntity })
  findById(@Param('id') id: string): Promise<FleetTripResponseEntity> {
    return this.fleetTripsService.findById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a fleet trip end time or cost fields (admin only)' })
  @ApiResponseDoc({ status: 200, type: FleetTripResponseEntity })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateFleetTripDto,
  ): Promise<FleetTripResponseEntity> {
    return this.fleetTripsService.update(id, dto);
  }
}
