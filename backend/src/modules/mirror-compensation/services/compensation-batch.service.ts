import { Injectable, Logger } from '@nestjs/common';

import { sanitizeErrorMessage } from '../../../common/utils/sanitize-error-message.util';
import { CompensationRepository } from '../repositories/compensation.repository';
import { ReconcileOneResult } from '../types/compensation-reconciliation.types';
import { BatchReconciliationResult, RunBatchInput, RunBatchResult } from '../types/compensation-batch.types';
import { CompensationBlockedRecheckService } from './compensation-blocked-recheck.service';
import { CompensationReconciliationService } from './compensation-reconciliation.service';
import { MAX_LAST_ERROR_LENGTH } from './compensation.service';

export const DEFAULT_BATCH_SIZE = 50;
export const MAX_BATCH_SIZE = 200;

interface MutableCounters {
  resolved: number;
  requeued: number;
  retryScheduled: number;
  blocked: number;
  unblocked: number;
  permanentFailure: number;
  staleBlockedCheck: number;
  skipped: number;
}

interface ValidationFailure {
  field: string;
  reason: string;
}

// Phase 16A.0-C4.4 (see ADR-007). Batch orchestration ONLY - dispatches
// each selected candidate to the appropriate already-shipped single-row
// service by status alone, never reimplements any part of the
// reconciliation/blocked-recheck state machines. Sequential processing
// with per-candidate try/catch, matching this codebase's established
// batch-sweep convention (ComplianceScoreCronService.runBatchRecompute,
// SLABreachDetectionService) - no Promise.allSettled/bounded parallelism,
// no advisory lock, no SKIP LOCKED (see the approved C4.4 concurrency
// analysis in ADR-007 for why neither is needed: the underlying claim/
// generation-gated primitives already provide full correctness for
// PENDING/stale-PROCESSING rows, and harmless duplicate bookkeeping - not
// data corruption - is the worst case for overlapping BLOCKED rechecks).
//
// Exposes only an invokable runBatch() - no @Cron, no setInterval, no
// AppModule wiring. Scheduling is C4.5's scope, not this unit's.
@Injectable()
export class CompensationBatchService {
  private readonly logger = new Logger(CompensationBatchService.name);

  constructor(
    private readonly repository: CompensationRepository,
    private readonly reconciliationService: CompensationReconciliationService,
    private readonly blockedRecheckService: CompensationBlockedRecheckService,
  ) {}

  async runBatch(input: RunBatchInput): Promise<RunBatchResult> {
    const validationFailure = CompensationBatchService.validateInput(input);
    if (validationFailure) {
      return { ok: false, code: 'INVALID_INPUT', ...validationFailure };
    }
    const limit = input.limit ?? DEFAULT_BATCH_SIZE;

    const startedAt = Date.now();
    const candidates = await this.repository.findBatchCandidateIds(input.now, limit);

    const counters: MutableCounters = {
      resolved: 0,
      requeued: 0,
      retryScheduled: 0,
      blocked: 0,
      unblocked: 0,
      permanentFailure: 0,
      staleBlockedCheck: 0,
      skipped: 0,
    };
    const errors: BatchReconciliationResult['errors'] = [];
    let attempted = 0;

    for (const candidate of candidates) {
      attempted += 1;
      try {
        const outcome =
          candidate.status === 'BLOCKED'
            ? await this.blockedRecheckService.recheckBlocked(candidate.id, input.now)
            : await this.reconciliationService.attemptRecovery(candidate.id, input.now);
        CompensationBatchService.tallyOutcome(counters, outcome);
      } catch (error) {
        const sanitizedMessage = sanitizeErrorMessage(
          CompensationBatchService.errorMessage(error),
          MAX_LAST_ERROR_LENGTH,
        );
        this.logger.warn('Compensation batch candidate threw unexpectedly', {
          compensationId: candidate.id,
          message: sanitizedMessage,
        });
        errors.push({
          compensationId: candidate.id,
          message: sanitizedMessage ?? '[error message unavailable after sanitization]',
        });
      }
    }

    const result: BatchReconciliationResult = {
      candidatesFound: candidates.length,
      attempted,
      ...counters,
      errors,
      durationMs: Date.now() - startedAt,
    };

    this.logger.log('Compensation batch run complete', result);
    return { ok: true, result };
  }

  private static validateInput(input: RunBatchInput): ValidationFailure | null {
    if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
      return { field: 'now', reason: 'now must be a valid Date' };
    }
    if (input.limit !== undefined) {
      if (!Number.isInteger(input.limit) || input.limit <= 0) {
        return { field: 'limit', reason: 'limit must be a positive integer' };
      }
      if (input.limit > MAX_BATCH_SIZE) {
        return { field: 'limit', reason: `limit must not exceed ${MAX_BATCH_SIZE}` };
      }
    }
    return null;
  }

  private static tallyOutcome(counters: MutableCounters, outcome: ReconcileOneResult): void {
    switch (outcome.outcome) {
      case 'RESOLVED_CONVERGED':
      case 'RESOLVED_NO_LONGER_NEEDED_LEGACY':
        counters.resolved += 1;
        return;
      case 'REQUEUED_NEWER_DIVERGENCE':
        counters.requeued += 1;
        return;
      case 'RETRY_SCHEDULED':
        counters.retryScheduled += 1;
        return;
      case 'BLOCKED_PRODUCT_SUSPECT':
      case 'BLOCKED_MODE_NOT_ADMITTING':
        counters.blocked += 1;
        return;
      case 'UNBLOCKED_PENDING':
        counters.unblocked += 1;
        return;
      case 'PERMANENT_FAILURE':
        counters.permanentFailure += 1;
        return;
      case 'STALE_BLOCKED_CHECK':
        counters.staleBlockedCheck += 1;
        return;
      case 'ALREADY_RESOLVED':
      case 'NOT_DUE':
      case 'NOT_FOUND':
        counters.skipped += 1;
        return;
      default: {
        const exhaustiveCheck: never = outcome;
        throw new Error(`Unhandled ReconcileOneResult outcome: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
