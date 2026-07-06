import { Injectable } from '@nestjs/common';
import { Refund, RefundStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateRefundInput {
  paymentId: string;
  amount: number;
  reason: string;
  status: RefundStatus;
  providerReference?: string;
}

@Injectable()
export class RefundsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateRefundInput): Promise<Refund> {
    return this.prisma.refund.create({ data: input });
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
