import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';

import { VendorProfileResponseEntity } from '../entities/vendor-profile-response.entity';
import { VendorProfileService } from '../services/vendor-profile.service';

@ApiTags('vendors')
@Controller('vendors')
export class VendorProfileController {
  constructor(private readonly vendorProfileService: VendorProfileService) {}

  @Get(':id/profile')
  @ApiOperation({
    summary: 'Get the public vendor profile (tier badge, compliance status, orders completed)',
  })
  @ApiResponseDoc({ status: 200, type: VendorProfileResponseEntity })
  getProfile(@Param('id') id: string): Promise<VendorProfileResponseEntity> {
    return this.vendorProfileService.getProfile(id);
  }
}
