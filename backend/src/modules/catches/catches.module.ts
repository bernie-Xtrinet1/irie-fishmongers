import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ComplianceAuditLogModule } from '../food-safety/compliance-audit-log.module';
import { VendorsModule } from '../vendors/vendors.module';
import { CatchesController } from './controllers/catches.controller';
import { FishermenController } from './controllers/fishermen.controller';
import { LandingSitesController } from './controllers/landing-sites.controller';
import { SpeciesController } from './controllers/species.controller';
import { VesselsController } from './controllers/vessels.controller';
import { CatchItemsRepository } from './repositories/catch-items.repository';
import { CatchesRepository } from './repositories/catches.repository';
import { FishermenRepository } from './repositories/fishermen.repository';
import { LandingSitesRepository } from './repositories/landing-sites.repository';
import { SpeciesRepository } from './repositories/species.repository';
import { VesselsRepository } from './repositories/vessels.repository';
import { CatchesService } from './services/catches.service';
import { FishermenService } from './services/fishermen.service';
import { LandingSitesService } from './services/landing-sites.service';
import { SpeciesService } from './services/species.service';
import { VesselsService } from './services/vessels.service';

@Module({
  imports: [AuthModule, VendorsModule, ComplianceAuditLogModule],
  controllers: [
    FishermenController,
    LandingSitesController,
    SpeciesController,
    VesselsController,
    CatchesController,
  ],
  providers: [
    FishermenService,
    LandingSitesService,
    SpeciesService,
    VesselsService,
    CatchesService,
    FishermenRepository,
    LandingSitesRepository,
    SpeciesRepository,
    VesselsRepository,
    CatchesRepository,
    CatchItemsRepository,
  ],
  exports: [
    CatchesRepository,
    CatchItemsRepository,
    SpeciesRepository,
    FishermenRepository,
    LandingSitesRepository,
    VesselsRepository,
  ],
})
export class CatchesModule {}
