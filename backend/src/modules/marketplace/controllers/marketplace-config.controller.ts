import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateModeConfigDto } from '../dto/create-mode-config.dto';
import { CreateWeightConfigDto } from '../dto/create-weight-config.dto';
import { MarketplaceModeConfigResponseEntity } from '../entities/marketplace-mode-config-response.entity';
import { VendorSelectionWeightConfigResponseEntity } from '../entities/vendor-selection-weight-config-response.entity';
import { MarketplaceConfigService } from '../services/marketplace-config.service';

@ApiTags('marketplace-config')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('marketplace')
export class MarketplaceConfigController {
  constructor(private readonly marketplaceConfigService: MarketplaceConfigService) {}

  @Get('mode-config')
  @ApiOperation({ summary: 'Get the current marketplace mode configuration (admin only)' })
  @ApiResponseDoc({ status: 200, type: MarketplaceModeConfigResponseEntity })
  getModeConfig(): Promise<MarketplaceModeConfigResponseEntity> {
    return this.marketplaceConfigService.getCurrentModeConfig();
  }

  @Post('mode-config')
  @ApiOperation({ summary: 'Publish a new marketplace mode configuration (admin only)' })
  @ApiResponseDoc({ status: 201, type: MarketplaceModeConfigResponseEntity })
  createModeConfig(
    @Body() dto: CreateModeConfigDto,
    @CurrentUser() user: RequestUser,
  ): Promise<MarketplaceModeConfigResponseEntity> {
    return this.marketplaceConfigService.createModeConfig(dto, user.id);
  }

  @Get('weight-config')
  @ApiOperation({ summary: 'Get the current vendor selection weight configuration (admin only)' })
  @ApiResponseDoc({ status: 200, type: VendorSelectionWeightConfigResponseEntity })
  getWeightConfig(): Promise<VendorSelectionWeightConfigResponseEntity> {
    return this.marketplaceConfigService.getCurrentWeightConfig();
  }

  @Post('weight-config')
  @ApiOperation({ summary: 'Publish a new vendor selection weight configuration (admin only)' })
  @ApiResponseDoc({ status: 201, type: VendorSelectionWeightConfigResponseEntity })
  createWeightConfig(
    @Body() dto: CreateWeightConfigDto,
    @CurrentUser() user: RequestUser,
  ): Promise<VendorSelectionWeightConfigResponseEntity> {
    return this.marketplaceConfigService.createWeightConfig(dto, user.id);
  }
}
