import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CustodyEventsController } from './controllers/custody-events.controller';
import { CustodyEventsRepository } from './repositories/custody-events.repository';
import { CustodyEventsService } from './services/custody-events.service';

/**
 * A standalone leaf module (same reasoning as ComplianceAuditLogModule):
 * SeafoodLotsModule writes STORAGE_ENTRY events directly after lot
 * registration, QualityModule writes INSPECTION events directly after an
 * inspection, and the top-level FoodSafetyModule's FoodSafetyEventsListener
 * writes LANDING events on CatchRegisteredEvent - all three would create a
 * circular dependency if this module lived inside ComplianceOpsModule
 * (which itself imports SeafoodLotsModule/QualityModule).
 */
@Module({
  imports: [AuthModule],
  controllers: [CustodyEventsController],
  providers: [CustodyEventsService, CustodyEventsRepository],
  exports: [CustodyEventsRepository],
})
export class CustodyEventsModule {}
