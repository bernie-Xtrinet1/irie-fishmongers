import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { VendorsModule } from '../vendors/vendors.module';
import { CatchesController } from './controllers/catches.controller';
import { FishermenController } from './controllers/fishermen.controller';
import { LandingSitesController } from './controllers/landing-sites.controller';
import { SpeciesController } from './controllers/species.controller';
import { CatchesRepository } from './repositories/catches.repository';
import { FishermenRepository } from './repositories/fishermen.repository';
import { LandingSitesRepository } from './repositories/landing-sites.repository';
import { SpeciesRepository } from './repositories/species.repository';
import { CatchesService } from './services/catches.service';
import { FishermenService } from './services/fishermen.service';
import { LandingSitesService } from './services/landing-sites.service';
import { SpeciesService } from './services/species.service';

@Module({
  imports: [AuthModule, VendorsModule],
  controllers: [FishermenController, LandingSitesController, SpeciesController, CatchesController],
  providers: [
    FishermenService,
    LandingSitesService,
    SpeciesService,
    CatchesService,
    FishermenRepository,
    LandingSitesRepository,
    SpeciesRepository,
    CatchesRepository,
  ],
  exports: [CatchesRepository, SpeciesRepository, FishermenRepository, LandingSitesRepository],
})
export class CatchesModule {}
