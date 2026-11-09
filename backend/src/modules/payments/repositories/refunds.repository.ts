import { Injectable } from '@nestjs/common';
import { Prisma, Refund, RefundStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateRefundInput {
  paymentId: string;
  amount: number | Prisma.Decimal;
  reason: string;
  status: RefundStatus;
  providerReference?: string | null;
  idempotencyKey?: string | null;
}

@Injectable()
export class RefundsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateRefundInput, tx?: Prisma.TransactionClient): Promise<Refund> {
    const client = tx ?? this.prisma;
    return client.refund.create({ data: input });
  }

  createWithTx(input: CreateRefundInput, tx: Prisma.TransactionClient): Promise<Refund> {
    return tx.refund.create({ data: input });
  }

  findByIdempotencyKey(
    idempotencyKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Refund | null> {
    const client = tx ?? this.prisma;
    return client.refund.findUnique({ where: { idempotencyKey } });
  }

  findByPaymentId(paymentId: string): Promise<Refund[]> {
    return this.prisma.refund.findMany({ where: { paymentId }, orderBy: { createdAt: 'asc' } });
  }

  async sumCompletedByPaymentId(paymentId: string): Promise<number> {
    const result = await this.prisma.refund.aggregate({
      where: { paymentId, status: 'COMPLETED' },
      _sum: { amount: true },
    });
    return result._sum.amount?.toNumber() ?? 0;
  }
}
