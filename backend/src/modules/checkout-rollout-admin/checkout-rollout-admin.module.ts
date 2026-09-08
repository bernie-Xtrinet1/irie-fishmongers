import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CheckoutRolloutModule } from '../checkout-rollout/checkout-rollout.module';
import { RolloutAdminController } from './controllers/rollout-admin.controller';
import { RolloutControlsRepository } from './repositories/rollout-controls.repository';
import { RolloutControlsService } from './services/rollout-controls.service';
import { InactiveRolloutPolicyService } from './services/inactive-rollout-policy.service';
import { RolloutControlTelemetryService } from './services/rollout-control-telemetry.service';

// Administrative persistence only. No dispatcher or checkout execution imports.
@Module({
  imports: [PrismaModule, AuthModule, CheckoutRolloutModule],
  controllers: [RolloutAdminController],
  providers: [
    RolloutControlsRepository,
    RolloutControlsService,
    InactiveRolloutPolicyService,
    RolloutControlTelemetryService,
  ],
})
export class CheckoutRolloutAdminModule {}
