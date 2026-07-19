import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { VendorsModule } from '../vendors/vendors.module';
import { VendorSettlementsController } from './controllers/vendor-settlements.controller';
import { CommissionRateConfigsRepository } from './repositories/commission-rate-configs.repository';
import { VendorSettlementAdjustmentsRepository } from './repositories/vendor-settlement-adjustments.repository';
import { VendorSettlementsRepository } from './repositories/vendor-settlements.repository';
import { VendorSettlementsService } from './services/vendor-settlements.service';

@Module({
  imports: [AuthModule, VendorsModule],
  controllers: [VendorSettlementsController],
  providers: [
    VendorSettlementsService,
    VendorSettlementsRepository,
    VendorSettlementAdjustmentsRepository,
    CommissionRateConfigsRepository,
  ],
  exports: [VendorSettlementsRepository],
})
export class VendorSettlementsModule {}
