import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { sanitizeErrorMessage } from '../../../common/utils/sanitize-error-message.util';
import { PaymentReconciliationBatchService } from './payment-reconciliation-batch.service';

const PAYMENT_RECONCILIATION_STALE_WINDOW_MS = 5 * 60 * 1000;
const MAX_PAYMENT_RECONCILIATION_SCHEDULER_ERROR_LENGTH = 500;

@Injectable()
export class PaymentReconciliationSchedulerService {
  private readonly logger = new Logger(
    PaymentReconciliationSchedulerService.name,
  );
  private running = false;

  constructor(
    private readonly batchService: PaymentReconciliationBatchService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async runScheduledBatch(): Promise<void> {
    if (this.running) {
      this.logger.warn(
        'Payment reconciliation scheduler tick skipped - previous local run still executing',
      );
      return;
    }

    this.running = true;

    try {
      const now = new Date();
      const candidateStaleBefore = new Date(
        now.getTime() - PAYMENT_RECONCILIATION_STALE_WINDOW_MS,
      );
      const claimStaleBefore = new Date(
        now.getTime() - PAYMENT_RECONCILIATION_STALE_WINDOW_MS,
      );

      const result = await this.batchService.runBatch({
        now,
        candidateStaleBefore,
        claimStaleBefore,
      });

      if (!result.ok) {
        this.logger.error(
          'Payment reconciliation scheduler received INVALID_INPUT - internal invariant failure',
          {
            code: result.code,
            field: result.field,
            reason: result.reason,
          },
        );
      }
    } catch (error) {
      this.logger.error('Payment reconciliation batch run threw unexpectedly', {
        message: sanitizeErrorMessage(
          PaymentReconciliationSchedulerService.errorMessage(error),
          MAX_PAYMENT_RECONCILIATION_SCHEDULER_ERROR_LENGTH,
        ),
      });
    } finally {
      this.running = false;
    }
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
