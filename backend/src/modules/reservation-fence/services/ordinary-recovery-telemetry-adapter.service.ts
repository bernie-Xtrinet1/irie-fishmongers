import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  OrdinaryRecoveryCoordinatorService,
  CoordinatedRecoveryOptions,
  CoordinatedRecoveryResult,
} from './ordinary-recovery-coordinator.service';
import {
  ORDINARY_RECOVERY_SWEEP_EVENT,
  OrdinaryRecoverySweepEvent,
} from '../events/ordinary-recovery-sweep.event';

/**
 * Phase C.3.5 — Coordinated Ordinary Recovery Telemetry Adapter.
 *
 * Decorates OrdinaryRecoveryCoordinatorService with in-memory, best-effort
 * structured event emission.
 *
 * Safety & Isolation Properties:
 * - Composition wrapper: leaves OrdinaryRecoveryCoordinatorService 100% untouched.
 * - Single busy guard: does not introduce a secondary concurrency guard; delegates to coordinator.
 * - Non-interfering: synchronous event emission failures or listener errors are caught and logged;
 *   the coordinator's execution result is preserved verbatim.
 * - Read-only: never retries, never schedules, and never dispatches physical commands.
 */
@Injectable()
export class OrdinaryRecoveryTelemetryAdapter {
  private readonly logger = new Logger(OrdinaryRecoveryTelemetryAdapter.name);

  constructor(
    private readonly coordinator: OrdinaryRecoveryCoordinatorService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {
    if (!coordinator) {
      throw new Error('INVALID_ADAPTER_DEPENDENCIES');
    }
  }

  get isBusy(): boolean {
    return this.coordinator.isBusy;
  }

  get isStopped(): boolean {
    return this.coordinator.isStopped;
  }

  /**
   * Executes a coordinated recovery sweep via the coordinator and emits an
   * in-memory telemetry event upon normal method return.
   */
  async runCoordinatedSweep(
    options?: CoordinatedRecoveryOptions,
  ): Promise<CoordinatedRecoveryResult> {
    const result = await this.coordinator.runCoordinatedSweep(options);

    try {
      if (this.eventEmitter) {
        this.eventEmitter.emit(
          ORDINARY_RECOVERY_SWEEP_EVENT,
          new OrdinaryRecoverySweepEvent(result),
        );
      }
    } catch (telemetryErr) {
      const message =
        telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr);
      this.logger.warn(`Failed to emit ordinary recovery telemetry event: ${message}`);
    }

    return result;
  }
}
