import { Module } from '@nestjs/common';

import { CatchesModule } from '../catches/catches.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { ColdChainModule } from '../food-safety/cold-chain.module';
import { ComplianceOpsModule } from '../food-safety/compliance-ops.module';
import { CustodyEventsModule } from '../food-safety/custody-events.module';
import { SeafoodLotsModule } from '../food-safety/seafood-lots.module';
import { VendorsModule } from '../vendors/vendors.module';
import { PassportController } from './controllers/passport.controller';
import { PassportService } from './services/passport.service';

// Deliberately not nested under FoodSafetyModule - a public-facing
// composition layer that reads across SeafoodLotsModule/CatchesModule/
// ComplianceOpsModule/ColdChainModule/CustodyEventsModule/VendorsModule/
// DeliveryModule without owning any of that data itself. Sits above all
// of them; none of them import this module back, so there is no circular
// risk. Registered directly in AppModule, not composed through
// FoodSafetyModule.
@Module({
  imports: [
    SeafoodLotsModule,
    CatchesModule,
    ComplianceOpsModule,
    ColdChainModule,
    CustodyEventsModule,
    VendorsModule,
    DeliveryModule,
  ],
  controllers: [PassportController],
  providers: [PassportService],
})
export class PassportModule {}
