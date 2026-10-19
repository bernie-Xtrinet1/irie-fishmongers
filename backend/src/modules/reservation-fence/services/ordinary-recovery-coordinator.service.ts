import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  OrdinaryCommandRecoverySweepWorker,
  OrdinaryCommandWorkerRunResult,
} from '../workers/ordinary-command-recovery-sweep.worker';
import { OrdinaryRecoverySweepWorker } from '../workers/ordinary-recovery-sweep.worker';
import {
  CommandSweepOptions,
  SweepResult,
} from '../types/ordinary-invalidation-recovery.types';
import {
  IOrdinaryRecoveryLockService,
  OrdinaryRecoveryExecutionPermit,
  OrdinaryRecoveryOwnershipLost,
} from '../types/ordinary-recovery-lock.types';

const WORKER_ID_PATTERN = /^[a-zA-Z0-9_\-.:]+$/;

export interface CoordinatedRecoveryOptions {
  readonly commandSweepOptions?: CommandSweepOptions;
  readonly invalidationLimit?: number;
  readonly continueOnCommandFailure?: boolean;
}

export interface OrdinaryRecoveryCoordinatorOptions {
  readonly defaultCommandLimit?: number;
  readonly defaultCommandMaxPages?: number;
  readonly defaultInvalidationLimit?: number;
  readonly defaultWorkerId?: string;
  readonly defaultContinueOnCommandFailure?: boolean;
}

export type CoordinatedChildExecution<T> =
  | {
      readonly status: 'NOT_ATTEMPTED';
      readonly reason: string;
    }
  | {
      readonly status: 'SUCCEEDED';
      readonly result: T;
    }
  | {
      readonly status: 'FAILED';
      readonly errorCode: string;
    };

export type CoordinatedRecoveryStatus =
  | 'COMPLETED'
  | 'PARTIAL'
  | 'FAILED'
  | 'SKIPPED_BUSY'
  | 'SKIPPED_LOCK_BUSY'
  | 'STOPPED';

export interface CoordinatedRecoveryResult {
  readonly status: CoordinatedRecoveryStatus;
  readonly command: CoordinatedChildExecution<OrdinaryCommandWorkerRunResult>;
  readonly invalidation: CoordinatedChildExecution<SweepResult>;
  readonly durationMs: number;
}

/**
 * Phase C.3.4 — Dormant Ordinary Recovery Orchestration Coordinator.
 *
 * Coordinates execution ordering across Phase C.3.3 ordinary command recovery
 * and Phase C.2 ordinary invalidation recovery.
 *
 * Invariant: Ordinary command closure observation must precede invalidation
 * replay to ensure PostgreSQL unclosed-command prerequisites (HISTORICAL_CLOSURE_REQUIRED)
 * are resolved before invalidation verification.
 *
 * Dormancy and Safety Properties:
 * - Plain TypeScript class without Injectable decorator
 * - Unregistered in AppModule and ReservationFenceModule
 * - No background timer, cron, or automatic scheduling
 * - No direct PostgreSQL or Redis authority access
 * - No physical reservation command dispatch or execution
 * - Borrowed worker dependency ownership: does not own or terminate child workers
 * - Bounded process-local concurrency lockout (isBusy)
 * - Safe error containment and exception sanitization
 */
export class OrdinaryRecoveryCoordinatorService implements OnModuleDestroy {
  private readonly logger = new Logger(OrdinaryRecoveryCoordinatorService.name);
  private isRunning = false;
  private _isStopped = false;

  readonly defaultCommandLimit: number;
  readonly defaultCommandMaxPages: number;
  readonly defaultInvalidationLimit: number;
  readonly defaultWorkerId: string;
  readonly defaultContinueOnCommandFailure: boolean;

