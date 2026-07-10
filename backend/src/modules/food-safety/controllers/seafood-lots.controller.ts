import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Request } from 'express';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateSeafoodLotDto } from '../dto/create-seafood-lot.dto';
import { ListSeafoodLotsDto } from '../dto/list-seafood-lots.dto';
import { UpdateLotStatusDto } from '../dto/update-lot-status.dto';
import { PaginatedSeafoodLotsEntity } from '../entities/paginated-seafood-lots.entity';
import { SeafoodLotPublicEntity } from '../entities/seafood-lot-public.entity';
import { SeafoodLotResponseEntity } from '../entities/seafood-lot-response.entity';
import { SeafoodLotsService } from '../services/seafood-lots.service';

@ApiTags('seafood-lots')
@Controller('seafood-lots')
export class SeafoodLotsController {
  constructor(private readonly seafoodLotsService: SeafoodLotsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.VENDOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Register a new seafood lot for the authenticated vendor' })
  @ApiResponseDoc({ status: 201, type: SeafoodLotResponseEntity })
  register(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateSeafoodLotDto,
  ): Promise<SeafoodLotResponseEntity> {
    return this.seafoodLotsService.register(user.id, dto);
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.VENDOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the authenticated vendor's seafood lots" })
  @ApiResponseDoc({ status: 200, type: PaginatedSeafoodLotsEntity })
  getMine(
    @CurrentUser() user: RequestUser,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedSeafoodLotsEntity> {
    return this.seafoodLotsService.getMine(user.id, dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List seafood lots, optionally filtered (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedSeafoodLotsEntity })
  list(@Query() dto: ListSeafoodLotsDto): Promise<PaginatedSeafoodLotsEntity> {
    return this.seafoodLotsService.list(dto);
  }

  @Get(':id/public')
  @ApiOperation({ summary: 'Get the customer-facing traceability view of a seafood lot' })
  @ApiResponseDoc({ status: 200, type: SeafoodLotPublicEntity })
  getPublic(@Param('id') id: string): Promise<SeafoodLotPublicEntity> {
    return this.seafoodLotsService.getPublicById(id);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a seafood lot by id (admin only)' })
  @ApiResponseDoc({ status: 200, type: SeafoodLotResponseEntity })
  getById(@Param('id') id: string): Promise<SeafoodLotResponseEntity> {
    return this.seafoodLotsService.getById(id);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Place a lot on hold/quarantine or clear it (admin only)' })
  @ApiResponseDoc({ status: 200, type: SeafoodLotResponseEntity })
  updateStatus(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateLotStatusDto,
    @Req() req: Request,
  ): Promise<SeafoodLotResponseEntity> {
    return this.seafoodLotsService.updateStatus(user.id, id, dto.status, dto.reason, req.ip);
  }
}
