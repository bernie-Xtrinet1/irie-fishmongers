import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FleetAssetsController } from './controllers/fleet-assets.controller';
import { FleetMaintenanceController } from './controllers/fleet-maintenance.controller';
import { FleetTripsController } from './controllers/fleet-trips.controller';
import { FleetAssetsRepository } from './repositories/fleet-assets.repository';
import { FleetMaintenanceRepository } from './repositories/fleet-maintenance.repository';
import { FleetSanitationRecordsRepository } from './repositories/fleet-sanitation-records.repository';
import { FleetTripsRepository } from './repositories/fleet-trips.repository';
import { FleetAssetsService } from './services/fleet-assets.service';
import { FleetMaintenanceService } from './services/fleet-maintenance.service';
import { FleetSanitationRecordsService } from './services/fleet-sanitation-records.service';
import { FleetTripsService } from './services/fleet-trips.service';

@Module({
  imports: [AuthModule],
  controllers: [FleetAssetsController, FleetTripsController, FleetMaintenanceController],
  providers: [
    FleetAssetsService,
    FleetTripsService,
    FleetMaintenanceService,
    FleetSanitationRecordsService,
    FleetAssetsRepository,
    FleetTripsRepository,
    FleetMaintenanceRepository,
    FleetSanitationRecordsRepository,
  ],
  exports: [FleetAssetsRepository, FleetAssetsService],
})
export class FleetModule {}
