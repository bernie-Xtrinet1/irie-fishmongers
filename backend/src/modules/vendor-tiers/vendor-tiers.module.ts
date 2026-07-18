import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { VendorsModule } from '../vendors/vendors.module';
import { ComplianceScoreController } from './controllers/compliance-score.controller';
import { TierUpgradeRequestsController } from './controllers/tier-upgrade-requests.controller';
import { VendorDocumentsController } from './controllers/vendor-documents.controller';
import { VendorPermissionsController } from './controllers/vendor-permissions.controller';
import { VendorProfileController } from './controllers/vendor-profile.controller';
import { VendorTiersController } from './controllers/vendor-tiers.controller';
import { ComplianceScoreSignalsRepository } from './repositories/compliance-score-signals.repository';
import { VendorDocumentsRepository } from './repositories/vendor-documents.repository';
import { VendorDowngradeEventsRepository } from './repositories/vendor-downgrade-events.repository';
import { VendorSalesRepository } from './repositories/vendor-sales.repository';
import { VendorTierConfigsRepository } from './repositories/vendor-tier-configs.repository';
import { VendorTierFeaturesRepository } from './repositories/vendor-tier-features.repository';
import { VendorUpgradeRequestsRepository } from './repositories/vendor-upgrade-requests.repository';
import { ComplianceScoreCronService } from './services/compliance-score-cron.service';
import { ComplianceScoreEventsListener } from './services/compliance-score-events.listener';
import { ComplianceScoreService } from './services/compliance-score.service';
import { VendorDocumentsService } from './services/vendor-documents.service';
import { VendorPermissionsService } from './services/vendor-permissions.service';
import { VendorProfileService } from './services/vendor-profile.service';
import { VendorTiersService } from './services/vendor-tiers.service';

@Module({
  imports: [AuthModule, VendorsModule],
  controllers: [
    VendorPermissionsController,
    VendorDocumentsController,
    VendorTiersController,
    TierUpgradeRequestsController,
    VendorProfileController,
    ComplianceScoreController,
  ],
  providers: [
    VendorPermissionsService,
    VendorDocumentsService,
    VendorTiersService,
    VendorProfileService,
    VendorDocumentsRepository,
    VendorTierConfigsRepository,
    VendorTierFeaturesRepository,
    VendorSalesRepository,
    VendorUpgradeRequestsRepository,
    VendorDowngradeEventsRepository,
    ComplianceScoreSignalsRepository,
    ComplianceScoreService,
    ComplianceScoreEventsListener,
    ComplianceScoreCronService,
  ],
  exports: [VendorPermissionsService, VendorDocumentsService, ComplianceScoreService, ComplianceScoreCronService],
})
export class VendorTiersModule {}
