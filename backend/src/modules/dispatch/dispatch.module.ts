import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { FleetModule } from '../fleet/fleet.module';
import { DispatchController } from './controllers/dispatch.controller';
import { DispatchDecisionLogsRepository } from './repositories/dispatch-decision-logs.repository';
import { DispatchService } from './services/dispatch.service';

// 10A Fleet Dispatch Engine - a separate module rather than folding into
// DeliveryModule, since DispatchService composes both Delivery and Fleet
// repositories (same "composes existing modules rather than duplicating
// their logic" precedent as AnalyticsModule).
@Module({
  imports: [AuthModule, DeliveryModule, FleetModule],
  controllers: [DispatchController],
  providers: [DispatchService, DispatchDecisionLogsRepository],
})
export class DispatchModule {}
