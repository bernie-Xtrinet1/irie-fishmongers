import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateRegulatoryCertificationDto } from '../dto/create-regulatory-certification.dto';
import { ListRegulatoryCertificationsDto } from '../dto/list-regulatory-certifications.dto';
import { UpdateRegulatoryCertificationDto } from '../dto/update-regulatory-certification.dto';
import { PaginatedRegulatoryCertificationsEntity } from '../entities/paginated-regulatory-certifications.entity';
import { RegulatoryCertificationResponseEntity } from '../entities/regulatory-certification-response.entity';
import { RegulatoryCertificationsService } from '../services/regulatory-certifications.service';

@ApiTags('compliance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('food-safety/certifications')
export class RegulatoryCertificationsController {
  constructor(private readonly certificationsService: RegulatoryCertificationsService) {}

  @Post()
  @ApiOperation({ summary: 'Register a regulatory certification for a vendor, fisherman, or landing site (admin only)' })
  @ApiResponseDoc({ status: 201, type: RegulatoryCertificationResponseEntity })
  create(@Body() dto: CreateRegulatoryCertificationDto): Promise<RegulatoryCertificationResponseEntity> {
    return this.certificationsService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List regulatory certifications, syncing lapsed EXPIRED status on read (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedRegulatoryCertificationsEntity })
  list(@Query() dto: ListRegulatoryCertificationsDto): Promise<PaginatedRegulatoryCertificationsEntity> {
    return this.certificationsService.list(dto);
  }

  @Patch(':id/activate')
  @ApiOperation({ summary: 'Move a PENDING certification to ACTIVE (admin only)' })
  @ApiResponseDoc({ status: 200, type: RegulatoryCertificationResponseEntity })
  activate(@Param('id') id: string): Promise<RegulatoryCertificationResponseEntity> {
    return this.certificationsService.activate(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Renew, suspend, reinstate, or revoke a certification (admin only)' })
  @ApiResponseDoc({ status: 200, type: RegulatoryCertificationResponseEntity })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRegulatoryCertificationDto,
  ): Promise<RegulatoryCertificationResponseEntity> {
    return this.certificationsService.update(id, dto);
  }
}
