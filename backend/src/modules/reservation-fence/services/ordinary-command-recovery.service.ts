import { Logger } from '@nestjs/common';
import { OrdinaryReservationCommandRepository } from '../repositories/ordinary-reservation-command.repository';
import { OrdinaryCommandClosureService } from './ordinary-command-closure.service';
import { OrdinaryRecoveryDiagnosticsService } from './ordinary-recovery-diagnostics.service';
import {
  CommandSweepOptions,
  CommandSweepResult,
} from '../types/ordinary-invalidation-recovery.types';

const WORKER_ID_PATTERN = /^[a-zA-Z0-9_\-.:]+$/;

/**
 * Phase C.3.2 — Physical Command Claim-Loss Recovery Coordinator.
 *
 * Inactive Stage C recovery coordinator. Dormant domain service;
 * unwired from NestJS dependency injection and not registered in production modules.
 *
 * Observation and reconciliation only. Never dispatches, re-executes,
 * replays, or creates physical commands.
 */
export class OrdinaryCommandRecoveryService {
  private readonly logger = new Logger(OrdinaryCommandRecoveryService.name);

  constructor(
    private readonly commands: OrdinaryReservationCommandRepository,
    private readonly closure: OrdinaryCommandClosureService,
    private readonly diagnostics: OrdinaryRecoveryDiagnosticsService,
  ) {}

  /**
   * Discovers unresolved ordinary commands across PostgreSQL markers,
   * evaluates advisory Redis backoff, and executes observation closure.
   */
  async sweep(options: CommandSweepOptions = {}): Promise<CommandSweepResult> {
    const { limit, maxPages, workerId } = this.validateOptions(options);

    let cursor: { markerId: string; sequence: number; id: string } | undefined;
    let pagesProcessed = 0;
    let attemptedCount = 0;
    let acknowledgedCount = 0;
    let unresolvedCount = 0;
    let skippedBackoffCount = 0;
    let errorCount = 0;

    while (pagesProcessed < maxPages) {
      // 5.5 PostgreSQL discovery failure aborts the sweep and surfaces to caller
      const page = await this.commands.discoverClosure({ limit, cursor });
      if (page.length === 0) {
        break;
      }
      pagesProcessed++;

      for (const command of page) {
        // 5.2 Advisory backoff check before observation
        let decision;
        try {
          decision = await this.diagnostics.getBackoff(command.id);
        } catch {
          // Fail-safe advisory: Redis outage does not block PostgreSQL recovery
          decision = { shouldRetry: true, remainingWaitMs: 0, attempts: 0 };
        }

        if (!decision.shouldRetry) {
          skippedBackoffCount++;
          continue;
        }

        // 5.3 Closure observation
        attemptedCount++;
        try {
          const outcome = await this.closure.close(command.id);
          if (outcome.status === 'ACKNOWLEDGED') {
            acknowledgedCount++;
            // PostgreSQL row is committed to ACKNOWLEDGED; terminal state
            // excludes the command from future discoverClosure queries.
            // Do NOT call clearBackoff() to avoid stale-worker cache races.
          } else {
            unresolvedCount++;
            try {
              await this.diagnostics.recordFailure(
                command.id,
                'CLOSURE_UNRESOLVED',
                undefined,
                workerId,
              );
            } catch (diagErr) {
              this.logger.warn(
                `Failed to record advisory backoff for unresolved command ${command.id}: ${String(diagErr)}`,
              );
            }
          }
        } catch (err) {
          errorCount++;
          const message = err instanceof Error ? err.message : String(err);
          try {
            await this.diagnostics.recordFailure(
              command.id,
              'CLOSURE_ERROR',
              message,
              workerId,
            );
          } catch (diagErr) {
            this.logger.warn(
              `Failed to record advisory backoff for errored command ${command.id}: ${String(diagErr)}`,
            );
          }
        }
      }

      // 5.7 Pagination: strictly forward-monotonic cursor derived from final page row
      const last = page[page.length - 1];
      if (page.length === limit && last && last.sequence !== null) {
        cursor = { markerId: last.markerId, sequence: last.sequence, id: last.id };
      } else {
        cursor = undefined;
        break;
      }
    }

    // hasMore is a continuation indicator: last page was full and processing reached maxPages
    const hasMore = cursor !== undefined && pagesProcessed >= maxPages;

    return {
      attemptedCount,
      acknowledgedCount,
      unresolvedCount,
      skippedBackoffCount,
      errorCount,
      pagesProcessed,
      hasMore,
    };
  }

  /**
   * Defensively validate and bound sweep configuration options.
   * Rejects zero, negative, fractional, NaN, Infinity, and out-of-bounds options.
   */
  private validateOptions(options: CommandSweepOptions): {
    limit: number;
    maxPages: number;
    workerId: string;
  } {
    const limit = options.limit ?? 20;
    if (
      typeof limit !== 'number' ||
      !Number.isFinite(limit) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new Error('INVALID_SWEEP_OPTIONS');
    }

    const maxPages = options.maxPages ?? 10;
    if (
      typeof maxPages !== 'number' ||
      !Number.isFinite(maxPages) ||
      !Number.isInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > 1000
    ) {
      throw new Error('INVALID_SWEEP_OPTIONS');
    }

    const workerId = options.workerId ?? 'recovery-coordinator';
    if (
      typeof workerId !== 'string' ||
      workerId.trim().length === 0 ||
      workerId.length > 128 ||
      !WORKER_ID_PATTERN.test(workerId.trim())
    ) {
      throw new Error('INVALID_SWEEP_OPTIONS');
    }

    return {
      limit,
      maxPages,
      workerId: workerId.trim(),
    };
  }
}
