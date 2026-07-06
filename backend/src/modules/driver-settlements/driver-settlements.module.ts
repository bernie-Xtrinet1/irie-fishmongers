import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { DriverSettlementsController } from './controllers/driver-settlements.controller';
import { DriverSettlementsRepository } from './repositories/driver-settlements.repository';
import { SettlementRateConfigsRepository } from './repositories/settlement-rate-configs.repository';
import { DriverSettlementEngine } from './services/driver-settlement-engine.service';
import { DriverSettlementsService } from './services/driver-settlements.service';

@Module({
  imports: [AuthModule, DeliveryModule],
  controllers: [DriverSettlementsController],
  providers: [
    DriverSettlementsService,
    DriverSettlementEngine,
    DriverSettlementsRepository,
    SettlementRateConfigsRepository,
  ],
})
export class DriverSettlementsModule {}
