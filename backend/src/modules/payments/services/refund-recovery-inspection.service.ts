import { Injectable } from '@nestjs/common';
import { RefundProviderAttempt } from '@prisma/client';

import { RefundReconciliationRepository } from '../repositories/refund-reconciliation.repository';
import { RefundAttemptInspectionRecord } from '../types/refund-ledger.types';

/**
 * Internal read-only refund attempt inspection and expired-lease quarantine service.
 * Intentionally does NOT schedule background crons or expose public endpoints,
 * and NEVER re-calls external payment providers on ambiguous outcomes.
 */
@Injectable()
export class RefundRecoveryInspectionService {
  constructor(
    private readonly refundReconciliationRepository: RefundReconciliationRepository,
  ) {}

  inspectByObligationId(obligationId: string): Promise<RefundAttemptInspectionRecord | null> {
    return this.refundReconciliationRepository.inspectByObligationId(obligationId);
  }

  inspectByRefundId(refundId: string): Promise<RefundAttemptInspectionRecord | null> {
    return this.refundReconciliationRepository.inspectByRefundId(refundId);
  }

  listQuarantinedAndActiveAttempts(paymentId?: string): Promise<RefundProviderAttempt[]> {
    return this.refundReconciliationRepository.listQuarantinedAndActiveAttempts(paymentId);
  }

  quarantineExpiredDispatchingAttempts(referenceTime = new Date()): Promise<string[]> {
    return this.refundReconciliationRepository.quarantineExpiredDispatchingAttempts(referenceTime);
  }
}
