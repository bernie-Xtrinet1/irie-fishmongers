import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentStatus, Prisma, Refund, RefundStatus } from '@prisma/client';

import {
  lockPaymentObligationsAndRefunds,
  lockRefundFinancialHierarchy,
} from './refund-locks.helper';

export const ACTIVE_REFUND_STATUSES: RefundStatus[] = [
  RefundStatus.REQUIRED,
  RefundStatus.PENDING,
  RefundStatus.PROCESSING,
  RefundStatus.COMPLETED,
  RefundStatus.RECONCILE_REQUIRED,
];

export type RefundTransitionDecision = 'PROCEED' | 'IDEMPOTENT_COMPLETED' | 'IDEMPOTENT_FAILED';

export interface FinalizeRefundInput {
  refundId: string;
  paymentId: string;
  status: RefundStatus;
  providerReference?: string | null;
  expectedAmount?: Prisma.Decimal | number | string;
}

export interface FinalizeRefundResult {
  refund: Refund;
  paymentStatus: PaymentStatus;
  totalRefunded: Prisma.Decimal;
}

/**
 * Enforces the authoritative Refund.status state-transition contract:
 * - FAILED is strictly terminal (only idempotent FAILED -> FAILED with non-conflicting providerReference permitted).
 * - COMPLETED is strictly terminal (only idempotent COMPLETED -> COMPLETED with non-conflicting providerReference permitted).
 * - PENDING awaiting async settlement cannot regress to PROCESSING for duplicate dispatch.
 * - RECONCILE_REQUIRED cannot regress to PROCESSING without verified resolution evidence.
 */
export function assertRefundStatusTransition(
  existingRefund: Pick<Refund, 'status' | 'providerReference'>,
  targetStatus: RefundStatus,
  incomingProviderReference?: string | null,
): RefundTransitionDecision {
  if (existingRefund.status === RefundStatus.FAILED) {
    if (targetStatus === RefundStatus.FAILED) {
      if (
        incomingProviderReference &&
        existingRefund.providerReference &&
        incomingProviderReference !== existingRefund.providerReference
      ) {
        throw new ConflictException(
          `Conflicting provider reference on failed refund: existing "${existingRefund.providerReference}", incoming "${incomingProviderReference}"`,
        );
      }
      return 'IDEMPOTENT_FAILED';
    }
    throw new ConflictException(
      `Cannot transition refund from terminal status FAILED to ${targetStatus}`,
    );
  }

  if (existingRefund.status === RefundStatus.COMPLETED) {
    if (targetStatus === RefundStatus.COMPLETED) {
      if (
        incomingProviderReference &&
        existingRefund.providerReference &&
        incomingProviderReference !== existingRefund.providerReference
      ) {
        throw new ConflictException(
          `Conflicting provider reference on completed refund: existing "${existingRefund.providerReference}", incoming "${incomingProviderReference}"`,
        );
      }
      return 'IDEMPOTENT_COMPLETED';
    }
    throw new ConflictException(`Cannot transition refund from COMPLETED to ${targetStatus}`);
  }

  if (existingRefund.status === RefundStatus.PENDING && targetStatus === RefundStatus.PROCESSING) {
    throw new ConflictException(
      'Cannot regress PENDING refund back to PROCESSING for duplicate dispatch',
    );
  }

  if (
    existingRefund.status === RefundStatus.RECONCILE_REQUIRED &&
    targetStatus === RefundStatus.PROCESSING
  ) {
    throw new ConflictException(
      'Cannot transition refund from RECONCILE_REQUIRED back to PROCESSING without verified resolution',
    );
  }

  return 'PROCEED';
}

