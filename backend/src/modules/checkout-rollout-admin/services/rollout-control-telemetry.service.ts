import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class RolloutControlTelemetryService {
  private readonly logger = new Logger(RolloutControlTelemetryService.name);
  record(
    kind: 'global' | 'participant' | 'evaluation',
    outcome: 'success' | 'conflict' | 'failure' | 'denied' | 'unavailable',
  ): void {
    try {
      this.logger.log('Inactive rollout control', {
        event: 'checkout_rollout_control',
        kind,
        outcome,
        productionDispatcherActive: false,
      });
    } catch {
      /* Telemetry cannot change administrative results. */
    }
  }
}
