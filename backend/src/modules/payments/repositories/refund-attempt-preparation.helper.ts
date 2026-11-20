import { randomUUID } from 'crypto';

import { ConflictException } from '@nestjs/common';
import {
  Prisma,
  Refund,
  RefundAttemptStatus,
  RefundObligation,
  RefundObligationStatus,
  RefundStatus,
} from '@prisma/client';

import {
  PrepareRefundAttemptInput,
  PrepareRefundAttemptResult,
} from '../types/refund-ledger.types';
import {
  computeRemainingRefundCapacityTx,
  deriveObligationType,
  LockedRefundPaymentRow,
} from './refund-locks.helper';

const NON_TERMINAL_ATTEMPT_STATUSES: RefundAttemptStatus[] = [
  RefundAttemptStatus.PREPARED,
  RefundAttemptStatus.DISPATCHING,
  RefundAttemptStatus.PROVIDER_PENDING,
  RefundAttemptStatus.AMBIGUOUS_OUTCOME,
];

export async function resolveOrCreateObligationAndRefundTx(
  tx: Prisma.TransactionClient,
  payment: LockedRefundPaymentRow,
  requestedAmount: Prisma.Decimal,
  input: PrepareRefundAttemptInput,
): Promise<
  | { earlyReturn: PrepareRefundAttemptResult; obligation?: undefined; refund?: undefined }
  | { earlyReturn?: undefined; obligation: RefundObligation; refund: Refund }
