import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateAdjustmentDto } from '../dto/create-adjustment.dto';
import { CreateCommissionRateDto } from '../dto/create-commission-rate.dto';
import { ListVendorSettlementsDto } from '../dto/list-vendor-settlements.dto';
import { UpdateVendorSettlementStatusDto } from '../dto/update-vendor-settlement-status.dto';
import { AdjustmentResponseEntity } from '../entities/adjustment-response.entity';
import { CommissionRateResponseEntity } from '../entities/commission-rate-response.entity';
import { GenerateVendorSettlementsResultEntity } from '../entities/generate-vendor-settlements-result.entity';
import { PaginatedVendorSettlementsEntity } from '../entities/paginated-vendor-settlements.entity';
import { VendorSettlementResponseEntity } from '../entities/vendor-settlement-response.entity';
import { VendorSettlementsService } from '../services/vendor-settlements.service';

@ApiTags('vendor-settlements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('vendor-settlements')
export class VendorSettlementsController {
  constructor(private readonly vendorSettlementsService: VendorSettlementsService) {}

  @Post('generate')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Generate settlements for all currently-eligible vendor orders (admin only)' })
  @ApiResponseDoc({ status: 201, type: GenerateVendorSettlementsResultEntity })
  generate(): Promise<GenerateVendorSettlementsResultEntity> {
    return this.vendorSettlementsService.generateSettlements();
  }

  @Get('mine')
  @Roles(RoleName.VENDOR)
  @ApiOperation({ summary: "List the authenticated vendor's settlements" })
  @ApiResponseDoc({ status: 200, type: PaginatedVendorSettlementsEntity })
  getMine(
    @CurrentUser() user: RequestUser,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedVendorSettlementsEntity> {
    return this.vendorSettlementsService.getMine(user.id, dto);
  }

  @Get()
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'List vendor settlements, optionally filtered (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedVendorSettlementsEntity })
  list(@Query() dto: ListVendorSettlementsDto): Promise<PaginatedVendorSettlementsEntity> {
    return this.vendorSettlementsService.list(dto);
  }

  @Patch(':id/status')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Approve, pay, or fail a settlement (admin only)' })
  @ApiResponseDoc({ status: 200, type: VendorSettlementResponseEntity })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateVendorSettlementStatusDto,
  ): Promise<VendorSettlementResponseEntity> {
    return this.vendorSettlementsService.updateStatus(id, dto.status, dto.notes);
  }

  @Post(':id/adjustments')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({
    summary: 'Record a manual adjustment against a settlement, e.g. following a refund (admin only)',
  })
  @ApiResponseDoc({ status: 201, type: AdjustmentResponseEntity })
  createAdjustment(
    @Param('id') id: string,
    @Body() dto: CreateAdjustmentDto,
  ): Promise<AdjustmentResponseEntity> {
    return this.vendorSettlementsService.createAdjustment(id, dto);
  }

  @Get('commission-rate')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Get the current platform commission rate (admin only)' })
  @ApiResponseDoc({ status: 200, type: CommissionRateResponseEntity })
  getCommissionRate(): Promise<CommissionRateResponseEntity> {
    return this.vendorSettlementsService.getCurrentCommissionRate();
  }

  @Post('commission-rate')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Publish a new platform commission rate (admin only)' })
  @ApiResponseDoc({ status: 201, type: CommissionRateResponseEntity })
  createCommissionRate(
    @Body() dto: CreateCommissionRateDto,
  ): Promise<CommissionRateResponseEntity> {
    return this.vendorSettlementsService.createCommissionRate(dto);
  }
}
