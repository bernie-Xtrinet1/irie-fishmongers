import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CatchesModule } from '../catches/catches.module';
import { VendorsModule } from '../vendors/vendors.module';
import { ComplianceDashboardController } from './controllers/compliance-dashboard.controller';
import { ComplianceReportsController } from './controllers/compliance-reports.controller';
import { QualityModule } from './quality.module';
import { RecallsModule } from './recalls.module';
import { SeafoodLotsModule } from './seafood-lots.module';
import { ComplianceDashboardService } from './services/compliance-dashboard.service';
import { ComplianceReportsService } from './services/compliance-reports.service';

/**
 * New in the Phase 11 amendment's Module Restructuring - homes compliance
 * dashboard/reporting/audit-log/document-management services plus,
 * incrementally, chain-of-custody events and regulatory certifications.
 */
@Module({
  imports: [AuthModule, SeafoodLotsModule, QualityModule, RecallsModule, VendorsModule, CatchesModule],
  controllers: [ComplianceDashboardController, ComplianceReportsController],
  providers: [ComplianceDashboardService, ComplianceReportsService],
})
export class ComplianceOpsModule {}
