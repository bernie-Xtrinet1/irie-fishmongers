import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CatchesModule } from '../catches/catches.module';
import { VendorsModule } from '../vendors/vendors.module';
import { ComplianceDashboardController } from './controllers/compliance-dashboard.controller';
import { ComplianceDocumentsController } from './controllers/compliance-documents.controller';
import { ComplianceReportsController } from './controllers/compliance-reports.controller';
import { RegulatoryAuthoritiesController } from './controllers/regulatory-authorities.controller';
import { RegulatoryCertificationsController } from './controllers/regulatory-certifications.controller';
import { ComplianceDocumentsRepository } from './repositories/compliance-documents.repository';
import { RegulatoryAuthoritiesRepository } from './repositories/regulatory-authorities.repository';
import { RegulatoryCertificationsRepository } from './repositories/regulatory-certifications.repository';
import { QualityModule } from './quality.module';
import { RecallsModule } from './recalls.module';
import { SeafoodLotsModule } from './seafood-lots.module';
import { ComplianceDashboardService } from './services/compliance-dashboard.service';
import { ComplianceDocumentsService } from './services/compliance-documents.service';
import { ComplianceReportsService } from './services/compliance-reports.service';
import { RegulatoryAuthoritiesService } from './services/regulatory-authorities.service';
import { RegulatoryCertificationsService } from './services/regulatory-certifications.service';

/**
 * New in the Phase 11 amendment's Module Restructuring - homes compliance
 * dashboard/reporting/document-management services plus, incrementally,
 * chain-of-custody events and regulatory certifications. The audit log
 * itself lives in the standalone ComplianceAuditLogModule (see that
 * file's docblock for why it's separate) - it's imported directly by
 * SeafoodLotsModule/QualityModule/RecallsModule/CatchesModule (the actual
 * consumers) rather than here, and its own controller is registered
 * through that chain.
 */
@Module({
  imports: [AuthModule, SeafoodLotsModule, QualityModule, RecallsModule, VendorsModule, CatchesModule],
  controllers: [
    ComplianceDashboardController,
    ComplianceReportsController,
    ComplianceDocumentsController,
    RegulatoryAuthoritiesController,
    RegulatoryCertificationsController,
  ],
  providers: [
    ComplianceDashboardService,
    ComplianceReportsService,
    ComplianceDocumentsService,
    ComplianceDocumentsRepository,
    RegulatoryAuthoritiesService,
    RegulatoryAuthoritiesRepository,
    RegulatoryCertificationsService,
    RegulatoryCertificationsRepository,
  ],
  exports: [RegulatoryCertificationsRepository, RegulatoryAuthoritiesRepository, ComplianceDashboardService],
})
export class ComplianceOpsModule {}
