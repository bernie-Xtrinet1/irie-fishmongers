import { Injectable } from '@nestjs/common';
import { StaleCheckoutAttemptCursor } from '../../checkout-attempt/types/checkout-attempt.types';
import { CheckoutAttemptService } from '../../checkout-attempt/services/checkout-attempt.service';
import { CHECKOUT_HEARTBEAT_FRESHNESS_SECONDS } from '../../inventory/constants/inventory.constants';
import { CheckoutRecoverySettlementRepository } from '../repositories/checkout-recovery-settlement.repository';
import { CheckoutStaleSettlementService } from './checkout-stale-settlement.service';
import { CheckoutRecoveryLease, CheckoutRecoveryOwnershipLost } from './checkout-recovery-lock.service';
import { CheckoutRecoveryTelemetryService } from './checkout-recovery-telemetry.service';

export const CHECKOUT_RECOVERY_PAGE_SIZE = 100;
@Injectable()
export class CheckoutRecoveryWorkerService {
  private staleCursor: StaleCheckoutAttemptCursor | null = null;
  private cleanupCursor: string | null = null;
  constructor(private readonly attempts: CheckoutAttemptService,
    private readonly repository: CheckoutRecoverySettlementRepository,
    private readonly settlement: CheckoutStaleSettlementService,
    private readonly telemetry: CheckoutRecoveryTelemetryService) {}

  async runCycle(lease: CheckoutRecoveryLease): Promise<void> {
    const observedAt = new Date();
    const staleBefore = new Date(observedAt.getTime() - CHECKOUT_HEARTBEAT_FRESHNESS_SECONDS * 1000);
    await lease.assertHeld();
    // Snapshot pending obligations first; newly authorized work is not selected twice.
    const cleanup = await this.repository.findPendingStaleSettlementsPage({ afterManifestId: this.cleanupCursor, limit: CHECKOUT_RECOVERY_PAGE_SIZE });
    const stale = await this.attempts.findStalePage({ heartbeatBefore: staleBefore, cursor: this.staleCursor, limit: CHECKOUT_RECOVERY_PAGE_SIZE });
    if (!stale.ok) throw new Error('Invalid internal stale discovery');
    for (const obligation of cleanup) {
      await this.process(lease, () => Promise.resolve(obligation.id));
      this.cleanupCursor = obligation.id;
    }
    if (cleanup.length < CHECKOUT_RECOVERY_PAGE_SIZE) this.cleanupCursor = null;
    for (const candidate of stale.page.items) {
      await lease.assertHeld();
      if (candidate.selectedPath !== 'CART_SCOPED') {
        this.telemetry.record('checkout_recovery_skipped', candidate.selectedPath === null ? 'UNKNOWN_PATH' : 'UNSUPPORTED_LEGACY', candidate.selectedPath);
      } else {
        await this.process(lease, async () => {
          const result = await this.repository.authorizeStaleRecoverySettlement({ attemptId: candidate.id,
            customerId: candidate.customerId, observedHeartbeatAt: candidate.lastHeartbeatAt, staleBefore, observedAt });
          if (result.code === 'AUTHORIZED') return result.manifestId;
          this.telemetry.record('checkout_recovery_skipped', result.code === 'FINALIZATION_REQUIRED'
            ? 'FINALIZATION_REQUIRED' : 'SETTLEMENT_AUTHORITY_REQUIRED', 'CART_SCOPED');
          return null;
        });
      }
      this.staleCursor = { id: candidate.id, lastHeartbeatAt: candidate.lastHeartbeatAt };
    }
    if (!stale.page.nextCursor) this.staleCursor = null;
  }

  private async process(lease: CheckoutRecoveryLease, reference: () => Promise<string | null>): Promise<void> {
    await lease.assertHeld();
    const started = Date.now();
    try {
      const id = await reference();
      if (id === null) return;
      await lease.assertHeld();
      const result = await this.settlement.continueStaleRecoverySettlement(id);
      await lease.assertHeld();
      this.telemetry.record(result.code === 'SETTLED' ? 'checkout_pending_recovered' : 'checkout_recovery_failed',
        result.code === 'SETTLED' ? 'SETTLEMENT_ACKNOWLEDGED' : 'CLEANUP_INCOMPLETE', 'CART_SCOPED', Date.now() - started);
    } catch (error) {
      if (error instanceof CheckoutRecoveryOwnershipLost) throw error;
      await lease.assertHeld();
      this.telemetry.record('checkout_recovery_failed', 'ATTEMPT_FAILURE', 'CART_SCOPED');
    }
  }
}
