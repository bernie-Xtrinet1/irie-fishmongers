import { Module } from '@nestjs/common';

import { PrismaModule } from '../../database/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminCataloguePhotosController } from './controllers/admin-catalogue-photos.controller';
import { AdminSeafoodCatalogueController } from './controllers/admin-seafood-catalogue.controller';
import { SeafoodCatalogueController } from './controllers/seafood-catalogue.controller';
import { CataloguePhotoAdminGuard } from './guards/catalogue-photo-admin.guard';
import { CataloguePhotoManageGuard } from './guards/catalogue-photo-manage.guard';
import { CataloguePhotoViewGuard } from './guards/catalogue-photo-view.guard';
import { SeafoodCatalogueRepository } from './repositories/seafood-catalogue.repository';
import { AdminCataloguePhotosService } from './services/admin-catalogue-photos.service';
import { CataloguePhotoStorageService } from './services/catalogue-photo-storage.service';
import { RegulatoryEligibilityService } from './services/regulatory-eligibility.service';
import { SeafoodCatalogueService } from './services/seafood-catalogue.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [
    SeafoodCatalogueController,
    AdminSeafoodCatalogueController,
    AdminCataloguePhotosController,
  ],
  providers: [
    SeafoodCatalogueRepository,
    SeafoodCatalogueService,
    RegulatoryEligibilityService,
    CataloguePhotoStorageService,
    AdminCataloguePhotosService,
    CataloguePhotoManageGuard,
    CataloguePhotoAdminGuard,
    CataloguePhotoViewGuard,
  ],
  exports: [
    SeafoodCatalogueService,
    RegulatoryEligibilityService,
    SeafoodCatalogueRepository,
    CataloguePhotoStorageService,
    AdminCataloguePhotosService,
  ],
})
export class CatalogueModule {}
