import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateQualityInspectionDto } from '../dto/create-quality-inspection.dto';
import { PaginatedQualityInspectionsEntity } from '../entities/paginated-quality-inspections.entity';
import { QualityInspectionResponseEntity } from '../entities/quality-inspection-response.entity';
import { QualityInspectionsService } from '../services/quality-inspections.service';

@ApiTags('quality-inspections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('quality-inspections')
export class QualityInspectionsController {
  constructor(private readonly qualityInspectionsService: QualityInspectionsService) {}

  @Post()
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Record a quality inspection for a seafood lot (admin only)' })
  @ApiResponseDoc({ status: 201, type: QualityInspectionResponseEntity })
  inspect(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateQualityInspectionDto,
  ): Promise<QualityInspectionResponseEntity> {
    return this.qualityInspectionsService.inspect(user.id, dto);
  }

  @Get('lot/:lotId')
  @Roles(RoleName.VENDOR, RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Get the inspection history for a lot (owning vendor or admin)' })
  @ApiResponseDoc({ status: 200, type: PaginatedQualityInspectionsEntity })
  getForLot(
    @CurrentUser() user: RequestUser,
    @Param('lotId') lotId: string,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedQualityInspectionsEntity> {
    return this.qualityInspectionsService.getForLot(user, lotId, dto);
  }
}
