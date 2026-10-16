import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { OrdinaryInvalidationRecoveryService } from '../services/ordinary-invalidation-recovery.service';
import { OrdinaryMarkerBootstrapService } from '../services/ordinary-marker-bootstrap.service';
import { SweepResult } from '../types/ordinary-invalidation-recovery.types';

@Injectable()
export class OrdinaryRecoverySweepWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  get isScheduled(): boolean {
    return this.timer !== null;
  }

  get isBusy(): boolean {
    return this.isRunning;
  }

  constructor(
    private readonly repository: OrdinaryInvalidationRepository,
    private readonly recoveryService: OrdinaryInvalidationRecoveryService,
    private readonly bootstrapService: OrdinaryMarkerBootstrapService,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  onModuleInit(): void {
    const isSchedulerEnabled = this.configService
      ? this.configService.get('ENABLE_SCHEDULER') === 'true'
      : process.env.ENABLE_SCHEDULER === 'true';

    if (isSchedulerEnabled) {
      const intervalMs = 15_000;
      this.timer = setInterval(() => {
        void this.runSweep().catch(() => {});
      }, intervalMs);
    }
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runSweep(limit = 20): Promise<SweepResult> {
    if (this.isRunning) {
      return {
        bootstrappedCount: 0,
        reconciledCount: 0,
        replayedCount: 0,
        readinessCount: 0,
        blockedCount: 0,
        errors: ['SWEEP_ALREADY_IN_PROGRESS'],
      };
    }

    this.isRunning = true;
    const result: SweepResult = {
      bootstrappedCount: 0,
      reconciledCount: 0,
      replayedCount: 0,
      readinessCount: 0,
      blockedCount: 0,
      errors: [],
    };

    try {
      // 1. Discover and bootstrap unready marker heads at revision 0
      const unreadyHeads = await this.repository.discoverUnreadyEnrolledMarkerHeads(limit);
      for (const head of unreadyHeads) {
        if (!head.scope.startsWith('MARKER:')) continue;
        const markerId = head.scope.slice(7);
        try {
          const bootstrapRes = await this.bootstrapService.bootstrap(markerId);
          if (bootstrapRes.status === 'READY') {
            result.bootstrappedCount++;
          } else if (bootstrapRes.status === 'FAILED') {
            result.errors.push(`BOOTSTRAP_FAILED:${head.scope}:${bootstrapRes.error ?? bootstrapRes.reason}`);
          }
        } catch (err) {
          result.errors.push(`BOOTSTRAP_EXCEPTION:${head.scope}:${String(err)}`);
        }
      }

      // 2. Discover in-progress (PREPARED, BARRIER_CONFIRMED) or unready PUBLISHED intents
      const intents = await this.repository.discover(limit);
      for (const intent of intents) {
        try {
          const recRes = await this.recoveryService.recoverIntent(intent.id);
          switch (recRes.disposition) {
            case 'REPLAYED':
              result.replayedCount++;
              break;
            case 'READY_RECONCILED':
              result.readinessCount++;
              break;
            case 'BLOCKED_MANUAL_REVIEW':
              result.blockedCount++;
              break;
            case 'ALREADY_PUBLISHED':
            case 'SUPERSEDED':
              result.reconciledCount++;
              break;
          }
        } catch (recErr) {
          result.errors.push(`RECOVERY_EXCEPTION:${intent.id}:${String(recErr)}`);
        }
      }
    } finally {
      this.isRunning = false;
    }

    return result;
  }
}