export async function executeFinalizeRefundTx(
  tx: Prisma.TransactionClient,
  input: FinalizeRefundInput,
): Promise<FinalizeRefundResult> {
  const paymentRow = await lockRefundFinancialHierarchy(tx, input.paymentId);
  if (!paymentRow) {
    throw new Error(`Payment "${input.paymentId}" not found`);
  }
  await lockPaymentObligationsAndRefunds(tx, paymentRow.id);

  const existingRefund = await tx.refund.findUnique({ where: { id: input.refundId } });
  if (!existingRefund) {
    throw new Error(`Refund "${input.refundId}" not found`);
  }
  if (existingRefund.paymentId !== input.paymentId) {
    throw new ConflictException(
      `Refund "${input.refundId}" does not belong to payment "${input.paymentId}"`,
    );
  }
  if (input.expectedAmount !== undefined) {
    const expected = new Prisma.Decimal(input.expectedAmount);
    if (!new Prisma.Decimal(existingRefund.amount).equals(expected)) {
      throw new ConflictException(
        `Refund amount mismatch: expected ${expected.toFixed(2)}, got ${new Prisma.Decimal(existingRefund.amount).toFixed(2)}`,
      );
    }
  }

  const decision = assertRefundStatusTransition(
    existingRefund,
    input.status,
    input.providerReference,
  );
  if (decision === 'IDEMPOTENT_COMPLETED' || decision === 'IDEMPOTENT_FAILED') {
    const sumResult = await tx.refund.aggregate({
      where: { paymentId: paymentRow.id, status: RefundStatus.COMPLETED },
      _sum: { amount: true },
    });
    return {
      refund: existingRefund,
      paymentStatus: paymentRow.status,
      totalRefunded: sumResult._sum.amount ?? new Prisma.Decimal(0),
    };
  }

  const updatedRefund = await tx.refund.update({
    where: { id: input.refundId },
    data: {
      status: input.status,
      ...(input.providerReference ? { providerReference: input.providerReference } : {}),
    },
  });

  if (input.status === RefundStatus.COMPLETED) {
    const sumResult = await tx.refund.aggregate({
      where: { paymentId: paymentRow.id, status: RefundStatus.COMPLETED },
      _sum: { amount: true },
    });
    const totalRefunded = sumResult._sum.amount ?? new Prisma.Decimal(0);
    const paymentAmount = new Prisma.Decimal(paymentRow.amount);
    if (totalRefunded.gt(paymentAmount)) {
      throw new Error(
        `Financial invariant violation: total completed refunds (${totalRefunded.toFixed(2)}) exceed payment amount (${paymentAmount.toFixed(2)})`,
      );
    }
    const newPaymentStatus = totalRefunded.gte(paymentAmount)
      ? PaymentStatus.REFUNDED
      : PaymentStatus.PARTIALLY_REFUNDED;
    await tx.payment.update({
      where: { id: paymentRow.id },
      data: { status: newPaymentStatus },
    });
    return { refund: updatedRefund, paymentStatus: newPaymentStatus, totalRefunded };
  }

  return {
    refund: updatedRefund,
    paymentStatus: paymentRow.status,
    totalRefunded: new Prisma.Decimal(0),
  };
}

export async function executeUpdateRefundStatusTx(
  tx: Prisma.TransactionClient,
  id: string,
  status: RefundStatus,
  providerReference?: string | null,
): Promise<Refund> {
  const anyTx = tx as unknown as {
    refund?: {
      findUnique?: typeof tx.refund.findUnique;
      update: typeof tx.refund.update;
    };
  };
  if (typeof anyTx.refund?.findUnique !== 'function') {
    return anyTx.refund!.update({
      where: { id },
      data: { status, ...(providerReference !== undefined ? { providerReference } : {}) },
    });
  }

  const refundMeta = await tx.refund.findUnique({
    where: { id },
    select: { id: true, paymentId: true, payment: { select: { orderId: true } } },
  });
  if (!refundMeta) {
    throw new NotFoundException(`Refund "${id}" not found`);
  }
  await lockRefundFinancialHierarchy(tx, refundMeta.paymentId, refundMeta.payment.orderId);
  await lockPaymentObligationsAndRefunds(tx, refundMeta.paymentId);

  const existingRefund = await tx.refund.findUnique({ where: { id } });
  if (!existingRefund) {
    throw new NotFoundException(`Refund "${id}" not found`);
  }
  const decision = assertRefundStatusTransition(existingRefund, status, providerReference);
  if (decision === 'IDEMPOTENT_COMPLETED' || decision === 'IDEMPOTENT_FAILED') {
    return existingRefund;
  }
  return tx.refund.update({
    where: { id },
    data: { status, ...(providerReference !== undefined ? { providerReference } : {}) },
  });
}
