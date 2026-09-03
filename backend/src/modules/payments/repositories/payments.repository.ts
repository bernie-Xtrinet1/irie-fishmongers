import { Injectable } from '@nestjs/common';
import { PaymentInitiationStatus, PaymentProviderName, PaymentStatus, Prisma } from '@prisma/client';

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

  async createOrGetByOrderId(
    input: CreatePaymentInput,
  ): Promise<{ payment: PaymentWithOrder; created: boolean }> {
    try {
      const payment = await this.prisma.payment.create({
        data: input,
        include: paymentWithOrder.include,
      });
      return { payment, created: true };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        Array.isArray(error.meta?.target) &&
        (error.meta.target as string[]).includes('orderId')
      ) {
        const existing = await this.prisma.payment.findUnique({
          where: { orderId: input.orderId },
          include: paymentWithOrder.include,
        });

        if (existing === null) {
          throw new Error(
            `Internal consistency error: orderId unique constraint was violated for ` +
              `"${input.orderId}" but no payment row was found on re-read`,
          );
        }

        return { payment: existing, created: false };
      }

      throw error;
    }
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
      initiationStatus: PaymentInitiationStatus;
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

  async claimInitiation(id: string): Promise<boolean> {
    const result = await this.prisma.payment.updateMany({
      where: { id, initiationStatus: 'NOT_STARTED' },
      data: { initiationStatus: 'INITIATING' },
    });
    return result.count === 1;
  }

  findRecoveryCandidates(staleBefore: Date, limit: number): Promise<PaymentWithOrder[]> {
    return this.prisma.payment.findMany({
      where: {
        provider: 'WIPAY',
        initiationStatus: { in: ['INITIATING', 'RECONCILE_REQUIRED'] },
        updatedAt: { lte: staleBefore },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      include: paymentWithOrder.include,
    });
  }

  async claimForRecovery(
    id: string,
    now: Date,
    staleBefore: Date,
  ): Promise<PaymentWithOrder | null> {
    const result = await this.prisma.payment.updateMany({
      where: {
        id,
        provider: 'WIPAY',
        providerReference: { not: null },
        OR: [
          { initiationStatus: 'ESTABLISHED', status: 'PENDING' },
          {
            initiationStatus: 'RECONCILE_REQUIRED',
            status: { in: ['PENDING', 'FAILED'] },
          },
        ],
        AND: [
          {
            OR: [
              { recoveryStartedAt: null },
              { recoveryStartedAt: { lt: staleBefore } },
            ],
          },
        ],
      },
      data: {
        recoveryStartedAt: now,
        recoveryAttemptCount: { increment: 1 },
      },
    });

    if (result.count === 0) {
      return null;
    }

    return this.prisma.payment.findUniqueOrThrow({
      where: { id },
      include: paymentWithOrder.include,
    });
  }

  async releaseRecoveryClaimIfCurrent(
    id: string,
    claimedRecoveryAttemptCount: number,
  ): Promise<boolean> {
    const result = await this.prisma.payment.updateMany({
      where: {
        id,
        recoveryAttemptCount: claimedRecoveryAttemptCount,
        recoveryStartedAt: { not: null },
      },
      data: { recoveryStartedAt: null },
    });

    return result.count === 1;
  }

  async transitionToPaid(
    id: string,
  ): Promise<{ payment: PaymentWithOrder | null; transitioned: boolean }> {
    const paidAt = new Date();
    const result = await this.prisma.payment.updateMany({
      where: {
        id,
        status: { in: ['PENDING', 'FAILED'] },
      },
      data: {
        status: 'PAID',
        paidAt,
        failureReason: null,
      },
    });

    const payment = await this.findById(id);
    return { payment, transitioned: result.count === 1 };
  }

  async transitionToFailed(
    id: string,
    failureReason: string,
  ): Promise<{ payment: PaymentWithOrder | null; transitioned: boolean }> {
    const result = await this.prisma.payment.updateMany({
      where: {
        id,
        status: 'PENDING',
      },
      data: {
        status: 'FAILED',
        failureReason,
      },
    });

    const payment = await this.findById(id);
    return { payment, transitioned: result.count === 1 };
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
