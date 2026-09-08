import { Injectable } from '@nestjs/common';
import { CheckoutRolloutBehavior } from '@prisma/client';
import { CheckoutRolloutPolicyService } from '../../checkout-rollout/services/checkout-rollout-policy.service';
import { RolloutControlsService } from './rollout-controls.service';
import { RolloutControlTelemetryService } from './rollout-control-telemetry.service';

export type InactivePolicyReason =
  | 'GLOBAL_ABSENT'
  | 'GLOBAL_UNAVAILABLE'
  | 'STOPPED'
  | 'EXPLICIT_DENY'
  | 'PARTICIPANT_UNAVAILABLE'
  | 'PARTICIPANT_INELIGIBLE'
  | 'COHORT_MISMATCH'
  | 'ELIGIBLE';

@Injectable()
export class InactiveRolloutPolicyService {
  constructor(
    private readonly controls: RolloutControlsService,
    private readonly participants: CheckoutRolloutPolicyService,
    private readonly telemetry: RolloutControlTelemetryService,
  ) {}

  // Advisory only. No operation/attempt input, admission token, or execution dependency.
  async evaluate(customerId: string) {
    const result = (
      behavior: CheckoutRolloutBehavior,
      reason: InactivePolicyReason,
      available = true,
    ) => {
      if (!available || behavior === 'DENY')
        this.telemetry.record('evaluation', available ? 'denied' : 'unavailable');
      return {
        advisoryOnly: true as const,
        productionDispatcherActive: false as const,
        available,
        behavior,
        reason,
      };
    };
    const state = await this.controls.current();
    if (state.status !== 'CONFIGURED')
      return result(
        'DENY',
        state.status === 'ABSENT' ? 'GLOBAL_ABSENT' : 'GLOBAL_UNAVAILABLE',
        false,
      );
    if (state.control.newAdmissionStopped) return result('DENY', 'STOPPED');
    if (state.control.behavior === 'DENY') return result('DENY', 'EXPLICIT_DENY');
    const participant = await this.participants.evaluateParticipation(customerId);
    if (participant.status === 'LOOKUP_FAILED')
      return result('DENY', 'PARTICIPANT_UNAVAILABLE', false);
    if (!participant.enabled) return result('DENY', 'PARTICIPANT_INELIGIBLE');
    if (
      state.control.eligibleCohort !== null &&
      participant.cohort !== state.control.eligibleCohort
    )
      return result('DENY', 'COHORT_MISMATCH');
    return result(state.control.behavior, 'ELIGIBLE');
  }
}
