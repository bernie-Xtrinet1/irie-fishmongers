import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { DowngradeVendorDto } from '../dto/downgrade-vendor.dto';
import { RequestTierUpgradeDto } from '../dto/request-tier-upgrade.dto';
import { PaginatedDowngradeEventsEntity } from '../entities/paginated-downgrade-events.entity';
import { VendorDowngradeEventResponseEntity } from '../entities/vendor-downgrade-event-response.entity';
import { VendorUpgradeRequestResponseEntity } from '../entities/vendor-upgrade-request-response.entity';
import { VendorTiersService } from '../services/vendor-tiers.service';

@ApiTags('vendor-tiers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('vendors')
export class VendorTiersController {
  constructor(private readonly vendorTiersService: VendorTiersService) {}

  @Post('me/tier-upgrade-requests')
  @Roles(RoleName.VENDOR)
  @ApiOperation({ summary: 'Request a tier upgrade for the authenticated vendor' })
  @ApiResponseDoc({ status: 201, type: VendorUpgradeRequestResponseEntity })
  requestUpgrade(
    @CurrentUser() user: RequestUser,
    @Body() dto: RequestTierUpgradeDto,
  ): Promise<VendorUpgradeRequestResponseEntity> {
    return this.vendorTiersService.requestUpgrade(user.id, dto);
  }

  @Post(':id/downgrade')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Downgrade a vendor to a lower tier (admin only)' })
  @ApiResponseDoc({ status: 201, type: VendorDowngradeEventResponseEntity })
  downgrade(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: DowngradeVendorDto,
  ): Promise<VendorDowngradeEventResponseEntity> {
    return this.vendorTiersService.downgrade(user.id, id, dto);
  }

  @Get(':id/downgrade-events')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: "List a vendor's downgrade history (admin only)" })
  @ApiResponseDoc({ status: 200, type: PaginatedDowngradeEventsEntity })
  listDowngradeEvents(
    @Param('id') id: string,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedDowngradeEventsEntity> {
    return this.vendorTiersService.listDowngradeEvents(id, dto);
  }
}
