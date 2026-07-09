import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ListFishermenDto } from '../dto/list-fishermen.dto';
import { RegisterFishermanDto } from '../dto/register-fisherman.dto';
import { UpdateFishermanStatusDto } from '../dto/update-fisherman-status.dto';
import { FishermanResponseEntity } from '../entities/fisherman-response.entity';
import { PaginatedFishermenEntity } from '../entities/paginated-fishermen.entity';
import { FishermenService } from '../services/fishermen.service';

@ApiTags('fishermen')
@Controller('fishermen')
export class FishermenController {
  constructor(private readonly fishermenService: FishermenService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.FISHERMAN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Register a fisherman profile for the authenticated account' })
  @ApiResponseDoc({ status: 201, type: FishermanResponseEntity })
  register(
    @CurrentUser() user: RequestUser,
    @Body() dto: RegisterFishermanDto,
  ): Promise<FishermanResponseEntity> {
    return this.fishermenService.register(user.id, dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.FISHERMAN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the authenticated user's fisherman profile" })
  @ApiResponseDoc({ status: 200, type: FishermanResponseEntity })
  getOwnProfile(@CurrentUser() user: RequestUser): Promise<FishermanResponseEntity> {
    return this.fishermenService.getOwnProfile(user.id);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List fishermen, optionally filtered by status (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedFishermenEntity })
  list(@Query() dto: ListFishermenDto): Promise<PaginatedFishermenEntity> {
    return this.fishermenService.list(dto);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Approve, suspend, or reject a fisherman (admin only)' })
  @ApiResponseDoc({ status: 200, type: FishermanResponseEntity })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateFishermanStatusDto,
  ): Promise<FishermanResponseEntity> {
    return this.fishermenService.updateStatus(id, dto.status);
  }
}
