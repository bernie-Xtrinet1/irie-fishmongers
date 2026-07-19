import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Request } from 'express';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateIncidentDto } from '../dto/create-incident.dto';
import { ListIncidentsDto } from '../dto/list-incidents.dto';
import { UpdateIncidentStatusDto } from '../dto/update-incident-status.dto';
import { IncidentResponseEntity } from '../entities/incident-response.entity';
import { PaginatedIncidentsEntity } from '../entities/paginated-incidents.entity';
import { FoodSafetyIncidentsService } from '../services/food-safety-incidents.service';

@ApiTags('food-safety-incidents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('food-safety-incidents')
export class FoodSafetyIncidentsController {
  constructor(private readonly incidentsService: FoodSafetyIncidentsService) {}

  @Post()
  @Roles(RoleName.VENDOR, RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Report a food safety incident for a lot (owning vendor or admin)' })
  @ApiResponseDoc({ status: 201, type: IncidentResponseEntity })
  report(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateIncidentDto,
  ): Promise<IncidentResponseEntity> {
    return this.incidentsService.report(user, dto);
  }

  @Get('lot/:lotId')
  @Roles(RoleName.VENDOR, RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Get the incident history for a lot (owning vendor or admin)' })
  @ApiResponseDoc({ status: 200, type: PaginatedIncidentsEntity })
  getForLot(
    @CurrentUser() user: RequestUser,
    @Param('lotId') lotId: string,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedIncidentsEntity> {
    return this.incidentsService.getForLot(user, lotId, dto);
  }

  @Get()
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'List food safety incidents, optionally filtered (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedIncidentsEntity })
  list(@Query() dto: ListIncidentsDto): Promise<PaginatedIncidentsEntity> {
    return this.incidentsService.list(dto);
  }

  @Patch(':id/status')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Investigate, resolve, or close a food safety incident (admin only)' })
  @ApiResponseDoc({ status: 200, type: IncidentResponseEntity })
  updateStatus(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateIncidentStatusDto,
    @Req() req: Request,
  ): Promise<IncidentResponseEntity> {
    return this.incidentsService.updateStatus(user.id, id, dto.status, dto.correctiveAction, req.ip);
  }
}
