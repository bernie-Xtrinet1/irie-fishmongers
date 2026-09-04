import { Injectable, Logger } from '@nestjs/common';

import { sanitizeErrorMessage } from '../../../common/utils/sanitize-error-message.util';
import { PaymentsRepository } from '../repositories/payments.repository';
import {
  PaymentReconciliationOutcome,
  PaymentReconciliationService,
} from './payment-reconciliation.service';

export const DEFAULT_PAYMENT_RECONCILIATION_BATCH_SIZE = 50;
export const MAX_PAYMENT_RECONCILIATION_BATCH_SIZE = 200;
const MAX_PAYMENT_RECONCILIATION_ERROR_LENGTH = 500;

export interface PaymentReconciliationBatchInput {
  now: Date;
  candidateStaleBefore: Date;
  claimStaleBefore: Date;
  limit?: number;
}

export interface PaymentReconciliationBatchError {
  paymentId: string;
  message: string;
}

export interface PaymentReconciliationBatchResult {
  candidatesFound: number;
  attempted: number;
  pending: number;
  paid: number;
  failed: number;
  skipped: number;
  providerReferenceMismatch: number;
  staleClaim: number;
  errors: PaymentReconciliationBatchError[];
  durationMs: number;
}

export type RunPaymentReconciliationBatchResult =
  | {
      ok: true;
      result: PaymentReconciliationBatchResult;
    }
  | {
      ok: false;
      code: 'INVALID_INPUT';
      field: string;
      reason: string;
    };

interface MutableCounters {
  pending: number;
  paid: number;
  failed: number;
  skipped: number;
  providerReferenceMismatch: number;
  staleClaim: number;
}

@Injectable()
export class PaymentReconciliationBatchService {
  private readonly logger = new Logger(
    PaymentReconciliationBatchService.name,
  );

  constructor(
    private readonly paymentsRepository: PaymentsRepository,
    private readonly reconciliationService: PaymentReconciliationService,
  ) {}

  async runBatch(
    input: PaymentReconciliationBatchInput,
  ): Promise<RunPaymentReconciliationBatchResult> {
    const validationFailure =
      PaymentReconciliationBatchService.validateInput(input);

    if (validationFailure) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        ...validationFailure,
      };
    }

    const limit =
      input.limit ?? DEFAULT_PAYMENT_RECONCILIATION_BATCH_SIZE;
    const startedAt = Date.now();

    const candidates =
      await this.paymentsRepository.findAutomaticRecoveryCandidates(
        input.candidateStaleBefore,
        limit,
      );

    const counters: MutableCounters = {
      pending: 0,
      paid: 0,
      failed: 0,
      skipped: 0,
      providerReferenceMismatch: 0,
      staleClaim: 0,
    };

    const errors: PaymentReconciliationBatchError[] = [];
    let attempted = 0;

    for (const candidate of candidates) {
      attempted += 1;

      try {
        const result = await this.reconciliationService.reconcilePayment(
          candidate.id,
          input.now,
          input.claimStaleBefore,
        );

        PaymentReconciliationBatchService.tallyOutcome(
          counters,
          result.outcome,
        );
      } catch (error) {
        const message =
          sanitizeErrorMessage(
            PaymentReconciliationBatchService.errorMessage(error),
            MAX_PAYMENT_RECONCILIATION_ERROR_LENGTH,
          ) ?? '[error message unavailable after sanitization]';

        this.logger.warn(
          'Payment reconciliation batch candidate failed',
          {
            paymentId: candidate.id,
            message,
          },
        );

        errors.push({
          paymentId: candidate.id,
          message,
        });
      }
    }

    const result: PaymentReconciliationBatchResult = {
      candidatesFound: candidates.length,
      attempted,
      ...counters,
      errors,
      durationMs: Date.now() - startedAt,
    };

    this.logger.log('Payment reconciliation batch run complete', result);

    return { ok: true, result };
  }

  private static validateInput(
    input: PaymentReconciliationBatchInput,
  ): { field: string; reason: string } | null {
    if (
      !(input.now instanceof Date) ||
      Number.isNaN(input.now.getTime())
    ) {
      return { field: 'now', reason: 'now must be a valid Date' };
    }

    if (
      !(input.candidateStaleBefore instanceof Date) ||
      Number.isNaN(input.candidateStaleBefore.getTime())
    ) {
      return {
        field: 'candidateStaleBefore',
        reason: 'candidateStaleBefore must be a valid Date',
      };
    }

    if (
      !(input.claimStaleBefore instanceof Date) ||
      Number.isNaN(input.claimStaleBefore.getTime())
    ) {
      return {
        field: 'claimStaleBefore',
        reason: 'claimStaleBefore must be a valid Date',
      };
    }

    if (input.candidateStaleBefore >= input.now) {
      return {
        field: 'candidateStaleBefore',
        reason: 'candidateStaleBefore must be earlier than now',
      };
    }

    if (input.claimStaleBefore >= input.now) {
      return {
        field: 'claimStaleBefore',
        reason: 'claimStaleBefore must be earlier than now',
      };
    }

    if (input.limit !== undefined) {
      if (!Number.isInteger(input.limit) || input.limit <= 0) {
        return {
          field: 'limit',
          reason: 'limit must be a positive integer',
        };
      }

      if (input.limit > MAX_PAYMENT_RECONCILIATION_BATCH_SIZE) {
        return {
          field: 'limit',
          reason:
            `limit must not exceed ${MAX_PAYMENT_RECONCILIATION_BATCH_SIZE}`,
        };
      }
    }

    return null;
  }

  private static tallyOutcome(
    counters: MutableCounters,
    outcome: PaymentReconciliationOutcome,
  ): void {
    switch (outcome) {
      case 'PENDING':
        counters.pending += 1;
        return;
      case 'PAID':
        counters.paid += 1;
        return;
      case 'FAILED':
        counters.failed += 1;
        return;
      case 'SKIPPED':
        counters.skipped += 1;
        return;
      case 'PROVIDER_REFERENCE_MISMATCH':
        counters.providerReferenceMismatch += 1;
        return;
      case 'STALE_CLAIM':
        counters.staleClaim += 1;
        return;
      default: {
        const exhaustiveCheck: never = outcome;
        void exhaustiveCheck;
        throw new Error('Unhandled PaymentReconciliationOutcome');
      }
    }
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
