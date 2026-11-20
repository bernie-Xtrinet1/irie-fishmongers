import { randomUUID } from 'crypto';

import { ConflictException } from '@nestjs/common';
import {
  PaymentStatus,
  Prisma,
  Refund,
  RefundAttemptStatus,
  RefundObligation,
  RefundObligationStatus,
  RefundStatus,
} from '@prisma/client';

import {
  computeRemainingRefundCapacityTx,
  deriveObligationType,
  lockPaymentObligationsAndRefunds,
  lockRefundFinancialHierarchy,
} from './refund-locks.helper';

export interface ReserveRefundInput {
  paymentId: string;
  amount: number | Prisma.Decimal | string;
  reason: string;
  idempotencyKey?: string | null;
  orderId?: string | null;
  obligationId?: string | null;
  allowReplacementRetry?: boolean;
}

export interface RefundReservationResult {
  status:
    | 'RESERVED'
    | 'ALREADY_COMPLETED'
    | 'IN_FLIGHT'
    | 'RECONCILE_REQUIRED'
    | 'TERMINAL_FAILED'
    | 'EXCEEDS_BALANCE';
  refund?: Refund;
  obligation?: RefundObligation;
  remainingBalance: Prisma.Decimal;
  unreservedBalance: Prisma.Decimal;
  errorReason?: string;
}

interface OptionalRefundLedgerTx {
  refundObligation?: Prisma.TransactionClient['refundObligation'];
  refundProviderAttempt?: Prisma.TransactionClient['refundProviderAttempt'];
}

