import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { VendorsModule } from '../vendors/vendors.module';
import { FoodSafetyIncidentsController } from './controllers/food-safety-incidents.controller';
import { QualityInspectionsController } from './controllers/quality-inspections.controller';
import { RecallsController } from './controllers/recalls.controller';
import { TemperatureMonitoringController } from './controllers/temperature-monitoring.controller';
import { FoodSafetyIncidentsRepository } from './repositories/food-safety-incidents.repository';
import { QualityInspectionsRepository } from './repositories/quality-inspections.repository';
import { RecallsRepository } from './repositories/recalls.repository';
import { TemperatureReadingsRepository } from './repositories/temperature-readings.repository';
import { SeafoodLotsModule } from './seafood-lots.module';
import { FoodSafetyIncidentsService } from './services/food-safety-incidents.service';
import { QualityInspectionsService } from './services/quality-inspections.service';
import { RecallsService } from './services/recalls.service';
import { TemperatureMonitoringService } from './services/temperature-monitoring.service';

@Module({
  imports: [AuthModule, VendorsModule, DeliveryModule, SeafoodLotsModule],
  controllers: [
    TemperatureMonitoringController,
    QualityInspectionsController,
    FoodSafetyIncidentsController,
    RecallsController,
  ],
  providers: [
    TemperatureMonitoringService,
    QualityInspectionsService,
    FoodSafetyIncidentsService,
    RecallsService,
    TemperatureReadingsRepository,
    QualityInspectionsRepository,
    FoodSafetyIncidentsRepository,
    RecallsRepository,
  ],
})
export class FoodSafetyModule {}
