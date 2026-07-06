import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { DeliveriesController } from './controllers/deliveries.controller';
import { DriversController } from './controllers/drivers.controller';
import { DeliveriesRepository } from './repositories/deliveries.repository';
import { DriverLocationsRepository } from './repositories/driver-locations.repository';
import { DriversRepository } from './repositories/drivers.repository';
import { DeliveriesService } from './services/deliveries.service';
import { DriversService } from './services/drivers.service';

@Module({
  imports: [AuthModule, OrdersModule],
  controllers: [DriversController, DeliveriesController],
  providers: [
    DriversService,
    DeliveriesService,
    DriversRepository,
    DriverLocationsRepository,
    DeliveriesRepository,
  ],
})
export class DeliveryModule {}
