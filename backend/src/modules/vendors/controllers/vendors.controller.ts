import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
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
import { ListVendorsDto } from '../dto/list-vendors.dto';
import { RegisterVendorDto } from '../dto/register-vendor.dto';
import { UpdateVendorProfileDto } from '../dto/update-vendor-profile.dto';
import { UpdateVendorStatusDto } from '../dto/update-vendor-status.dto';
import { PaginatedVendorsEntity } from '../entities/paginated-vendors.entity';
import { PickupQueueEntryEntity } from '../entities/pickup-queue-entry.entity';
import { VendorPublicEntity } from '../entities/vendor-public.entity';
import { VendorResponseEntity } from '../entities/vendor-response.entity';
import { VendorPickupQueueService } from '../services/vendor-pickup-queue.service';
import { VendorsService } from '../services/vendors.service';

@ApiTags('vendors')
@Controller('vendors')
export class VendorsController {
  constructor(
    private readonly vendorsService: VendorsService,
    private readonly vendorPickupQueueService: VendorPickupQueueService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.VENDOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Register a vendor profile for the authenticated account' })
  @ApiResponseDoc({ status: 201, type: VendorResponseEntity })
  register(
    @CurrentUser() user: RequestUser,
    @Body() dto: RegisterVendorDto,
  ): Promise<VendorResponseEntity> {
    return this.vendorsService.register(user.id, dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.VENDOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the authenticated user's vendor profile" })
  @ApiResponseDoc({ status: 200, type: VendorResponseEntity })
  getOwnProfile(@CurrentUser() user: RequestUser): Promise<VendorResponseEntity> {
    return this.vendorsService.getOwnProfile(user.id);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.VENDOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update the authenticated user's vendor business profile" })
  @ApiResponseDoc({ status: 200, type: VendorResponseEntity })
  updateOwnProfile(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateVendorProfileDto,
  ): Promise<VendorResponseEntity> {
    return this.vendorsService.updateOwnProfile(user.id, dto);
  }

  @Get('me/pickup-queue')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.VENDOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "List the authenticated vendor's ready-for-pickup and assigned-to-driver orders",
  })
  @ApiResponseDoc({ status: 200, type: PickupQueueEntryEntity, isArray: true })
  getPickupQueue(@CurrentUser() user: RequestUser): Promise<PickupQueueEntryEntity[]> {
    return this.vendorPickupQueueService.getForUser(user.id);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List vendors, optionally filtered by status (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedVendorsEntity })
  list(@Query() dto: ListVendorsDto): Promise<PaginatedVendorsEntity> {
    return this.vendorsService.list(dto);
  }

  @Get(':id/public')
  @ApiOperation({ summary: 'Get the public storefront profile of an approved vendor' })
  @ApiResponseDoc({ status: 200, type: VendorPublicEntity })
  getPublicProfile(@Param('id') id: string): Promise<VendorPublicEntity> {
    return this.vendorsService.getPublicProfile(id);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Approve, suspend, or reject a vendor (admin only)' })
  @ApiResponseDoc({ status: 200, type: VendorResponseEntity })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateVendorStatusDto,
  ): Promise<VendorResponseEntity> {
    return this.vendorsService.updateStatus(id, dto.status);
  }
}
