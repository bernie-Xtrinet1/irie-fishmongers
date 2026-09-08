import { Injectable } from '@nestjs/common';
import {
  CheckoutAttemptStaleCandidate,
  StaleCheckoutAttemptCursor,
} from '../../checkout-attempt/types/checkout-attempt.types';
import { CheckoutAttemptService } from '../../checkout-attempt/services/checkout-attempt.service';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { CheckoutAttemptStaleFencingService } from '../../checkout-attempt/services/checkout-attempt-stale-fencing.service';
import { CHECKOUT_HEARTBEAT_FRESHNESS_SECONDS } from '../../inventory/constants/inventory.constants';
import { CheckoutReservationRecoveryService } from '../../inventory/services/checkout-reservation-recovery.service';
import {
  CheckoutRecoveryLease,
  CheckoutRecoveryOwnershipLost,
} from './checkout-recovery-lock.service';
import { CheckoutRecoveryTelemetryService } from './checkout-recovery-telemetry.service';

export const CHECKOUT_RECOVERY_PAGE_SIZE = 100;

@Injectable()
export class CheckoutRecoveryWorkerService {
  // Progress only. Restart resets to the beginning and safely repeats cleanup
  // from durable FAILED rows. A failed cleanup remains discoverable next sweep.
  private staleCursor: StaleCheckoutAttemptCursor | null = null;
  private cleanupCursor: StaleCheckoutAttemptCursor | null = null;
  constructor(
    private readonly attempts: CheckoutAttemptService,
    private readonly repository: CheckoutAttemptRepository,
    private readonly fence: CheckoutAttemptStaleFencingService,
    private readonly recovery: CheckoutReservationRecoveryService,
    private readonly telemetry: CheckoutRecoveryTelemetryService,
  ) {}

  async runCycle(lease: CheckoutRecoveryLease): Promise<void> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - CHECKOUT_HEARTBEAT_FRESHNESS_SECONDS * 1000);
    await lease.assertHeld();
    // Snapshot old obligations before creating new ones: no same-cycle double
    // cleanup when a PROCESSING candidate becomes FAILED during this cycle.
    const cleanup = await this.repository.findFencedCleanupPage({
      cursor: this.cleanupCursor,
      limit: CHECKOUT_RECOVERY_PAGE_SIZE,
    });
    const stale = await this.attempts.findStalePage({
      heartbeatBefore: staleBefore,
      cursor: this.staleCursor,
      limit: CHECKOUT_RECOVERY_PAGE_SIZE,
    });
    if (!stale.ok) throw new Error('Invalid internal stale discovery');
    for (const candidate of cleanup) {
      await this.process(candidate, lease, null);
      this.cleanupCursor = { id: candidate.id, lastHeartbeatAt: candidate.lastHeartbeatAt };
    }
    if (cleanup.length < CHECKOUT_RECOVERY_PAGE_SIZE) this.cleanupCursor = null;
    for (const candidate of stale.page.items) {
      await this.process(candidate, lease, { now, staleBefore });
      this.staleCursor = { id: candidate.id, lastHeartbeatAt: candidate.lastHeartbeatAt };
    }
    if (!stale.page.nextCursor) this.staleCursor = null;
  }

  private async process(
    candidate: CheckoutAttemptStaleCandidate,
    lease: CheckoutRecoveryLease,
    stale: { now: Date; staleBefore: Date } | null,
  ): Promise<void> {
    await lease.assertHeld();
    if (candidate.selectedPath !== 'CART_SCOPED') {
      this.telemetry.record(
        'checkout_recovery_skipped',
        candidate.selectedPath === null ? 'UNKNOWN_PATH' : 'UNSUPPORTED_LEGACY',
        candidate.selectedPath,
      );
      return;
    }
    const started = Date.now();
    try {
      if (stale) {
        const fenced = await this.fence.fence({
          attemptId: candidate.id,
          customerId: candidate.customerId,
          selectedPath: 'CART_SCOPED',
          observedHeartbeatAt: candidate.lastHeartbeatAt,
          staleBefore: stale.staleBefore,
          now: stale.now,
        });
        if (!fenced.ok) {
          this.telemetry.record(
            'checkout_recovery_skipped',
            'FENCE_REJECTED',
            candidate.selectedPath,
          );
          return;
        }
      }
      await lease.assertHeld();
      const result = await this.recovery.checkoutRevert(
        candidate.cartId,
        candidate.idempotencyKey,
        Date.now(),
      );
      await lease.assertHeld();
      if (!result.ok || result.admissionSuspended) {
        this.telemetry.record(
          'checkout_recovery_failed',
          'CLEANUP_INCOMPLETE',
          candidate.selectedPath,
        );
        return;
      }
      const changed = result.restoredProductIds.length + result.deletedProductIds.length > 0;
      this.telemetry.record(
        stale ? 'checkout_attempt_recovered' : 'checkout_pending_recovered',
        changed ? 'CLEANED' : 'ALREADY_RECONCILED',
        candidate.selectedPath,
        Date.now() - started,
      );
    } catch (error) {
      if (error instanceof CheckoutRecoveryOwnershipLost) throw error;
      await lease.assertHeld();
      this.telemetry.record('checkout_recovery_failed', 'ATTEMPT_FAILURE', candidate.selectedPath);
    }
  }
}
