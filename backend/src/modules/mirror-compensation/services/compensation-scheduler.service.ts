import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { sanitizeErrorMessage } from '../../../common/utils/sanitize-error-message.util';
import { CompensationBatchService } from './compensation-batch.service';
import { MAX_LAST_ERROR_LENGTH } from './compensation.service';

// Phase 16A.0-C4.5 (see ADR-007). The only scheduling mechanism in this
// subsystem - a thin @Cron wrapper over the already-shipped
// CompensationBatchService.runBatch. Owns cadence, an efficiency-only
// in-process overlap guard, and scheduler-level error isolation; nothing
// else. Never reimplements any part of candidate selection, dispatch, or
// aggregation - that stays entirely inside CompensationBatchService.
//
// Deliberately mode-independent: no ReservationEngineModeService
// dependency of any kind. Mode-aware behavior belongs entirely to C4.3's
// single-row services (already reached transitively through
// CompensationBatchService), never duplicated here.
//
// The in-process `running` guard is efficiency-only, not a correctness
// mechanism - CompensationBatchService.runBatch already tolerates
// overlapping callers via the existing atomic-claim/generation-gated
// primitives (proven in C4.4). It exists solely to avoid redundant
// candidate scans, redundant BLOCKED precondition reads, and duplicate
// logging within this single process - never a distributed/advisory
// lock, and makes no claim about cross-instance exclusivity.
@Injectable()
export class CompensationSchedulerService {
  private readonly logger = new Logger(CompensationSchedulerService.name);
  private running = false;

  constructor(private readonly batchService: CompensationBatchService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async runScheduledBatch(): Promise<void> {
    if (this.running) {
      this.logger.warn('Compensation scheduler tick skipped - previous local run still executing');
      return;
    }

    this.running = true;
    try {
      const result = await this.batchService.runBatch({ now: new Date() });
      if (!result.ok) {
        // Structurally unreachable in practice - the scheduler always
        // passes a fresh valid Date and never a limit - but treated as a
        // genuine internal invariant failure rather than silently
        // swallowed if it ever occurs.
        this.logger.error('Compensation batch scheduler received INVALID_INPUT - internal invariant failure', {
          code: result.code,
          field: result.field,
          reason: result.reason,
        });
      }
      // No success-side aggregate re-log here - runBatch already logs
      // its own complete aggregate result.
    } catch (error) {
      this.logger.error('Compensation batch run threw unexpectedly', {
        message: sanitizeErrorMessage(CompensationSchedulerService.errorMessage(error), MAX_LAST_ERROR_LENGTH),
      });
    } finally {
      this.running = false;
    }
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