> {
  const existingRefundByKey = input.idempotencyKey
    ? await tx.refund.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
    : null;

  if (existingRefundByKey) {
    if (existingRefundByKey.paymentId !== input.paymentId) {
      throw new ConflictException(
        `Idempotency key "${input.idempotencyKey}" belongs to a different payment`,
      );
    }
    if (!new Prisma.Decimal(existingRefundByKey.amount).equals(requestedAmount)) {
      throw new ConflictException(
        `Idempotency key "${input.idempotencyKey}" has conflicting amount`,
      );
    }
  }

  let obligation: RefundObligation | null = null;
  if (input.obligationId) {
    obligation = await tx.refundObligation.findUnique({ where: { id: input.obligationId } });
  } else if (existingRefundByKey?.obligationId) {
    obligation = await tx.refundObligation.findUnique({
      where: { id: existingRefundByKey.obligationId },
    });
  } else if (input.idempotencyKey) {
    obligation = await tx.refundObligation.findUnique({
      where: { obligationKey: input.idempotencyKey },
    });
  }

  if (obligation) {
    if (obligation.paymentId !== payment.id) {
      throw new ConflictException(`Obligation "${obligation.id}" belongs to another payment`);
    }
    if (!new Prisma.Decimal(obligation.authorizedAmount).equals(requestedAmount)) {
      throw new ConflictException(`Obligation "${obligation.id}" amount mismatch`);
    }

    const activeAttempt = await tx.refundProviderAttempt.findFirst({
      where: {
        obligationId: obligation.id,
        status: { in: [...NON_TERMINAL_ATTEMPT_STATUSES, RefundAttemptStatus.COMPLETED] },
      },
      orderBy: { attemptSequence: 'desc' },
    });

    if (obligation.status === RefundObligationStatus.FULFILLED || activeAttempt) {
      const targetRefund = activeAttempt
        ? await tx.refund.findUniqueOrThrow({ where: { id: activeAttempt.refundId } })
        : existingRefundByKey ??
          (await tx.refund.findFirstOrThrow({
            where: { obligationId: obligation.id },
            orderBy: { createdAt: 'desc' },
          }));
      return {
        earlyReturn: {
          action: 'RETURN_EXISTING',
          obligation,
          refund: targetRefund,
          attempt: activeAttempt ?? undefined,
          remainingBalance: new Prisma.Decimal(0),
        },
      };
    }

    if (obligation.status === RefundObligationStatus.CANCELLED_VOIDED) {
      return {
        earlyReturn: {
          action: 'TERMINAL_FAILED',
          obligation,
          refund: existingRefundByKey ?? undefined,
          errorReason: 'Refund obligation was voided via dual-control reconciliation',
          remainingBalance: new Prisma.Decimal(0),
        },
      };
    }

    if (obligation.status === RefundObligationStatus.RECONCILE_REQUIRED) {
      throw new ConflictException(
        `Refund obligation "${obligation.id}" is in RECONCILE_REQUIRED and cannot dispatch new refund attempts`,
      );
    }
  }

  if (existingRefundByKey) {
    if (
      existingRefundByKey.status === RefundStatus.COMPLETED ||
      existingRefundByKey.status === RefundStatus.PENDING ||
      existingRefundByKey.status === RefundStatus.PROCESSING ||
      existingRefundByKey.status === RefundStatus.RECONCILE_REQUIRED
    ) {
      return {
        earlyReturn: {
          action: 'RETURN_EXISTING',
          obligation: obligation ?? undefined,
          refund: existingRefundByKey,
          remainingBalance: new Prisma.Decimal(0),
        },
      };
    }

    if (existingRefundByKey.status === RefundStatus.FAILED) {
      if (!input.allowReplacementRetry || !obligation) {
        return {
          earlyReturn: {
            action: 'TERMINAL_FAILED',
            obligation: obligation ?? undefined,
            refund: existingRefundByKey,
            errorReason: 'Refund previously failed definitively for this idempotency key',
            remainingBalance: new Prisma.Decimal(0),
          },
        };
      }

      const latestAttempt = await tx.refundProviderAttempt.findFirst({
        where: { refundId: existingRefundByKey.id },
        orderBy: { attemptSequence: 'desc' },
      });
      if (!latestAttempt?.retryEligible) {
        return {
          earlyReturn: {
            action: 'TERMINAL_FAILED',
            obligation,
            refund: existingRefundByKey,
            errorReason: 'Previous failed attempt is not eligible for retry replacement',
            remainingBalance: new Prisma.Decimal(0),
          },
        };
      }

      const attemptCount = await tx.refundProviderAttempt.count({
        where: { obligationId: obligation.id },
      });
      const replacementRefund = await tx.refund.create({
        data: {
          id: randomUUID(),
          paymentId: payment.id,
          obligationId: obligation.id,
          supersedesRefundId: existingRefundByKey.id,
          idempotencyKey: `${existingRefundByKey.idempotencyKey}:retry:${attemptCount + 1}`,
          amount: requestedAmount,
          reason: input.reason,
          status: RefundStatus.PROCESSING,
        },
      });
      return { obligation, refund: replacementRefund };
    }

    if (!obligation) {
      obligation = await tx.refundObligation.create({
        data: {
          id: randomUUID(),
          paymentId: payment.id,
          orderId: payment.orderId,
          vendorOrderId: input.vendorOrderId ?? null,
          obligationKey: existingRefundByKey.idempotencyKey ?? `obl:${existingRefundByKey.id}`,
          obligationType: deriveObligationType(
            existingRefundByKey.idempotencyKey,
            input.obligationType,
          ),
          authorizedAmount: requestedAmount,
          currency: payment.currency,
          reason: input.reason,
          status: RefundObligationStatus.IN_FLIGHT,
          createdByActorId: input.actor?.actorId ?? null,
          createdByRole: input.actor?.actorRole ?? null,
        },
      });
      const linked = await tx.refund.update({
        where: { id: existingRefundByKey.id },
        data: { obligationId: obligation.id },
      });
      return { obligation, refund: linked };
    }

    return { obligation, refund: existingRefundByKey };
  }

  if (obligation) {
    const activeRefund = await tx.refund.findFirst({
      where: { obligationId: obligation.id, status: { not: RefundStatus.FAILED } },
    });
    if (activeRefund) {
      if (activeRefund.status !== RefundStatus.REQUIRED) {
        return {
          earlyReturn: {
            action: 'RETURN_EXISTING',
            obligation,
            refund: activeRefund,
            remainingBalance: new Prisma.Decimal(0),
          },
        };
      }
      return { obligation, refund: activeRefund };
    }

    if (!input.allowReplacementRetry) {
      return {
        earlyReturn: {
          action: 'TERMINAL_FAILED',
          obligation,
          errorReason: 'Previous refund failed; explicit replacement retry required',
          remainingBalance: new Prisma.Decimal(0),
        },
      };
    }

    const lastFailed = await tx.refund.findFirst({
      where: { obligationId: obligation.id, status: RefundStatus.FAILED },
      orderBy: { createdAt: 'desc' },
    });
    const latestAttempt = lastFailed
      ? await tx.refundProviderAttempt.findFirst({
          where: { refundId: lastFailed.id },
          orderBy: { attemptSequence: 'desc' },
        })
      : null;
    if (!lastFailed || !latestAttempt?.retryEligible) {
      return {
        earlyReturn: {
          action: 'TERMINAL_FAILED',
          obligation,
          refund: lastFailed ?? undefined,
          errorReason: 'No retry-eligible failed attempt found for obligation',
          remainingBalance: new Prisma.Decimal(0),
        },
      };
    }

    const nextNum =
      (await tx.refundProviderAttempt.count({ where: { obligationId: obligation.id } })) + 1;
    const replacementRefund = await tx.refund.create({
      data: {
        id: randomUUID(),
        paymentId: payment.id,
        obligationId: obligation.id,
        supersedesRefundId: lastFailed.id,
        idempotencyKey: `${obligation.obligationKey}:retry:${nextNum}`,
        amount: requestedAmount,
        reason: input.reason,
        status: RefundStatus.PROCESSING,
      },
    });
    return { obligation, refund: replacementRefund };
  }

  const capacity = await computeRemainingRefundCapacityTx(tx, payment.id, payment.amount);
  if (capacity.remainingBalance.lte(0) || requestedAmount.gt(capacity.remainingBalance)) {
    return {
      earlyReturn: {
        action: 'EXCEEDS_BALANCE',
        remainingBalance: capacity.remainingBalance,
        errorReason: 'Refund amount exceeds the remaining refundable balance',
      },
    };
  }

  const newObligation = await tx.refundObligation.create({
    data: {
      id: randomUUID(),
      paymentId: payment.id,
      orderId: payment.orderId,
      vendorOrderId: input.vendorOrderId ?? null,
      obligationKey: input.idempotencyKey ?? `obl:${randomUUID()}`,
      obligationType: deriveObligationType(input.idempotencyKey, input.obligationType),
      authorizedAmount: requestedAmount,
      currency: payment.currency,
      reason: input.reason,
      status: RefundObligationStatus.IN_FLIGHT,
      createdByActorId: input.actor?.actorId ?? null,
      createdByRole: input.actor?.actorRole ?? null,
    },
  });

  const newRefund = await tx.refund.create({
    data: {
      id: randomUUID(),
      paymentId: payment.id,
      obligationId: newObligation.id,
      amount: requestedAmount,
      reason: input.reason,
      status: RefundStatus.PROCESSING,
      idempotencyKey: input.idempotencyKey ?? null,
    },
  });

  return { obligation: newObligation, refund: newRefund };
}
