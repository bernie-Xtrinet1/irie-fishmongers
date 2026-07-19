import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateSpeciesDto } from '../dto/create-species.dto';
import { UpdateSpeciesDto } from '../dto/update-species.dto';
import { SpeciesResponseEntity } from '../entities/species-response.entity';
import { SpeciesService } from '../services/species.service';

@ApiTags('species')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('species')
export class SpeciesController {
  constructor(private readonly speciesService: SpeciesService) {}

  @Get()
  @ApiOperation({ summary: 'List managed species (registration-form picker)' })
  @ApiResponseDoc({ status: 200, type: SpeciesResponseEntity, isArray: true })
  list(): Promise<SpeciesResponseEntity[]> {
    return this.speciesService.list();
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Register a managed species (admin only)' })
  @ApiResponseDoc({ status: 201, type: SpeciesResponseEntity })
  create(@Body() dto: CreateSpeciesDto): Promise<SpeciesResponseEntity> {
    return this.speciesService.create(dto);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Update a managed species (admin only)' })
  @ApiResponseDoc({ status: 200, type: SpeciesResponseEntity })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSpeciesDto,
  ): Promise<SpeciesResponseEntity> {
    return this.speciesService.update(id, dto);
  }
}
