import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { VendorTiersModule } from '../vendor-tiers/vendor-tiers.module';
import { BestVendorController } from './controllers/best-vendor.controller';
import { MarketplaceConfigController } from './controllers/marketplace-config.controller';
import { FulfillmentCandidatesRepository } from './repositories/fulfillment-candidates.repository';
import { FulfillmentDecisionsRepository } from './repositories/fulfillment-decisions.repository';
import { MarketplaceModeConfigsRepository } from './repositories/marketplace-mode-configs.repository';
import { VendorSelectionWeightConfigsRepository } from './repositories/vendor-selection-weight-configs.repository';
import { FulfillmentDecisionsService } from './services/fulfillment-decisions.service';
import { MarketplaceConfigService } from './services/marketplace-config.service';
import { VendorSelectionEngineService } from './services/vendor-selection-engine.service';

@Module({
  imports: [AuthModule, VendorTiersModule],
  controllers: [MarketplaceConfigController, BestVendorController],
  providers: [
    MarketplaceConfigService,
    MarketplaceModeConfigsRepository,
    VendorSelectionWeightConfigsRepository,
    FulfillmentCandidatesRepository,
    FulfillmentDecisionsRepository,
    VendorSelectionEngineService,
    FulfillmentDecisionsService,
  ],
  exports: [MarketplaceConfigService],
})
export class MarketplaceModule {}
