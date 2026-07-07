import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { MarketplaceConfigController } from './controllers/marketplace-config.controller';
import { MarketplaceModeConfigsRepository } from './repositories/marketplace-mode-configs.repository';
import { VendorSelectionWeightConfigsRepository } from './repositories/vendor-selection-weight-configs.repository';
import { MarketplaceConfigService } from './services/marketplace-config.service';

@Module({
  imports: [AuthModule],
  controllers: [MarketplaceConfigController],
  providers: [
    MarketplaceConfigService,
    MarketplaceModeConfigsRepository,
    VendorSelectionWeightConfigsRepository,
  ],
  exports: [MarketplaceConfigService],
})
export class MarketplaceModule {}
