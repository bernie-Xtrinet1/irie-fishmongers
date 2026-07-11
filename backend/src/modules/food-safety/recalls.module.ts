import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';
import { VendorsModule } from '../vendors/vendors.module';
import { ComplianceAuditLogModule } from './compliance-audit-log.module';
import { RecallsController } from './controllers/recalls.controller';
import { WasteDisposalRecordsController } from './controllers/waste-disposal-records.controller';
import { CustodyEventsModule } from './custody-events.module';
import { RecallsRepository } from './repositories/recalls.repository';
import { WasteDisposalRecordsRepository } from './repositories/waste-disposal-records.repository';
import { SeafoodLotsModule } from './seafood-lots.module';
import { RecallsService } from './services/recalls.service';
import { WasteDisposalRecordsService } from './services/waste-disposal-records.service';

/**
 * Split out of the former flat FoodSafetyModule (Phase 11 amendment's
 * Module Restructuring) - the recall lifecycle and the waste-disposal
 * tracking tied to it.
 */
@Module({
  imports: [
    AuthModule,
    SeafoodLotsModule,
    ComplianceAuditLogModule,
    CustodyEventsModule,
    VendorsModule,
    ProductsModule,
  ],
  controllers: [RecallsController, WasteDisposalRecordsController],
  providers: [
    RecallsService,
    RecallsRepository,
    WasteDisposalRecordsService,
    WasteDisposalRecordsRepository,
  ],
  exports: [RecallsRepository],
})
export class RecallsModule {}
