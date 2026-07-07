import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { VendorPermissionsEntity } from '../entities/vendor-permissions.entity';
import { VendorPermissionsService } from '../services/vendor-permissions.service';

@ApiTags('vendor-permissions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('vendors')
export class VendorPermissionsController {
  constructor(
    private readonly permissionsService: VendorPermissionsService,
    private readonly vendorsRepository: VendorsRepository,
  ) {}

  @Get('me/permissions')
  @Roles(RoleName.VENDOR)
  @ApiOperation({ summary: "Get the authenticated vendor's tier-derived permissions and limits" })
  @ApiResponseDoc({ status: 200, type: VendorPermissionsEntity })
  async getMine(@CurrentUser() user: RequestUser): Promise<VendorPermissionsEntity> {
    const vendor = await this.vendorsRepository.findByUserId(user.id);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }
    return this.permissionsService.getPermissions(vendor.tier);
  }

  @Get(':id/permissions')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: "Get a vendor's tier-derived permissions and limits (admin only)" })
  @ApiResponseDoc({ status: 200, type: VendorPermissionsEntity })
  async getForVendor(@Param('id') id: string): Promise<VendorPermissionsEntity> {
    const vendor = await this.vendorsRepository.findById(id);
    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }
    return this.permissionsService.getPermissions(vendor.tier);
  }
}
