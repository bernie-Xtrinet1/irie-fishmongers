import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ComplianceAuditLogController } from './controllers/compliance-audit-log.controller';
import { ComplianceAuditLogsRepository } from './repositories/compliance-audit-logs.repository';
import { ComplianceAuditLogService } from './services/compliance-audit-log.service';

/**
 * A standalone leaf module (imports only AuthModule, for its own
 * controller's JwtAuthGuard/RolesGuard - no dependency on
 * SeafoodLotsModule/QualityModule/RecallsModule/CatchesModule/
 * ComplianceOpsModule) so all of those can import it to record an audit
 * entry without a circular dependency (ComplianceOpsModule itself imports
 * four of those).
 */
@Module({
  imports: [AuthModule],
  controllers: [ComplianceAuditLogController],
  providers: [ComplianceAuditLogService, ComplianceAuditLogsRepository],
  exports: [ComplianceAuditLogService],
})
export class ComplianceAuditLogModule {}
