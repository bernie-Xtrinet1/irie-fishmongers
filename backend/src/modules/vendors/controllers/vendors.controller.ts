import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { RegisterVendorDto } from '../dto/register-vendor.dto';
import { UpdateVendorStatusDto } from '../dto/update-vendor-status.dto';
import { VendorResponseEntity } from '../entities/vendor-response.entity';
import { VendorsService } from '../services/vendors.service';

@ApiTags('vendors')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('vendors')
export class VendorsController {
  constructor(private readonly vendorsService: VendorsService) {}

  @Post()
  @Roles(RoleName.VENDOR)
  @ApiOperation({ summary: 'Register a vendor profile for the authenticated account' })
  @ApiResponseDoc({ status: 201, type: VendorResponseEntity })
  register(
    @CurrentUser() user: RequestUser,
    @Body() dto: RegisterVendorDto,
  ): Promise<VendorResponseEntity> {
    return this.vendorsService.register(user.id, dto);
  }

  @Get('me')
  @Roles(RoleName.VENDOR)
  @ApiOperation({ summary: "Get the authenticated user's vendor profile" })
  @ApiResponseDoc({ status: 200, type: VendorResponseEntity })
  getOwnProfile(@CurrentUser() user: RequestUser): Promise<VendorResponseEntity> {
    return this.vendorsService.getOwnProfile(user.id);
  }

  @Patch(':id/status')
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'Approve, suspend, or reject a vendor (admin only)' })
  @ApiResponseDoc({ status: 200, type: VendorResponseEntity })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateVendorStatusDto,
  ): Promise<VendorResponseEntity> {
    return this.vendorsService.updateStatus(id, dto.status);
  }
}
