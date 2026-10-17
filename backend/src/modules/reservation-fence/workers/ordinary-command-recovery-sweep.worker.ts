import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OrdinaryCommandRecoveryService } from '../services/ordinary-command-recovery.service';
import {
  CommandSweepOptions,
  CommandSweepResult,
} from '../types/ordinary-invalidation-recovery.types';

const WORKER_ID_PATTERN = /^[a-zA-Z0-9_\-.:]+$/;

export interface OrdinaryCommandSweepWorkerOptions {
  readonly enableScheduling?: boolean;
  readonly intervalMs?: number;
  readonly limit?: number;
  readonly maxPages?: number;
  readonly workerId?: string;
}

export type OrdinaryCommandWorkerRunResult =
  | {
      readonly status: 'COMPLETED';
      readonly result: CommandSweepResult;
    }
  | {
      readonly status: 'SKIPPED_BUSY';
    }
  | {
      readonly status: 'FAILED';
      readonly errorCode: string;
    }
  | {
      readonly status: 'STOPPED';
    };

/**
 * Phase C.3.3 — Dedicated Dormant Ordinary Command Recovery Worker.
 *
 * Encapsulates the execution lifecycle, bounded invocation, timer management,
 * and concurrency lockout for OrdinaryCommandRecoveryService.
 *
 * Dormant domain worker:
 * - Plain TypeScript class without Injectable decorator
 * - Unregistered in AppModule and ReservationFenceModule
 * - Default configuration is unscheduled (enableScheduling: false)
 * - Observation and reconciliation only; zero physical command redispatch.
 */
export class OrdinaryCommandRecoverySweepWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdinaryCommandRecoverySweepWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isStopped = false;

  readonly enableScheduling: boolean;
  readonly intervalMs: number;
  readonly defaultLimit: number;
  readonly defaultMaxPages: number;
  readonly defaultWorkerId: string;

  constructor(
    private readonly recoveryService: OrdinaryCommandRecoveryService,
    options?: OrdinaryCommandSweepWorkerOptions,
  ) {
    if (!recoveryService) {
      throw new Error('INVALID_WORKER_DEPENDENCIES');
    }

    const validated = this.validateWorkerOptions(options);
    this.enableScheduling = validated.enableScheduling;
    this.intervalMs = validated.intervalMs;
    this.defaultLimit = validated.limit;
    this.defaultMaxPages = validated.maxPages;
    this.defaultWorkerId = validated.workerId;
  }

  get isScheduled(): boolean {
    return this.timer !== null;
  }

  get isBusy(): boolean {
    return this.isRunning;
  }

  onModuleInit(): void {
    if (this.isStopped) {
      return;
    }
    if (this.isScheduled) {
      return;
    }
    if (!this.enableScheduling) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runSweep().catch(() => {});
    }, this.intervalMs);
  }

  onModuleDestroy(): void {
    this.isStopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runSweep(
    options?: CommandSweepOptions,
  ): Promise<OrdinaryCommandWorkerRunResult> {
    if (this.isStopped) {
      return { status: 'STOPPED' };
    }

    if (this.isRunning) {
      return { status: 'SKIPPED_BUSY' };
    }

    this.isRunning = true;

    try {
      if (this.isStopped) {
        return { status: 'STOPPED' };
      }

      const sweepOptions: CommandSweepOptions = {
        limit: options?.limit ?? this.defaultLimit,
        maxPages: options?.maxPages ?? this.defaultMaxPages,
        workerId: options?.workerId ?? this.defaultWorkerId,
      };

      const result = await this.recoveryService.sweep(sweepOptions);
      return {
        status: 'COMPLETED',
        result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Ordinary command recovery sweep execution failed: ${message}`);
      return {
        status: 'FAILED',
        errorCode: 'RECOVERY_SWEEP_FAILED',
      };
    } finally {
      this.isRunning = false;
    }
  }

  private validateWorkerOptions(options?: OrdinaryCommandSweepWorkerOptions): {
    enableScheduling: boolean;
    intervalMs: number;
    limit: number;
    maxPages: number;
    workerId: string;
  } {
    const enableScheduling = options?.enableScheduling ?? false;
    if (typeof enableScheduling !== 'boolean') {
      throw new Error('INVALID_WORKER_OPTIONS');
    }

    const intervalMs = options?.intervalMs ?? 15_000;
    if (
      typeof intervalMs !== 'number' ||
      !Number.isFinite(intervalMs) ||
      !Number.isInteger(intervalMs) ||
      intervalMs < 100 ||
      intervalMs > 86_400_000
    ) {
      throw new Error('INVALID_WORKER_OPTIONS');
    }

    const limit = options?.limit ?? 20;
    if (
      typeof limit !== 'number' ||
      !Number.isFinite(limit) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new Error('INVALID_WORKER_OPTIONS');
    }

    const maxPages = options?.maxPages ?? 10;
    if (
      typeof maxPages !== 'number' ||
      !Number.isFinite(maxPages) ||
      !Number.isInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > 1000
    ) {
      throw new Error('INVALID_WORKER_OPTIONS');
    }

    const workerId = options?.workerId ?? 'recovery-worker';
    if (
      typeof workerId !== 'string' ||
      workerId.trim().length === 0 ||
      workerId.length > 128 ||
      !WORKER_ID_PATTERN.test(workerId.trim())
    ) {
      throw new Error('INVALID_WORKER_OPTIONS');
    }

    return {
      enableScheduling,
      intervalMs,
      limit,
      maxPages,
      workerId: workerId.trim(),
    };
  }
}
