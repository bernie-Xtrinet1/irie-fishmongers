import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FoodSafetyIncidentsController } from './controllers/food-safety-incidents.controller';
import { QualityInspectionsController } from './controllers/quality-inspections.controller';
import { FoodSafetyIncidentsRepository } from './repositories/food-safety-incidents.repository';
import { QualityInspectionsRepository } from './repositories/quality-inspections.repository';
import { SeafoodLotsModule } from './seafood-lots.module';
import { FoodSafetyIncidentsService } from './services/food-safety-incidents.service';
import { QualityInspectionsService } from './services/quality-inspections.service';

/**
 * Split out of the former flat FoodSafetyModule (Phase 11 amendment's
 * Module Restructuring) - lot-level grading/hazard reporting, distinct
 * from cold-chain telemetry and recall operations.
 */
@Module({
  imports: [AuthModule, SeafoodLotsModule],
  controllers: [QualityInspectionsController, FoodSafetyIncidentsController],
  providers: [QualityInspectionsService, FoodSafetyIncidentsService, QualityInspectionsRepository, FoodSafetyIncidentsRepository],
  exports: [FoodSafetyIncidentsRepository],
})
export class QualityModule {}
