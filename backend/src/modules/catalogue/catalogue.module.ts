import { Module } from '@nestjs/common';

import { PrismaModule } from '../../database/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminSeafoodCatalogueController } from './controllers/admin-seafood-catalogue.controller';
import { SeafoodCatalogueController } from './controllers/seafood-catalogue.controller';
import { SeafoodCatalogueRepository } from './repositories/seafood-catalogue.repository';
import { RegulatoryEligibilityService } from './services/regulatory-eligibility.service';
import { SeafoodCatalogueService } from './services/seafood-catalogue.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [SeafoodCatalogueController, AdminSeafoodCatalogueController],
  providers: [
    SeafoodCatalogueRepository,
    SeafoodCatalogueService,
    RegulatoryEligibilityService,
  ],
  exports: [
    SeafoodCatalogueService,
    RegulatoryEligibilityService,
    SeafoodCatalogueRepository,
  ],
})
export class CatalogueModule {}
