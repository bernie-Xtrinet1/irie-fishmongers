import { Injectable, Logger } from '@nestjs/common';
import { CheckoutPath } from '@prisma/client';

export const RECOVERY_EVENTS = [
  'scheduler_lock_acquired',
  'scheduler_lock_skipped',
  'checkout_attempt_recovered',
  'checkout_pending_recovered',
  'checkout_recovery_skipped',
  'checkout_recovery_failed',
] as const;
export const RECOVERY_REASONS = [
  'OWNED',
  'CONTENDED',
  'LOCAL_OVERLAP',
  'UNKNOWN_PATH',
  'UNSUPPORTED_LEGACY',
  'FENCE_REJECTED',
  'SETTLEMENT_AUTHORITY_REQUIRED',
  'FINALIZATION_REQUIRED',
  'SETTLEMENT_ACKNOWLEDGED',
  'CLEANED',
  'ALREADY_RECONCILED',
  'CLEANUP_INCOMPLETE',
  'ATTEMPT_FAILURE',
  'CYCLE_FAILURE',
] as const;

@Injectable()
export class CheckoutRecoveryTelemetryService {
  private readonly logger = new Logger(CheckoutRecoveryTelemetryService.name);
  record(
    event: (typeof RECOVERY_EVENTS)[number],
    reasonCode: (typeof RECOVERY_REASONS)[number],
    selectedPath: CheckoutPath | null = null,
    durationMs = 0,
  ): void {
    try {
      if (!RECOVERY_EVENTS.includes(event) || !RECOVERY_REASONS.includes(reasonCode)) return;
      this.logger.log('Checkout recovery', {
        event,
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        reasonCode,
        outcome: event.endsWith('_failed')
          ? 'FAILED'
          : event.endsWith('_skipped')
            ? 'SKIPPED'
            : 'SUCCEEDED',
        selectedPath:
          selectedPath === 'LEGACY' || selectedPath === 'CART_SCOPED' ? selectedPath : null,
        durationMs: Number.isFinite(durationMs)
          ? Math.min(86400000, Math.max(0, Math.floor(durationMs)))
          : 0,
      });
    } catch {
      /* Diagnostic sinks never control recovery. */
    }
  }
}