  constructor(
    private readonly commandWorker: OrdinaryCommandRecoverySweepWorker,
    private readonly invalidationWorker: OrdinaryRecoverySweepWorker,
    private readonly lockService: IOrdinaryRecoveryLockService,
    options?: OrdinaryRecoveryCoordinatorOptions,
  ) {
    if (!commandWorker || typeof commandWorker.runSweep !== 'function') {
      throw new Error('INVALID_COORDINATOR_DEPENDENCIES');
    }
    if (!invalidationWorker || typeof invalidationWorker.runSweep !== 'function') {
      throw new Error('INVALID_COORDINATOR_DEPENDENCIES');
    }
    if (!lockService || typeof lockService.withExclusiveLock !== 'function') {
      throw new Error('INVALID_COORDINATOR_DEPENDENCIES');
    }

    const validated = this.validateCoordinatorOptions(options);
    this.defaultCommandLimit = validated.defaultCommandLimit;
    this.defaultCommandMaxPages = validated.defaultCommandMaxPages;
    this.defaultInvalidationLimit = validated.defaultInvalidationLimit;
    this.defaultWorkerId = validated.defaultWorkerId;
    this.defaultContinueOnCommandFailure = validated.defaultContinueOnCommandFailure;
  }

  get isBusy(): boolean {
    return this.isRunning;
  }

  get isStopped(): boolean {
    return this._isStopped;
  }

  /**
   * Lifecycle teardown.
   *
   * Dependencies are borrowed, not owned.
   * Marks the coordinator as stopped to prevent subsequent coordinated invocations.
   * Does NOT invoke onModuleDestroy on borrowed workers.
   */
  onModuleDestroy(): void {
    this._isStopped = true;
  }

