import {
  CoordinatedRecoveryResult,
  CoordinatedRecoveryStatus,
} from '../services/ordinary-recovery-coordinator.service';
import {
  CommandSweepResult,
  SweepResult,
} from '../types/ordinary-invalidation-recovery.types';

export const ORDINARY_RECOVERY_SWEEP_EVENT = 'ordinary-recovery.sweep.completed';

/**
 * Phase C.3.5 — Coordinated Ordinary Recovery Telemetry Event.
 *
 * In-memory, best-effort structured event emitted upon completion of a
 * coordinated recovery sweep invocation.
 *
 * Excludes sensitive customer PII, credentials, tokens, and raw command payloads.
 * Maps only verified numerical metrics, execution statuses, and failure codes.
 */
export class OrdinaryRecoverySweepEvent {
  readonly eventName = ORDINARY_RECOVERY_SWEEP_EVENT;
  readonly eventVersion = '1.0.0';
  readonly timestampIso: string;
  readonly durationMs: number;
  readonly status: CoordinatedRecoveryStatus;

  readonly commandStatus: 'NOT_ATTEMPTED' | 'SUCCEEDED' | 'FAILED';
  readonly commandWorkerStatus?: 'COMPLETED' | 'SKIPPED_BUSY' | 'FAILED' | 'STOPPED';
  readonly commandMetrics?: CommandSweepResult;
  readonly commandReason?: string;
  readonly commandErrorCode?: string;

  readonly invalidationStatus: 'NOT_ATTEMPTED' | 'SUCCEEDED' | 'FAILED';
  readonly invalidationMetrics?: SweepResult;
  readonly invalidationReason?: string;
  readonly invalidationErrorCode?: string;

  constructor(result: CoordinatedRecoveryResult) {
    this.timestampIso = new Date().toISOString();
    this.durationMs = result.durationMs;
    this.status = result.status;

    this.commandStatus = result.command.status;
    if (result.command.status === 'SUCCEEDED') {
      this.commandWorkerStatus = result.command.result.status;
      if (result.command.result.status === 'COMPLETED') {
        this.commandMetrics = result.command.result.result;
      }
    } else if (result.command.status === 'NOT_ATTEMPTED') {
      this.commandReason = result.command.reason;
    } else if (result.command.status === 'FAILED') {
      this.commandErrorCode = result.command.errorCode;
    }

    this.invalidationStatus = result.invalidation.status;
    if (result.invalidation.status === 'SUCCEEDED') {
      this.invalidationMetrics = result.invalidation.result;
    } else if (result.invalidation.status === 'NOT_ATTEMPTED') {
      this.invalidationReason = result.invalidation.reason;
    } else if (result.invalidation.status === 'FAILED') {
      this.invalidationErrorCode = result.invalidation.errorCode;
    }
  }
}
