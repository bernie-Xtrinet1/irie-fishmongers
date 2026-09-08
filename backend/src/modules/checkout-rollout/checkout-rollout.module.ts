import { Module } from '@nestjs/common';

import { PrismaModule } from '../../database/prisma.module';
import { CheckoutRolloutParticipantsRepository } from './repositories/checkout-rollout-participants.repository';
import { CheckoutRolloutParticipantsService } from './services/checkout-rollout-participants.service';
import { CheckoutRolloutPolicyService } from './services/checkout-rollout-policy.service';

// Participant persistence is reachable through G.3a admin APIs only; no admission routing.
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
