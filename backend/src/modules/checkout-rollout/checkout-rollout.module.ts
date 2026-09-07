import { Module } from '@nestjs/common';

import { PrismaModule } from '../../database/prisma.module';
import { CheckoutRolloutParticipantsRepository } from './repositories/checkout-rollout-participants.repository';
import { CheckoutRolloutParticipantsService } from './services/checkout-rollout-participants.service';
import { CheckoutRolloutPolicyService } from './services/checkout-rollout-policy.service';

// G.1 inactive module: not imported by AppModule or any production caller.
@Module({
  imports: [PrismaModule],
  providers: [
    CheckoutRolloutParticipantsRepository,
    CheckoutRolloutParticipantsService,
    CheckoutRolloutPolicyService,
  ],
  exports: [CheckoutRolloutParticipantsService, CheckoutRolloutPolicyService],
})
export class CheckoutRolloutModule {}
