import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ListCatchesDto } from '../dto/list-catches.dto';
import { RegisterCatchDto } from '../dto/register-catch.dto';
import { CatchResponseEntity } from '../entities/catch-response.entity';
import { PaginatedCatchesEntity } from '../entities/paginated-catches.entity';
import { CatchesService } from '../services/catches.service';

@ApiTags('catches')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('catches')
export class CatchesController {
  constructor(private readonly catchesService: CatchesService) {}

  @Post()
  @Roles(RoleName.FISHERMAN)
  @ApiOperation({ summary: 'Register a catch for the authenticated, approved fisherman' })
  @ApiResponseDoc({ status: 201, type: CatchResponseEntity })
  register(
    @CurrentUser() user: RequestUser,
    @Body() dto: RegisterCatchDto,
  ): Promise<CatchResponseEntity> {
    return this.catchesService.register(user.id, dto);
  }

  @Get('mine')
  @Roles(RoleName.FISHERMAN)
  @ApiOperation({ summary: "List the authenticated fisherman's catches" })
  @ApiResponseDoc({ status: 200, type: PaginatedCatchesEntity })
  getMine(
    @CurrentUser() user: RequestUser,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedCatchesEntity> {
    return this.catchesService.getMine(user.id, dto);
  }

  @Get()
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'List catches, optionally filtered by fisherman (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedCatchesEntity })
  list(@Query() dto: ListCatchesDto): Promise<PaginatedCatchesEntity> {
    return this.catchesService.list(dto);
  }

  @Get(':id')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Get a catch by id (admin only)' })
  @ApiResponseDoc({ status: 200, type: CatchResponseEntity })
  getById(@Param('id') id: string): Promise<CatchResponseEntity> {
    return this.catchesService.getById(id);
  }
}
