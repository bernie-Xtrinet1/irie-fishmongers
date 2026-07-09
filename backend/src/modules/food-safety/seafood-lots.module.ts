import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CatchesModule } from '../catches/catches.module';
import { VendorsModule } from '../vendors/vendors.module';
import { SeafoodLotsController } from './controllers/seafood-lots.controller';
import { SeafoodLotsRepository } from './repositories/seafood-lots.repository';
import { TemperatureAlertsRepository } from './repositories/temperature-alerts.repository';
import { SeafoodLotsService } from './services/seafood-lots.service';

/**
 * Split out from FoodSafetyModule so Products (and any other module that
 * only needs lot lookups/ownership checks) can depend on it without pulling
 * in DeliveryModule -> OrdersModule -> ProductsModule, which would be a
 * circular module dependency.
 */
@Module({
  imports: [AuthModule, VendorsModule, CatchesModule],
  controllers: [SeafoodLotsController],
  providers: [SeafoodLotsService, SeafoodLotsRepository, TemperatureAlertsRepository],
  exports: [SeafoodLotsService, SeafoodLotsRepository, TemperatureAlertsRepository],
})
export class SeafoodLotsModule {}
