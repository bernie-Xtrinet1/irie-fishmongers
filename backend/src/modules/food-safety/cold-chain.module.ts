import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { VendorsModule } from '../vendors/vendors.module';
import { EmergencyResponsesController } from './controllers/emergency-responses.controller';
import { TemperatureDevicesController } from './controllers/temperature-devices.controller';
import { TemperatureMonitoringController } from './controllers/temperature-monitoring.controller';
import { TemperatureThresholdsController } from './controllers/temperature-thresholds.controller';
import { EmergencyResponsesRepository } from './repositories/emergency-responses.repository';
import { TemperatureDevicesRepository } from './repositories/temperature-devices.repository';
import { TemperatureReadingsRepository } from './repositories/temperature-readings.repository';
import { TemperatureThresholdsRepository } from './repositories/temperature-thresholds.repository';
import { SeafoodLotsModule } from './seafood-lots.module';
import { EmergencyResponsesService } from './services/emergency-responses.service';
import { TemperatureDevicesService } from './services/temperature-devices.service';
import { TemperatureMonitoringService } from './services/temperature-monitoring.service';
import { TemperatureThresholdsService } from './services/temperature-thresholds.service';

/**
 * Split out of the former flat FoodSafetyModule (Phase 11 amendment's
 * Module Restructuring) - groups everything that reads/writes around the
 * same TemperatureAlert/TemperatureDevice data on every reading. Pure
 * internal reorganization: every controller already declares its own
 * @Controller() path, so no routes change.
 */
@Module({
  imports: [AuthModule, VendorsModule, DeliveryModule, SeafoodLotsModule],
  controllers: [
    TemperatureMonitoringController,
    TemperatureDevicesController,
    TemperatureThresholdsController,
    EmergencyResponsesController,
  ],
  providers: [
    TemperatureMonitoringService,
    TemperatureDevicesService,
    TemperatureThresholdsService,
    EmergencyResponsesService,
    TemperatureReadingsRepository,
    TemperatureDevicesRepository,
    TemperatureThresholdsRepository,
    EmergencyResponsesRepository,
  ],
  exports: [TemperatureDevicesRepository, TemperatureThresholdsRepository, TemperatureReadingsRepository],
})
export class ColdChainModule {}
