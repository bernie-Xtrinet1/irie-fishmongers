import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateRegulatoryAuthorityDto } from '../dto/create-regulatory-authority.dto';
import { RegulatoryAuthorityResponseEntity } from '../entities/regulatory-authority-response.entity';
import { RegulatoryAuthoritiesService } from '../services/regulatory-authorities.service';

@ApiTags('compliance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('food-safety/authorities')
export class RegulatoryAuthoritiesController {
  constructor(private readonly authoritiesService: RegulatoryAuthoritiesService) {}

  @Post()
  @ApiOperation({ summary: 'Register a regulatory authority (admin only)' })
  @ApiResponseDoc({ status: 201, type: RegulatoryAuthorityResponseEntity })
  create(@Body() dto: CreateRegulatoryAuthorityDto): Promise<RegulatoryAuthorityResponseEntity> {
    return this.authoritiesService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List regulatory authorities (admin only)' })
  @ApiResponseDoc({ status: 200, type: RegulatoryAuthorityResponseEntity, isArray: true })
  list(): Promise<RegulatoryAuthorityResponseEntity[]> {
    return this.authoritiesService.list();
  }
}
