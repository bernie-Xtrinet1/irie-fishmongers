import { Injectable } from '@nestjs/common';

import { RefundDispatchActor } from '../types/refund-ledger.types';
import {
  RecoverExpiredAttemptOutcome,
  RecoverExpiredLeasesSummary,
} from '../types/refund-reconciliation.types';
import { RefundRecoveryRepository } from '../repositories/refund-recovery.repository';

/**
 * Internal-only crash recovery service for refund dispatch attempts.
 * Moves expired DISPATCHING leases into AMBIGUOUS_OUTCOME (RECONCILE_REQUIRED)
 * without ever issuing automatic retries or second gateway dispatch calls.
 */
@Injectable()
export class RefundRecoveryService {
  constructor(private readonly refundRecoveryRepository: RefundRecoveryRepository) {}

  recoverAttempt(
    attemptId: string,
    referenceTime = new Date(),
    actor?: RefundDispatchActor,
  ): Promise<RecoverExpiredAttemptOutcome> {
    return this.refundRecoveryRepository.recoverExpiredAttempt(attemptId, referenceTime, actor);
  }

  recoverExpiredLeases(
    referenceTime = new Date(),
    limit = 50,
    actor?: RefundDispatchActor,
  ): Promise<RecoverExpiredLeasesSummary> {
    return this.refundRecoveryRepository.recoverExpiredLeases(referenceTime, limit, actor);
  }
}