  /**
   * Executes a coordinated recovery sweep:
   * 1. Invokes Phase C.3.3 command recovery sweep first.
   * 2. Checks for shutdown between child invocations.
   * 3. Evaluates continuation policy if command recovery did not complete.
   * 4. Invokes Phase C.2 invalidation recovery sweep second.
   * 5. Returns a composite outcome with child discriminated executions and execution duration.
   */
  async runCoordinatedSweep(
    options?: CoordinatedRecoveryOptions,
  ): Promise<CoordinatedRecoveryResult> {
    if (this._isStopped) {
      return {
        status: 'STOPPED',
        command: { status: 'NOT_ATTEMPTED', reason: 'COORDINATOR_STOPPED' },
        invalidation: { status: 'NOT_ATTEMPTED', reason: 'COORDINATOR_STOPPED' },
        durationMs: 0,
      };
    }

    if (this.isRunning) {
      return {
        status: 'SKIPPED_BUSY',
        command: { status: 'NOT_ATTEMPTED', reason: 'COORDINATOR_BUSY' },
        invalidation: { status: 'NOT_ATTEMPTED', reason: 'COORDINATOR_BUSY' },
        durationMs: 0,
      };
    }

    this.isRunning = true;
    const startMs = Date.now();

    let commandChild: CoordinatedChildExecution<OrdinaryCommandWorkerRunResult> = {
      status: 'NOT_ATTEMPTED',
      reason: 'SWEEP_NOT_STARTED',
    };
    let invalidationChild: CoordinatedChildExecution<SweepResult> = {
      status: 'NOT_ATTEMPTED',
      reason: 'SWEEP_NOT_STARTED',
    };

    try {
      if (this._isStopped) {
        return {
          status: 'STOPPED',
          command: { status: 'NOT_ATTEMPTED', reason: 'COORDINATOR_STOPPED' },
          invalidation: { status: 'NOT_ATTEMPTED', reason: 'COORDINATOR_STOPPED' },
          durationMs: 0,
        };
      }

      let validated: {
        commandSweepOptions: CommandSweepOptions;
        invalidationLimit: number;
        continueOnCommandFailure: boolean;
      };

      try {
        validated = this.validateSweepOptions(options);
      } catch (validationErr) {
        const message =
          validationErr instanceof Error ? validationErr.message : String(validationErr);
        this.logger.error(`Coordinated recovery sweep failed option validation: ${message}`);
        return {
          status: 'FAILED',
          command: { status: 'NOT_ATTEMPTED', reason: 'INVALID_OPTIONS' },
          invalidation: { status: 'NOT_ATTEMPTED', reason: 'INVALID_OPTIONS' },
          durationMs: Math.max(0, Date.now() - startMs),
        };
      }

      const lockOutcome = await this.lockService.withExclusiveLock(async (permit) => {
        // Step 1: Verify ownership before beginning command recovery
        await permit.assertHeld();

        if (this._isStopped) {
          return {
            status: 'STOPPED' as CoordinatedRecoveryStatus,
            command: { status: 'NOT_ATTEMPTED' as const, reason: 'COORDINATOR_STOPPED' },
            invalidation: { status: 'NOT_ATTEMPTED' as const, reason: 'COORDINATOR_STOPPED' },
            durationMs: Math.max(0, Date.now() - startMs),
          };
        }

        // Step 2: Invoke Command Recovery Sweep First
        try {
          const rawCommandResult = await this.commandWorker.runSweep(
            validated.commandSweepOptions,
            permit,
          );
          commandChild = {
            status: 'SUCCEEDED',
            result: rawCommandResult,
          };
        } catch (cmdErr) {
          if (cmdErr instanceof OrdinaryRecoveryOwnershipLost) {
            throw cmdErr;
          }
          const message = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
          this.logger.error(`Command recovery worker threw unexpected error: ${message}`);
          commandChild = {
            status: 'FAILED',
            errorCode: 'COMMAND_WORKER_THREW',
          };
        }

        // Step 3: Verify ownership again after command recovery
        await permit.assertHeld();

        // Step 4: Check Shutdown Between Child Invocations
        if (this._isStopped) {
          return {
            status: 'STOPPED' as CoordinatedRecoveryStatus,
            command: commandChild,
            invalidation: {
              status: 'NOT_ATTEMPTED' as const,
              reason: 'COORDINATOR_STOPPED_BEFORE_INVALIDATION',
            },
            durationMs: Math.max(0, Date.now() - startMs),
          };
        }

        // Step 5: Evaluate Mandatory Command-First Safety Barrier
        // Invalidation recovery is ONLY attempted if command recovery completed fully with zero unresolved work and zero errors.
        const isCommandFullyCompleted =
          commandChild.status === 'SUCCEEDED' &&
          commandChild.result.status === 'COMPLETED' &&
          commandChild.result.result.unresolvedCount === 0 &&
          commandChild.result.result.errorCount === 0 &&
          !commandChild.result.result.hasMore;

        if (!isCommandFullyCompleted) {
          const notAttemptedReason =
            commandChild.status === 'FAILED'
              ? 'COMMAND_RECOVERY_FAILED'
              : commandChild.result.status !== 'COMPLETED'
              ? `COMMAND_WORKER_${commandChild.result.status}`
              : commandChild.result.result.hasMore
              ? 'COMMAND_WORKER_HAS_MORE'
              : 'COMMAND_WORKER_UNRESOLVED';

          if (validated.continueOnCommandFailure) {
            this.logger.warn(
              `continueOnCommandFailure override suppressed by mandatory command-first safety barrier; skipping invalidation recovery (${notAttemptedReason})`,
            );
          }

          invalidationChild = {
            status: 'NOT_ATTEMPTED',
            reason: notAttemptedReason,
          };

          return {
            status: 'PARTIAL' as CoordinatedRecoveryStatus,
            command: commandChild,
            invalidation: invalidationChild,
            durationMs: Math.max(0, Date.now() - startMs),
          };
        }

        // Step 6: Verify ownership before beginning invalidation recovery
        await permit.assertHeld();

        // Step 7: Invoke Invalidation Recovery Sweep Second
        try {
          const rawInvalidationResult = await this.invalidationWorker.runSweep(
            validated.invalidationLimit,
            permit,
          );
          invalidationChild = {
            status: 'SUCCEEDED',
            result: rawInvalidationResult,
          };
        } catch (invErr) {
          if (invErr instanceof OrdinaryRecoveryOwnershipLost) {
            throw invErr;
          }
          const message = invErr instanceof Error ? invErr.message : String(invErr);
          this.logger.error(`Invalidation recovery worker threw unexpected error: ${message}`);
          invalidationChild = {
            status: 'FAILED',
            errorCode: 'INVALIDATION_WORKER_THREW',
          };
        }

        // Step 8: Verify ownership after invalidation recovery
        await permit.assertHeld();

        // Step 9: Check Shutdown Immediately After Invalidation Settles
        if (this._isStopped) {
          return {
            status: 'STOPPED' as CoordinatedRecoveryStatus,
            command: commandChild,
            invalidation: invalidationChild,
            durationMs: Math.max(0, Date.now() - startMs),
          };
        }

        const durationMs = Math.max(0, Date.now() - startMs);

        // Step 10: Compute Composite Status
        const invalidationCompleted = invalidationChild.status === 'SUCCEEDED';

        let status: CoordinatedRecoveryStatus;
        if (invalidationCompleted) {
          status = 'COMPLETED';
        } else {
          status = 'PARTIAL';
        }

        return {
          status,
          command: commandChild,
          invalidation: invalidationChild,
          durationMs,
        };
      });

      if (lockOutcome.status === 'LOCK_BUSY') {
        return {
          status: 'SKIPPED_LOCK_BUSY',
          command: { status: 'NOT_ATTEMPTED', reason: 'DISTRIBUTED_LOCK_BUSY' },
          invalidation: { status: 'NOT_ATTEMPTED', reason: 'DISTRIBUTED_LOCK_BUSY' },
          durationMs: Math.max(0, Date.now() - startMs),
        };
      }

      return lockOutcome.value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Coordinated recovery sweep encountered fatal error: ${message}`);
      return {
        status: 'FAILED',
        command: commandChild.status !== 'NOT_ATTEMPTED'
          ? commandChild
          : { status: 'NOT_ATTEMPTED', reason: 'COORDINATED_SWEEP_FAILED' },
        invalidation: {
          status: 'FAILED',
          errorCode: err instanceof OrdinaryRecoveryOwnershipLost
            ? 'OWNERSHIP_LOST'
            : 'COORDINATED_SWEEP_FAILED',
        },
        durationMs: Math.max(0, Date.now() - startMs),
      };
    } finally {
      this.isRunning = false;
    }
  }

  private validateCoordinatorOptions(options?: OrdinaryRecoveryCoordinatorOptions): {
    defaultCommandLimit: number;
    defaultCommandMaxPages: number;
    defaultInvalidationLimit: number;
    defaultWorkerId: string;
    defaultContinueOnCommandFailure: boolean;
  } {
    if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
      throw new Error('INVALID_COORDINATOR_OPTIONS');
    }

    const defaultCommandLimit = options?.defaultCommandLimit ?? 20;
    if (
      typeof defaultCommandLimit !== 'number' ||
      !Number.isFinite(defaultCommandLimit) ||
      !Number.isInteger(defaultCommandLimit) ||
      defaultCommandLimit < 1 ||
      defaultCommandLimit > 100
    ) {
      throw new Error('INVALID_COORDINATOR_OPTIONS');
    }

    const defaultCommandMaxPages = options?.defaultCommandMaxPages ?? 10;
    if (
      typeof defaultCommandMaxPages !== 'number' ||
      !Number.isFinite(defaultCommandMaxPages) ||
      !Number.isInteger(defaultCommandMaxPages) ||
      defaultCommandMaxPages < 1 ||
      defaultCommandMaxPages > 1000
    ) {
      throw new Error('INVALID_COORDINATOR_OPTIONS');
    }

    const defaultInvalidationLimit = options?.defaultInvalidationLimit ?? 20;
    if (
      typeof defaultInvalidationLimit !== 'number' ||
      !Number.isFinite(defaultInvalidationLimit) ||
      !Number.isInteger(defaultInvalidationLimit) ||
      defaultInvalidationLimit < 1 ||
      defaultInvalidationLimit > 100
    ) {
      throw new Error('INVALID_COORDINATOR_OPTIONS');
    }

    const defaultWorkerId = options?.defaultWorkerId ?? 'recovery-coordinator';
    if (
      typeof defaultWorkerId !== 'string' ||
      defaultWorkerId.trim().length === 0 ||
      defaultWorkerId.length > 128 ||
      !WORKER_ID_PATTERN.test(defaultWorkerId.trim())
    ) {
      throw new Error('INVALID_COORDINATOR_OPTIONS');
    }

    const defaultContinueOnCommandFailure = options?.defaultContinueOnCommandFailure ?? true;
    if (typeof defaultContinueOnCommandFailure !== 'boolean') {
      throw new Error('INVALID_COORDINATOR_OPTIONS');
    }

    return {
      defaultCommandLimit,
      defaultCommandMaxPages,
      defaultInvalidationLimit,
      defaultWorkerId: defaultWorkerId.trim(),
      defaultContinueOnCommandFailure,
    };
  }

  private validateSweepOptions(options?: CoordinatedRecoveryOptions): {
    commandSweepOptions: CommandSweepOptions;
    invalidationLimit: number;
    continueOnCommandFailure: boolean;
  } {
    if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
      throw new Error('INVALID_COORDINATOR_OPTIONS');
    }

    const rawCommandOpts = options?.commandSweepOptions;
    if (rawCommandOpts !== undefined && (typeof rawCommandOpts !== 'object' || rawCommandOpts === null || Array.isArray(rawCommandOpts))) {
      throw new Error('INVALID_COORDINATOR_OPTIONS');
    }

    const cmdLimit = rawCommandOpts?.limit ?? this.defaultCommandLimit;
    if (
      typeof cmdLimit !== 'number' ||
      !Number.isFinite(cmdLimit) ||
      !Number.isInteger(cmdLimit) ||
      cmdLimit < 1 ||
      cmdLimit > 100
    ) {
      throw new Error('INVALID_COORDINATOR_OPTIONS');
    }

    const cmdMaxPages = rawCommandOpts?.maxPages ?? this.defaultCommandMaxPages;
    if (
      typeof cmdMaxPages !== 'number' ||
      !Number.isFinite(cmdMaxPages) ||
      !Number.isInteger(cmdMaxPages) ||
      cmdMaxPages < 1 ||
      cmdMaxPages > 1000
    ) {
      throw new Error('INVALID_COORDINATOR_OPTIONS');
    }

    const cmdWorkerId = rawCommandOpts?.workerId ?? this.defaultWorkerId;
    if (
      typeof cmdWorkerId !== 'string' ||
      cmdWorkerId.trim().length === 0 ||
      cmdWorkerId.length > 128 ||
      !WORKER_ID_PATTERN.test(cmdWorkerId.trim())
    ) {
      throw new Error('INVALID_COORDINATOR_OPTIONS');
    }

    const invalidationLimit = options?.invalidationLimit ?? this.defaultInvalidationLimit;
    if (
      typeof invalidationLimit !== 'number' ||
      !Number.isFinite(invalidationLimit) ||
      !Number.isInteger(invalidationLimit) ||
      invalidationLimit < 1 ||
      invalidationLimit > 100
    ) {
      throw new Error('INVALID_COORDINATOR_OPTIONS');
    }

    const continueOnCommandFailure =
      options?.continueOnCommandFailure ?? this.defaultContinueOnCommandFailure;
    if (typeof continueOnCommandFailure !== 'boolean') {
      throw new Error('INVALID_COORDINATOR_OPTIONS');
    }

    return {
      commandSweepOptions: {
        limit: cmdLimit,
        maxPages: cmdMaxPages,
        workerId: cmdWorkerId.trim(),
      },
      invalidationLimit,
      continueOnCommandFailure,
    };
  }
}
