import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { RegisterVesselDto } from '../dto/register-vessel.dto';
import { UpdateVesselStatusDto } from '../dto/update-vessel-status.dto';
import { PaginatedVesselsEntity } from '../entities/paginated-vessels.entity';
import { VesselResponseEntity } from '../entities/vessel-response.entity';
import { VesselsService } from '../services/vessels.service';

@ApiTags('vessels')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('vessels')
export class VesselsController {
  constructor(private readonly vesselsService: VesselsService) {}

  @Post()
  @Roles(RoleName.FISHERMAN)
  @ApiOperation({ summary: "Register a vessel for the authenticated, approved fisherman's own registry" })
  @ApiResponseDoc({ status: 201, type: VesselResponseEntity })
  register(
    @CurrentUser() user: RequestUser,
    @Body() dto: RegisterVesselDto,
  ): Promise<VesselResponseEntity> {
    return this.vesselsService.register(user.id, dto);
  }

  @Get('mine')
  @Roles(RoleName.FISHERMAN)
  @ApiOperation({ summary: "List the authenticated fisherman's vessels" })
  @ApiResponseDoc({ status: 200, type: PaginatedVesselsEntity })
  getMine(
    @CurrentUser() user: RequestUser,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedVesselsEntity> {
    return this.vesselsService.getMine(user.id, dto);
  }

  @Get()
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'List all registered vessels (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedVesselsEntity })
  list(@Query() dto: PaginationDto): Promise<PaginatedVesselsEntity> {
    return this.vesselsService.list(dto);
  }

  @Patch(':id/status')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Activate, deactivate, or decommission a vessel registration (admin only)' })
  @ApiResponseDoc({ status: 200, type: VesselResponseEntity })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateVesselStatusDto,
  ): Promise<VesselResponseEntity> {
    return this.vesselsService.updateStatus(id, dto.status);
  }
}