export async function executeReserveRefundTx(
  tx: Prisma.TransactionClient,
  input: ReserveRefundInput,
): Promise<RefundReservationResult> {
  const requestedAmount = new Prisma.Decimal(input.amount);
  if (requestedAmount.lte(0)) {
    return {
      status: 'TERMINAL_FAILED',
      errorReason: 'Refund amount must be greater than zero',
      remainingBalance: new Prisma.Decimal(0),
      unreservedBalance: new Prisma.Decimal(0),
    };
  }

  const paymentRow = await lockRefundFinancialHierarchy(tx, input.paymentId, input.orderId);
  if (!paymentRow) {
    return {
      status: 'TERMINAL_FAILED',
      errorReason: 'Payment not found',
      remainingBalance: new Prisma.Decimal(0),
      unreservedBalance: new Prisma.Decimal(0),
    };
  }

  if (
    paymentRow.status !== PaymentStatus.PAID &&
    paymentRow.status !== PaymentStatus.PARTIALLY_REFUNDED
  ) {
    return {
      status: 'TERMINAL_FAILED',
      errorReason: 'Only paid or partially refunded payments can be refunded',
      remainingBalance: new Prisma.Decimal(0),
      unreservedBalance: new Prisma.Decimal(0),
    };
  }

  await lockPaymentObligationsAndRefunds(tx, paymentRow.id);
  const optTx = tx as unknown as OptionalRefundLedgerTx;

  let existingRefund: Refund | null = null;
  if (input.idempotencyKey) {
    existingRefund = await tx.refund.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existingRefund) {
      if (existingRefund.paymentId !== input.paymentId) {
        throw new ConflictException(
          `Idempotency key "${input.idempotencyKey}" belongs to a different payment`,
        );
      }
      if (!new Prisma.Decimal(existingRefund.amount).equals(requestedAmount)) {
        throw new ConflictException(
          `Idempotency key "${input.idempotencyKey}" has conflicting amount`,
        );
      }
    }
  }

  let obligation: RefundObligation | null = null;
  if (optTx.refundObligation) {
    if (input.obligationId) {
      obligation = await optTx.refundObligation.findUnique({ where: { id: input.obligationId } });
    } else if (existingRefund?.obligationId) {
      obligation = await optTx.refundObligation.findUnique({
        where: { id: existingRefund.obligationId },
      });
    } else if (input.idempotencyKey) {
      obligation = await optTx.refundObligation.findUnique({
        where: { obligationKey: input.idempotencyKey },
      });
    }

    if (obligation) {
      if (obligation.status === RefundObligationStatus.CANCELLED_VOIDED) {
        return {
          status: 'TERMINAL_FAILED',
          obligation,
          refund: existingRefund ?? undefined,
          errorReason: 'Refund obligation was voided',
          remainingBalance: new Prisma.Decimal(0),
          unreservedBalance: new Prisma.Decimal(0),
        };
      }
      if (optTx.refundProviderAttempt) {
        const activeAttempt = await optTx.refundProviderAttempt.findFirst({
          where: {
            obligationId: obligation.id,
            status: {
              in: [
                RefundAttemptStatus.PREPARED,
                RefundAttemptStatus.DISPATCHING,
                RefundAttemptStatus.PROVIDER_PENDING,
                RefundAttemptStatus.AMBIGUOUS_OUTCOME,
              ],
            },
          },
        });
        if (activeAttempt) {
          const targetRefund =
            existingRefund ??
            (await tx.refund.findUniqueOrThrow({ where: { id: activeAttempt.refundId } }));
          return {
            status:
              activeAttempt.status === RefundAttemptStatus.AMBIGUOUS_OUTCOME
                ? 'RECONCILE_REQUIRED'
                : 'IN_FLIGHT',
            obligation,
            refund: targetRefund,
            remainingBalance: new Prisma.Decimal(0),
            unreservedBalance: new Prisma.Decimal(0),
          };
        }
      }
    }
  }

  if (existingRefund) {
    if (existingRefund.status === RefundStatus.COMPLETED) {
      return {
        status: 'ALREADY_COMPLETED',
        refund: existingRefund,
        obligation: obligation ?? undefined,
        remainingBalance: new Prisma.Decimal(0),
        unreservedBalance: new Prisma.Decimal(0),
      };
    }
    if (existingRefund.status === RefundStatus.RECONCILE_REQUIRED) {
      return {
        status: 'RECONCILE_REQUIRED',
        refund: existingRefund,
        obligation: obligation ?? undefined,
        remainingBalance: new Prisma.Decimal(0),
        unreservedBalance: new Prisma.Decimal(0),
      };
    }
    if (
      existingRefund.status === RefundStatus.PROCESSING ||
      existingRefund.status === RefundStatus.PENDING
    ) {
      return {
        status: 'IN_FLIGHT',
        refund: existingRefund,
        obligation: obligation ?? undefined,
        remainingBalance: new Prisma.Decimal(0),
        unreservedBalance: new Prisma.Decimal(0),
      };
    }
    if (existingRefund.status === RefundStatus.FAILED) {
      if (!input.allowReplacementRetry || !obligation) {
        return {
          status: 'TERMINAL_FAILED',
          refund: existingRefund,
          obligation: obligation ?? undefined,
          errorReason: 'Refund previously failed definitively for this idempotency key',
          remainingBalance: new Prisma.Decimal(0),
          unreservedBalance: new Prisma.Decimal(0),
        };
      }
      const retryCount = await tx.refund.count({ where: { obligationId: obligation.id } });
      const replacement = await tx.refund.create({
        data: {
          paymentId: input.paymentId,
          obligationId: obligation.id,
          supersedesRefundId: existingRefund.id,
          amount: requestedAmount,
          reason: input.reason,
          status: RefundStatus.PROCESSING,
          idempotencyKey: `${existingRefund.idempotencyKey}:retry:${retryCount + 1}`,
        },
      });
      return {
        status: 'RESERVED',
        refund: replacement,
        obligation,
        remainingBalance: new Prisma.Decimal(0),
        unreservedBalance: new Prisma.Decimal(0),
      };
    }
    const updated = await tx.refund.update({
      where: { id: existingRefund.id },
      data: { status: RefundStatus.PROCESSING },
    });
    return {
      status: 'RESERVED',
      refund: updated,
      obligation: obligation ?? undefined,
      remainingBalance: new Prisma.Decimal(0),
      unreservedBalance: new Prisma.Decimal(0),
    };
  }

  if (obligation && input.allowReplacementRetry) {
    const lastFailed = await tx.refund.findFirst({
      where: { obligationId: obligation.id, status: RefundStatus.FAILED },
      orderBy: { createdAt: 'desc' },
    });
    if (lastFailed) {
      const retryCount = await tx.refund.count({ where: { obligationId: obligation.id } });
      const replacement = await tx.refund.create({
        data: {
          paymentId: input.paymentId,
          obligationId: obligation.id,
          supersedesRefundId: lastFailed.id,
          amount: requestedAmount,
          reason: input.reason,
          status: RefundStatus.PROCESSING,
          idempotencyKey: `${obligation.obligationKey}:retry:${retryCount + 1}`,
        },
      });
      return {
        status: 'RESERVED',
        refund: replacement,
        obligation,
        remainingBalance: new Prisma.Decimal(0),
        unreservedBalance: new Prisma.Decimal(0),
      };
    }
  }

  const capacity = await computeRemainingRefundCapacityTx(tx, input.paymentId, paymentRow.amount);
  if (capacity.remainingBalance.lte(0) || requestedAmount.gt(capacity.remainingBalance)) {
    return {
      status: 'EXCEEDS_BALANCE',
      remainingBalance: capacity.remainingBalance,
      unreservedBalance: capacity.remainingBalance,
      errorReason: 'Refund amount exceeds the remaining refundable balance',
    };
  }

  if (optTx.refundObligation && !obligation) {
    obligation = await optTx.refundObligation.create({
      data: {
        id: randomUUID(),
        paymentId: input.paymentId,
        orderId: paymentRow.orderId,
        obligationKey: input.idempotencyKey ?? `obl:${randomUUID()}`,
        obligationType: deriveObligationType(input.idempotencyKey),
        authorizedAmount: requestedAmount,
        currency: paymentRow.currency ?? 'JMD',
        reason: input.reason,
        status: RefundObligationStatus.OPEN,
      },
    });
  }

  const newRefund = await tx.refund.create({
    data: {
      paymentId: input.paymentId,
      ...(obligation ? { obligationId: obligation.id } : {}),
      amount: requestedAmount,
      reason: input.reason,
      status: RefundStatus.PROCESSING,
      idempotencyKey: input.idempotencyKey ?? null,
    },
  });

  const newRemaining = capacity.remainingBalance.sub(requestedAmount);
  return {
    status: 'RESERVED',
    refund: newRefund,
    obligation: obligation ?? undefined,
    remainingBalance: newRemaining,
    unreservedBalance: newRemaining,
  };
}
