import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';

import { CreateModeConfigDto } from '../dto/create-mode-config.dto';
import { CreateWeightConfigDto } from '../dto/create-weight-config.dto';
import { MarketplaceModeConfigResponseEntity } from '../entities/marketplace-mode-config-response.entity';
import { VendorSelectionWeightConfigResponseEntity } from '../entities/vendor-selection-weight-config-response.entity';
import { MarketplaceModeConfigsRepository } from '../repositories/marketplace-mode-configs.repository';
import { VendorSelectionWeightConfigsRepository } from '../repositories/vendor-selection-weight-configs.repository';

const WEIGHT_SUM_TOLERANCE = 0.0005;

@Injectable()
export class MarketplaceConfigService {
  constructor(
    private readonly modeConfigsRepository: MarketplaceModeConfigsRepository,
    private readonly weightConfigsRepository: VendorSelectionWeightConfigsRepository,
  ) {}

  async getCurrentModeConfig(): Promise<MarketplaceModeConfigResponseEntity> {
    const config = await this.modeConfigsRepository.findCurrent();
    if (!config) {
      throw new InternalServerErrorException('No marketplace mode configuration exists');
    }
    return MarketplaceConfigService.toModeConfigResponse(config);
  }

  async createModeConfig(
    dto: CreateModeConfigDto,
    adminUserId: string,
  ): Promise<MarketplaceModeConfigResponseEntity> {
    const config = await this.modeConfigsRepository.create({ ...dto, updatedById: adminUserId });
    return MarketplaceConfigService.toModeConfigResponse(config);
  }

  async getCurrentWeightConfig(): Promise<VendorSelectionWeightConfigResponseEntity> {
    const config = await this.weightConfigsRepository.findCurrent();
    if (!config) {
      throw new InternalServerErrorException('No vendor selection weight configuration exists');
    }
    return MarketplaceConfigService.toWeightConfigResponse(config);
  }

  async createWeightConfig(
    dto: CreateWeightConfigDto,
    adminUserId: string,
  ): Promise<VendorSelectionWeightConfigResponseEntity> {
    const sum =
      dto.inventoryWeight +
      dto.freshnessWeight +
      dto.complianceWeight +
      dto.distanceWeight +
      dto.ratingWeight +
      dto.deliveryCapacityWeight;

    if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
      throw new BadRequestException(
        `Selection engine weights must sum to 1.0 (received ${sum.toFixed(4)})`,
      );
    }

    const config = await this.weightConfigsRepository.create({ ...dto, updatedById: adminUserId });
    return MarketplaceConfigService.toWeightConfigResponse(config);
  }

  private static toModeConfigResponse(config: {
    id: string;
    customerSelectedEnabled: boolean;
    bestAvailableEnabled: boolean;
    createdAt: Date;
  }): MarketplaceModeConfigResponseEntity {
    return {
      id: config.id,
      customerSelectedEnabled: config.customerSelectedEnabled,
      bestAvailableEnabled: config.bestAvailableEnabled,
      createdAt: config.createdAt,
    };
  }

  private static toWeightConfigResponse(config: {
    id: string;
    inventoryWeight: { toString(): string };
    freshnessWeight: { toString(): string };
    complianceWeight: { toString(): string };
    distanceWeight: { toString(): string };
    ratingWeight: { toString(): string };
    deliveryCapacityWeight: { toString(): string };
    createdAt: Date;
  }): VendorSelectionWeightConfigResponseEntity {
    return {
      id: config.id,
      inventoryWeight: config.inventoryWeight.toString(),
      freshnessWeight: config.freshnessWeight.toString(),
      complianceWeight: config.complianceWeight.toString(),
      distanceWeight: config.distanceWeight.toString(),
      ratingWeight: config.ratingWeight.toString(),
      deliveryCapacityWeight: config.deliveryCapacityWeight.toString(),
      createdAt: config.createdAt,
    };
  }
}
