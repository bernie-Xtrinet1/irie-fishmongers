import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ListUpgradeRequestsDto } from '../dto/list-upgrade-requests.dto';
import { ReviewUpgradeRequestDto } from '../dto/review-upgrade-request.dto';
import { PaginatedUpgradeRequestsEntity } from '../entities/paginated-upgrade-requests.entity';
import { VendorUpgradeRequestResponseEntity } from '../entities/vendor-upgrade-request-response.entity';
import { VendorTiersService } from '../services/vendor-tiers.service';

@ApiTags('vendor-tiers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('tier-upgrade-requests')
export class TierUpgradeRequestsController {
  constructor(private readonly vendorTiersService: VendorTiersService) {}

  @Get()
  @ApiOperation({ summary: 'List vendor tier upgrade requests, optionally filtered by status (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedUpgradeRequestsEntity })
  list(@Query() dto: ListUpgradeRequestsDto): Promise<PaginatedUpgradeRequestsEntity> {
    return this.vendorTiersService.listUpgradeRequests(dto);
  }

  @Patch(':id/review')
  @ApiOperation({ summary: 'Approve or reject a vendor tier upgrade request (admin only)' })
  @ApiResponseDoc({ status: 200, type: VendorUpgradeRequestResponseEntity })
  review(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: ReviewUpgradeRequestDto,
  ): Promise<VendorUpgradeRequestResponseEntity> {
    return this.vendorTiersService.reviewUpgradeRequest(user.id, id, dto);
  }
}
