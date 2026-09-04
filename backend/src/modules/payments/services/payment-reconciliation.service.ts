import { Injectable, Logger } from '@nestjs/common';

import { PaymentsRepository } from '../repositories/payments.repository';
import { PaymentsService } from './payments.service';

export type PaymentReconciliationOutcome =
  | 'SKIPPED'
  | 'PROVIDER_REFERENCE_MISMATCH'
  | 'STALE_CLAIM'
  | 'PENDING'
  | 'PAID'
  | 'FAILED';

export interface PaymentReconciliationResult {
  paymentId: string;
  outcome: PaymentReconciliationOutcome;
}

@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  constructor(
    private readonly paymentsRepository: PaymentsRepository,
    private readonly paymentsService: PaymentsService,
  ) {}

  async reconcilePayment(
    paymentId: string,
    now: Date,
    claimStaleBefore: Date,
  ): Promise<PaymentReconciliationResult> {
    if (
      Number.isNaN(now.getTime()) ||
      Number.isNaN(claimStaleBefore.getTime()) ||
      claimStaleBefore.getTime() >= now.getTime()
    ) {
      throw new Error('claimStaleBefore must be earlier than now');
    }

    const claimed = await this.paymentsRepository.claimForRecovery(
      paymentId,
      now,
      claimStaleBefore,
    );

    if (!claimed) {
      return { paymentId, outcome: 'SKIPPED' };
    }

    const providerReference = claimed.providerReference;
    if (!providerReference) {
      throw new Error(
        `Invariant violation: claimed payment "${paymentId}" has no provider reference`,
      );
    }

    let verified;
    try {
      verified = await this.paymentsService.verifyProviderPayment(
        claimed.provider,
        providerReference,
      );
    } catch (error) {
      try {
        await this.paymentsRepository.releaseRecoveryClaimIfCurrent(
          paymentId,
          claimed.recoveryAttemptCount,
        );
      } catch (releaseError) {
        this.logger.warn(
          'Failed to release payment recovery claim after provider verification error',
          {
            paymentId,
            recoveryAttemptCount: claimed.recoveryAttemptCount,
            message:
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError),
          },
        );
      }

      throw error;
    }

    if (verified.providerReference !== providerReference) {
      await this.paymentsRepository.releaseRecoveryClaimIfCurrent(
        paymentId,
        claimed.recoveryAttemptCount,
      );

      this.logger.warn('Payment provider verification reference mismatch', {
        paymentId,
        recoveryAttemptCount: claimed.recoveryAttemptCount,
      });

      return {
        paymentId,
        outcome: 'PROVIDER_REFERENCE_MISMATCH',
      };
    }

    const result =
      await this.paymentsRepository.applyRecoveryVerificationIfCurrent(
        paymentId,
        claimed.recoveryAttemptCount,
        providerReference,
        verified.status,
        now,
      );

    if (!result.applied) {
      return { paymentId, outcome: 'STALE_CLAIM' };
    }

    if (!result.payment) {
      throw new Error(
        `Internal consistency error: payment "${paymentId}" disappeared after recovery verification`,
      );
    }

    if (result.transitionedToPaid) {
      await this.paymentsService.emitRecoveredPaymentConfirmed(result.payment);
    }

    return {
      paymentId,
      outcome: verified.status,
    };
  }
}
