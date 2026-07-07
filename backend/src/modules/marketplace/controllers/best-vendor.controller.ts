import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ResolveBestVendorDto } from '../dto/resolve-best-vendor.dto';
import { BestVendorResolutionEntity } from '../entities/best-vendor-resolution.entity';
import { FulfillmentDecisionsService } from '../services/fulfillment-decisions.service';

@ApiTags('marketplace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.CUSTOMER)
@Controller('marketplace/best-vendor')
export class BestVendorController {
  constructor(private readonly fulfillmentDecisionsService: FulfillmentDecisionsService) {}

  @Post('resolve')
  @ApiOperation({
    summary:
      'Resolve the Best Available Vendor for a product (Mode 2) - returns the winning productId to pass to POST /cart/items',
  })
  @ApiResponseDoc({ status: 201, type: BestVendorResolutionEntity })
  resolve(
    @CurrentUser() user: RequestUser,
    @Body() dto: ResolveBestVendorDto,
  ): Promise<BestVendorResolutionEntity> {
    return this.fulfillmentDecisionsService.resolveBestVendor(user.id, dto);
  }
}
