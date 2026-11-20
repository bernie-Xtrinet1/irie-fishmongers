import { Injectable } from '@nestjs/common';
import { Prisma, Refund, RefundStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  ACTIVE_REFUND_STATUSES,
  assertRefundStatusTransition,
  executeFinalizeRefundTx,
  executeUpdateRefundStatusTx,
  FinalizeRefundInput,
  FinalizeRefundResult,
} from './refunds-finalization.helper';
import {
  executeReserveRefundTx,
  RefundReservationResult,
  ReserveRefundInput,
} from './refunds-reservation.helper';

export {
  ACTIVE_REFUND_STATUSES,
  assertRefundStatusTransition,
  FinalizeRefundInput,
  FinalizeRefundResult,
  RefundReservationResult,
  ReserveRefundInput,
};

export interface CreateRefundInput {
  paymentId: string;
  amount: number | Prisma.Decimal;
  reason: string;
  status: RefundStatus;
  providerReference?: string | null;
  idempotencyKey?: string | null;
  obligationId?: string | null;
  supersedesRefundId?: string | null;
}

@Injectable()
export class RefundsRepository {
  constructor(readonly prisma: PrismaService) {}

  create(input: CreateRefundInput, tx?: Prisma.TransactionClient): Promise<Refund> {
    return (tx ?? this.prisma).refund.create({ data: input });
  }

  createWithTx(input: CreateRefundInput, tx: Prisma.TransactionClient): Promise<Refund> {
    return tx.refund.create({ data: input });
  }

  findByIdempotencyKey(
    idempotencyKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Refund | null> {
    return (tx ?? this.prisma).refund.findUnique({ where: { idempotencyKey } });
  }

  findByPaymentId(paymentId: string): Promise<Refund[]> {
    return this.prisma.refund.findMany({ where: { paymentId }, orderBy: { createdAt: 'asc' } });
  }

  async sumCompletedByPaymentId(paymentId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const result = await (tx ?? this.prisma).refund.aggregate({
      where: { paymentId, status: RefundStatus.COMPLETED },
      _sum: { amount: true },
    });
    return result._sum.amount?.toNumber() ?? 0;
  }

  async sumActiveByPaymentId(
    paymentId: string,
    tx?: Prisma.TransactionClient,
    excludeRefundId?: string,
  ): Promise<Prisma.Decimal> {
    const result = await (tx ?? this.prisma).refund.aggregate({
      where: {
        paymentId,
        status: { in: ACTIVE_REFUND_STATUSES },
        ...(excludeRefundId ? { id: { not: excludeRefundId } } : {}),
      },
      _sum: { amount: true },
    });
    return result._sum.amount ?? new Prisma.Decimal(0);
  }

  reserveRefund(
    input: ReserveRefundInput,
    externalTx?: Prisma.TransactionClient,
  ): Promise<RefundReservationResult> {
    if (externalTx) {
      return executeReserveRefundTx(externalTx, input);
    }
    return this.prisma.$transaction((tx) => executeReserveRefundTx(tx, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }

  finalizeRefund(
    input: FinalizeRefundInput,
    externalTx?: Prisma.TransactionClient,
  ): Promise<FinalizeRefundResult> {
    if (externalTx) {
      return executeFinalizeRefundTx(externalTx, input);
    }
    return this.prisma.$transaction((tx) => executeFinalizeRefundTx(tx, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }

  updateStatus(
    id: string,
    status: RefundStatus,
    providerReference?: string | null,
    externalTx?: Prisma.TransactionClient,
  ): Promise<Refund> {
    if (externalTx) {
      return executeUpdateRefundStatusTx(externalTx, id, status, providerReference);
    }
    if (typeof (this.prisma as unknown as { $transaction?: unknown }).$transaction === 'function') {
      return this.prisma.$transaction(
        (tx) => executeUpdateRefundStatusTx(tx, id, status, providerReference),
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    }
    return executeUpdateRefundStatusTx(this.prisma, id, status, providerReference);
  }
}
