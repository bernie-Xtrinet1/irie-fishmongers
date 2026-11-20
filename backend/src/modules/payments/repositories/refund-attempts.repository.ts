import { Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma, RefundObligationStatus, RefundStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  PrepareRefundAttemptInput,
  PrepareRefundAttemptResult,
  QuarantineAttemptInput,
  RecordAttemptOutcomeInput,
  RecordPreSendAbortInput,
  RefundAttemptOutcomeResult,
} from '../types/refund-ledger.types';
import {
  executePreSendAbortTx,
  executeQuarantineOutcomeTx,
  executeSyncOutcomeTx,
} from './refund-attempt-outcomes.helper';
import { createAndClaimAttemptTx } from './refund-attempt-claim.helper';
import { resolveOrCreateObligationAndRefundTx } from './refund-attempt-preparation.helper';
import {
  computeRemainingRefundCapacityTx,
  lockPaymentObligationsAndRefunds,
  lockRefundFinancialHierarchy,
} from './refund-locks.helper';

@Injectable()
export class RefundAttemptsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async prepareAndClaimAttempt(
    input: PrepareRefundAttemptInput,
    externalTx?: Prisma.TransactionClient,
  ): Promise<PrepareRefundAttemptResult> {
    const run = async (tx: Prisma.TransactionClient): Promise<PrepareRefundAttemptResult> => {
      const requestedAmount = new Prisma.Decimal(input.amount);
      if (requestedAmount.lte(0)) {
        return {
          action: 'TERMINAL_FAILED',
          errorReason: 'Refund amount must be greater than zero',
          remainingBalance: new Prisma.Decimal(0),
        };
      }

      const payment = await lockRefundFinancialHierarchy(tx, input.paymentId, input.orderId);
      if (!payment) {
        return {
          action: 'TERMINAL_FAILED',
          errorReason: 'Payment not found',
          remainingBalance: new Prisma.Decimal(0),
        };
      }
      if (
        payment.status !== PaymentStatus.PAID &&
        payment.status !== PaymentStatus.PARTIALLY_REFUNDED
      ) {
        return {
          action: 'TERMINAL_FAILED',
          errorReason: 'Only paid or partially refunded payments can be refunded',
          remainingBalance: new Prisma.Decimal(0),
        };
      }

      await lockPaymentObligationsAndRefunds(tx, payment.id);

      const resolved = await resolveOrCreateObligationAndRefundTx(
        tx,
        payment,
        requestedAmount,
        input,
      );
      if (resolved.earlyReturn) {
        return resolved.earlyReturn;
      }

      const { obligation, refund } = resolved;
      const attempt = await createAndClaimAttemptTx(tx, payment, obligation, refund, input);

      const syncedRefund =
        refund.status === RefundStatus.PROCESSING
          ? refund
          : await tx.refund.update({
              where: { id: refund.id },
              data: { status: RefundStatus.PROCESSING },
            });

      const syncedObligation =
        obligation.status === RefundObligationStatus.IN_FLIGHT
          ? obligation
          : await tx.refundObligation.update({
              where: { id: obligation.id },
              data: { status: RefundObligationStatus.IN_FLIGHT },
            });

      const remainingAfter = (
        await computeRemainingRefundCapacityTx(tx, payment.id, payment.amount)
      ).remainingBalance;

      return {
        action: 'DISPATCH',
        obligation: syncedObligation,
        refund: syncedRefund,
        attempt,
        parentPaymentReference: payment.providerReference,
        provider: payment.provider,
        merchantAccountId: payment.merchantAccountId,
        remainingBalance: remainingAfter,
      };
    };

    if (externalTx) {
      return run(externalTx);
    }
    return this.prisma.$transaction(run, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 15_000,
      timeout: 15_000,
    });
  }

  async recordPreSendAbort(
    input: RecordPreSendAbortInput,
    externalTx?: Prisma.TransactionClient,
  ): Promise<RefundAttemptOutcomeResult> {
    if (externalTx) {
      return executePreSendAbortTx(externalTx, input);
    }
    return this.prisma.$transaction((tx) => executePreSendAbortTx(tx, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 15_000,
      timeout: 15_000,
    });
  }

  async recordSyncOutcomeAndOutbox(
    input: RecordAttemptOutcomeInput,
    externalTx?: Prisma.TransactionClient,
  ): Promise<RefundAttemptOutcomeResult> {
    if (externalTx) {
      return executeSyncOutcomeTx(externalTx, input);
    }
    return this.prisma.$transaction((tx) => executeSyncOutcomeTx(tx, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 15_000,
      timeout: 15_000,
    });
  }

  async quarantineAttemptOutcome(
    input: QuarantineAttemptInput,
    externalTx?: Prisma.TransactionClient,
  ): Promise<RefundAttemptOutcomeResult> {
    if (externalTx) {
      return executeQuarantineOutcomeTx(externalTx, input);
    }
    return this.prisma.$transaction((tx) => executeQuarantineOutcomeTx(tx, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 15_000,
      timeout: 15_000,
    });
  }
}
