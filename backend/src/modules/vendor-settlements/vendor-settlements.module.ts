import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { VendorsModule } from '../vendors/vendors.module';
import { VendorSettlementsController } from './controllers/vendor-settlements.controller';
import { CommissionRateConfigsRepository } from './repositories/commission-rate-configs.repository';
import { RefundAllocationsRepository } from './repositories/refund-allocations.repository';
import { VendorReceivablesRepository } from './repositories/vendor-receivables.repository';
import { VendorSettlementAdjustmentsRepository } from './repositories/vendor-settlement-adjustments.repository';
import { VendorSettlementsRepository } from './repositories/vendor-settlements.repository';
import { RefundAllocationsService } from './services/refund-allocations.service';
import { VendorLiabilityCalculatorService } from './services/vendor-liability-calculator.service';
import { VendorSettlementsService } from './services/vendor-settlements.service';

@Module({
  imports: [AuthModule, VendorsModule],
  controllers: [VendorSettlementsController],
  providers: [
    VendorSettlementsService,
    VendorSettlementsRepository,
    VendorSettlementAdjustmentsRepository,
    CommissionRateConfigsRepository,
    RefundAllocationsRepository,
    RefundAllocationsService,
    VendorLiabilityCalculatorService,
    VendorReceivablesRepository,
  ],
  exports: [
    VendorSettlementsRepository,
    RefundAllocationsService,
    VendorLiabilityCalculatorService,
    VendorReceivablesRepository,
  ],
})
export class VendorSettlementsModule {}
