import { Injectable } from '@nestjs/common';
import { PaymentProviderName, PaymentStatus, Prisma } from '@prisma/client';

import { DateRange } from '../../../common/dto/date-range.type';
import { PrismaService } from '../../../database/prisma.service';

export interface CreatePaymentInput {
  orderId: string;
  provider: PaymentProviderName;
  amount: number;
  currency: string;
  providerReference?: string;
}

const paymentWithOrder = Prisma.validator<Prisma.PaymentDefaultArgs>()({
  include: { order: { select: { customerId: true } } },
});

export type PaymentWithOrder = Prisma.PaymentGetPayload<typeof paymentWithOrder>;

@Injectable()
export class PaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreatePaymentInput): Promise<PaymentWithOrder> {
    return this.prisma.payment.create({ data: input, include: paymentWithOrder.include });
  }

  findById(id: string): Promise<PaymentWithOrder | null> {
    return this.prisma.payment.findUnique({ where: { id }, include: paymentWithOrder.include });
  }

  findByOrderId(orderId: string): Promise<PaymentWithOrder | null> {
    return this.prisma.payment.findUnique({
      where: { orderId },
      include: paymentWithOrder.include,
    });
  }

  findByProviderReference(providerReference: string): Promise<PaymentWithOrder | null> {
    return this.prisma.payment.findFirst({
      where: { providerReference },
      include: paymentWithOrder.include,
    });
  }

  update(
    id: string,
    data: Partial<{
      status: PaymentStatus;
      providerReference: string;
      failureReason: string;
      paidAt: Date;
    }>,
  ): Promise<PaymentWithOrder> {
    return this.prisma.payment.update({
      where: { id },
      data,
      include: paymentWithOrder.include,
    });
  }

  async sumByStatus(status: PaymentStatus, range?: DateRange): Promise<Prisma.Decimal> {
    const result = await this.prisma.payment.aggregate({
      _sum: { amount: true },
      where: {
        status,
        ...(range?.from || range?.to
          ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
          : {}),
      },
    });
    return result._sum.amount ?? new Prisma.Decimal(0);
  }

  countByStatus(status: PaymentStatus, range?: DateRange): Promise<number> {
    return this.prisma.payment.count({
      where: {
        status,
        ...(range?.from || range?.to
          ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
          : {}),
      },
    });
  }

  // 12B Sales Analytics: gross paid volume split by provider (WiPay vs
  // Cash on Delivery) - sumByStatus above only returns the combined total.
  async sumByProvider(status: PaymentStatus, range?: DateRange): Promise<Record<PaymentProviderName, Prisma.Decimal>> {
    const groups = await this.prisma.payment.groupBy({
      by: ['provider'],
      _sum: { amount: true },
      where: {
        status,
        ...(range?.from || range?.to
          ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
          : {}),
      },
    });

    const sumByProvider: Record<PaymentProviderName, Prisma.Decimal> = {
      WIPAY: new Prisma.Decimal(0),
      CASH_ON_DELIVERY: new Prisma.Decimal(0),
    };
    for (const group of groups) {
      sumByProvider[group.provider] = group._sum.amount ?? new Prisma.Decimal(0);
    }
    return sumByProvider;
  }
}
