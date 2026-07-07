import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { VendorsModule } from '../vendors/vendors.module';
import { TierUpgradeRequestsController } from './controllers/tier-upgrade-requests.controller';
import { VendorDocumentsController } from './controllers/vendor-documents.controller';
import { VendorPermissionsController } from './controllers/vendor-permissions.controller';
import { VendorTiersController } from './controllers/vendor-tiers.controller';
import { VendorDocumentsRepository } from './repositories/vendor-documents.repository';
import { VendorDowngradeEventsRepository } from './repositories/vendor-downgrade-events.repository';
import { VendorSalesRepository } from './repositories/vendor-sales.repository';
import { VendorTierConfigsRepository } from './repositories/vendor-tier-configs.repository';
import { VendorTierFeaturesRepository } from './repositories/vendor-tier-features.repository';
import { VendorUpgradeRequestsRepository } from './repositories/vendor-upgrade-requests.repository';
import { VendorDocumentsService } from './services/vendor-documents.service';
import { VendorPermissionsService } from './services/vendor-permissions.service';
import { VendorTiersService } from './services/vendor-tiers.service';

@Module({
  imports: [AuthModule, VendorsModule],
  controllers: [
    VendorPermissionsController,
    VendorDocumentsController,
    VendorTiersController,
    TierUpgradeRequestsController,
  ],
  providers: [
    VendorPermissionsService,
    VendorDocumentsService,
    VendorTiersService,
    VendorDocumentsRepository,
    VendorTierConfigsRepository,
    VendorTierFeaturesRepository,
    VendorSalesRepository,
    VendorUpgradeRequestsRepository,
    VendorDowngradeEventsRepository,
  ],
  exports: [VendorPermissionsService, VendorDocumentsService],
})
export class VendorTiersModule {}
