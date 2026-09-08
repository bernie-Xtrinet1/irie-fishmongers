import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CheckoutRecoveryLockService } from './checkout-recovery-lock.service';
import { CheckoutRecoveryWorkerService } from './checkout-recovery-worker.service';
import { CheckoutRecoveryTelemetryService } from './checkout-recovery-telemetry.service';

@Injectable()
export class CheckoutRecoverySchedulerService {
  private running = false;
  constructor(
    private readonly lock: CheckoutRecoveryLockService,
    private readonly worker: CheckoutRecoveryWorkerService,
    private readonly telemetry: CheckoutRecoveryTelemetryService,
  ) {}

  // Registration is gated by isSchedulerEnabled in AppModule, not a live stop.
  @Cron(CronExpression.EVERY_MINUTE)
  async runScheduledBatch(): Promise<void> {
    if (this.running) {
      this.telemetry.record('scheduler_lock_skipped', 'LOCAL_OVERLAP');
      return;
    }
    this.running = true;
    try {
      const acquired = await this.lock.runExclusive(async (lease) => {
        this.telemetry.record('scheduler_lock_acquired', 'OWNED');
        await this.worker.runCycle(lease);
      });
      if (!acquired) this.telemetry.record('scheduler_lock_skipped', 'CONTENDED');
    } catch {
      this.telemetry.record('checkout_recovery_failed', 'CYCLE_FAILURE');
    } finally {
      this.running = false;
    }
  }
}
