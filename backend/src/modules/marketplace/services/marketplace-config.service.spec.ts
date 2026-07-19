import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { MarketplaceModeConfig, VendorSelectionWeightConfig } from '@prisma/client';

import { MarketplaceModeConfigsRepository } from '../repositories/marketplace-mode-configs.repository';
import { VendorSelectionWeightConfigsRepository } from '../repositories/vendor-selection-weight-configs.repository';
import { MarketplaceConfigService } from './marketplace-config.service';

function buildDecimal(value: number): VendorSelectionWeightConfig['inventoryWeight'] {
  return {
    toNumber: () => value,
    toString: () => value.toString(),
  } as unknown as VendorSelectionWeightConfig['inventoryWeight'];
}

function buildModeConfig(overrides: Partial<MarketplaceModeConfig> = {}): MarketplaceModeConfig {
  return {
    id: 'mode-config-1',
    customerSelectedEnabled: true,
    bestAvailableEnabled: false,
    updatedById: 'admin-1',
    createdAt: new Date(),
    ...overrides,
  };
}

function buildWeightConfig(
  overrides: Partial<VendorSelectionWeightConfig> = {},
): VendorSelectionWeightConfig {
  return {
    id: 'weight-config-1',
    inventoryWeight: buildDecimal(0.3),
    freshnessWeight: buildDecimal(0.2),
    complianceWeight: buildDecimal(0.2),
    distanceWeight: buildDecimal(0.15),
    ratingWeight: buildDecimal(0.05),
    deliveryCapacityWeight: buildDecimal(0.1),
    updatedById: 'admin-1',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('MarketplaceConfigService', () => {
  let modeConfigsRepository: jest.Mocked<Pick<MarketplaceModeConfigsRepository, 'findCurrent' | 'create'>>;
  let weightConfigsRepository: jest.Mocked<
    Pick<VendorSelectionWeightConfigsRepository, 'findCurrent' | 'create'>
  >;
  let service: MarketplaceConfigService;

  beforeEach(() => {
    modeConfigsRepository = { findCurrent: jest.fn(), create: jest.fn() };
    weightConfigsRepository = { findCurrent: jest.fn(), create: jest.fn() };
    service = new MarketplaceConfigService(
      modeConfigsRepository as unknown as MarketplaceModeConfigsRepository,
      weightConfigsRepository as unknown as VendorSelectionWeightConfigsRepository,
    );
  });

  describe('getCurrentModeConfig', () => {
    it('returns the current mode config', async () => {
      modeConfigsRepository.findCurrent.mockResolvedValue(buildModeConfig());

      const result = await service.getCurrentModeConfig();

      expect(result.customerSelectedEnabled).toBe(true);
      expect(result.bestAvailableEnabled).toBe(false);
    });

    it('throws when no mode config exists', async () => {
      modeConfigsRepository.findCurrent.mockResolvedValue(null);

      await expect(service.getCurrentModeConfig()).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('createModeConfig', () => {
    it('creates a new mode config row with the admin as updater', async () => {
      modeConfigsRepository.create.mockResolvedValue(
        buildModeConfig({ bestAvailableEnabled: true }),
      );

      const result = await service.createModeConfig(
        { customerSelectedEnabled: true, bestAvailableEnabled: true },
        'admin-1',
      );

      expect(result.bestAvailableEnabled).toBe(true);
      expect(modeConfigsRepository.create).toHaveBeenCalledWith({
        customerSelectedEnabled: true,
        bestAvailableEnabled: true,
        updatedById: 'admin-1',
      });
    });
  });

  describe('getCurrentWeightConfig', () => {
    it('returns the current weight config as strings', async () => {
      weightConfigsRepository.findCurrent.mockResolvedValue(buildWeightConfig());

      const result = await service.getCurrentWeightConfig();

      expect(result.inventoryWeight).toBe('0.3');
      expect(result.ratingWeight).toBe('0.05');
    });

    it('throws when no weight config exists', async () => {
      weightConfigsRepository.findCurrent.mockResolvedValue(null);

      await expect(service.getCurrentWeightConfig()).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('createWeightConfig', () => {
    const validDto = {
      inventoryWeight: 0.3,
      freshnessWeight: 0.2,
      complianceWeight: 0.2,
      distanceWeight: 0.15,
      ratingWeight: 0.05,
      deliveryCapacityWeight: 0.1,
    };

    it('creates a new weight config when the weights sum to 1.0', async () => {
      weightConfigsRepository.create.mockResolvedValue(buildWeightConfig());

      const result = await service.createWeightConfig(validDto, 'admin-1');

      expect(result.id).toBe('weight-config-1');
      expect(weightConfigsRepository.create).toHaveBeenCalledWith({
        ...validDto,
        updatedById: 'admin-1',
      });
    });

    it('rejects weights that do not sum to 1.0', async () => {
      await expect(
        service.createWeightConfig({ ...validDto, inventoryWeight: 0.5 }, 'admin-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(weightConfigsRepository.create).not.toHaveBeenCalled();
    });
  });
});
