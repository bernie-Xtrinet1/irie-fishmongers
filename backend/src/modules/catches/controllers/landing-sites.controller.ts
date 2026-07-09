import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateLandingSiteDto } from '../dto/create-landing-site.dto';
import { UpdateLandingSiteDto } from '../dto/update-landing-site.dto';
import { LandingSiteResponseEntity } from '../entities/landing-site-response.entity';
import { LandingSitesService } from '../services/landing-sites.service';

@ApiTags('landing-sites')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('landing-sites')
export class LandingSitesController {
  constructor(private readonly landingSitesService: LandingSitesService) {}

  @Get()
  @ApiOperation({ summary: 'List active landing sites (registration-form picker)' })
  @ApiResponseDoc({ status: 200, type: LandingSiteResponseEntity, isArray: true })
  list(): Promise<LandingSiteResponseEntity[]> {
    return this.landingSitesService.list();
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Register a landing site (admin only)' })
  @ApiResponseDoc({ status: 201, type: LandingSiteResponseEntity })
  create(@Body() dto: CreateLandingSiteDto): Promise<LandingSiteResponseEntity> {
    return this.landingSitesService.create(dto);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Update a landing site (admin only)' })
  @ApiResponseDoc({ status: 200, type: LandingSiteResponseEntity })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLandingSiteDto,
  ): Promise<LandingSiteResponseEntity> {
    return this.landingSitesService.update(id, dto);
  }
}
