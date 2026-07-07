import { MarketplaceModeConfigResponseEntity } from '../entities/marketplace-mode-config-response.entity';
import { VendorSelectionWeightConfigResponseEntity } from '../entities/vendor-selection-weight-config-response.entity';
import { MarketplaceConfigService } from '../services/marketplace-config.service';
import { MarketplaceConfigController } from './marketplace-config.controller';

const modeConfig: MarketplaceModeConfigResponseEntity = {
  id: 'mode-config-1',
  customerSelectedEnabled: true,
  bestAvailableEnabled: false,
  createdAt: new Date(),
};

const weightConfig: VendorSelectionWeightConfigResponseEntity = {
  id: 'weight-config-1',
  inventoryWeight: '0.3',
  freshnessWeight: '0.2',
  complianceWeight: '0.2',
  distanceWeight: '0.15',
  ratingWeight: '0.05',
  deliveryCapacityWeight: '0.1',
  createdAt: new Date(),
};

const adminUser = { id: 'admin-1', email: 'admin@example.com', roles: ['ADMINISTRATOR' as const] };

describe('MarketplaceConfigController', () => {
  let marketplaceConfigService: jest.Mocked<
    Pick<
      MarketplaceConfigService,
      'getCurrentModeConfig' | 'createModeConfig' | 'getCurrentWeightConfig' | 'createWeightConfig'
    >
  >;
  let controller: MarketplaceConfigController;

  beforeEach(() => {
    marketplaceConfigService = {
      getCurrentModeConfig: jest.fn().mockResolvedValue(modeConfig),
      createModeConfig: jest.fn().mockResolvedValue(modeConfig),
      getCurrentWeightConfig: jest.fn().mockResolvedValue(weightConfig),
      createWeightConfig: jest.fn().mockResolvedValue(weightConfig),
    };
    controller = new MarketplaceConfigController(
      marketplaceConfigService as unknown as MarketplaceConfigService,
    );
  });

  it('gets the current mode config', async () => {
    await expect(controller.getModeConfig()).resolves.toEqual(modeConfig);
  });

  it('creates a new mode config as the current admin', async () => {
    const dto = { customerSelectedEnabled: true, bestAvailableEnabled: true };
    await expect(controller.createModeConfig(dto, adminUser)).resolves.toEqual(modeConfig);
    expect(marketplaceConfigService.createModeConfig).toHaveBeenCalledWith(dto, 'admin-1');
  });

  it('gets the current weight config', async () => {
    await expect(controller.getWeightConfig()).resolves.toEqual(weightConfig);
  });

  it('creates a new weight config as the current admin', async () => {
    const dto = {
      inventoryWeight: 0.3,
      freshnessWeight: 0.2,
      complianceWeight: 0.2,
      distanceWeight: 0.15,
      ratingWeight: 0.05,
      deliveryCapacityWeight: 0.1,
    };
    await expect(controller.createWeightConfig(dto, adminUser)).resolves.toEqual(weightConfig);
    expect(marketplaceConfigService.createWeightConfig).toHaveBeenCalledWith(dto, 'admin-1');
  });
});
