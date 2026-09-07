import { Injectable } from '@nestjs/common';

import { CheckoutRolloutParticipantsRepository } from '../repositories/checkout-rollout-participants.repository';
import { ParticipationResult } from '../types/checkout-rollout.types';
import { assertRolloutUserId } from './checkout-rollout-participants.service';

@Injectable()
export class CheckoutRolloutPolicyService {
  constructor(private readonly repository: CheckoutRolloutParticipantsRepository) {}

  // No cache, request/cohort input, dispatcher, or recovery side effects.
  async evaluateParticipation(customerId: string): Promise<ParticipationResult> {
    assertRolloutUserId(customerId);
    try {
      const participant = await this.repository.findCurrent(customerId);
      if (!participant) {
        return {
          status: 'NOT_FOUND',
          enabled: false,
          cohort: null,
          revision: null,
          participantId: null,
        };
      }
      const details = {
        cohort: participant.cohort,
        revision: participant.revision,
        participantId: participant.id,
      };
      return participant.enabled
        ? { status: 'ENABLED', enabled: true, ...details }
        : { status: 'DISABLED', enabled: false, ...details };
    } catch {
      // Do not expose infrastructure details or conflate failure with absence.
      return {
        status: 'LOOKUP_FAILED',
        enabled: false,
        cohort: null,
        revision: null,
        participantId: null,
      };
    }
  }
}
