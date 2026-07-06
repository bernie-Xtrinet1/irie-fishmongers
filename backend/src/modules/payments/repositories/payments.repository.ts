import { Injectable } from '@nestjs/common';
import { Payment, PaymentProviderName, PaymentStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreatePaymentInput {
  orderId: string;
  provider: PaymentProviderName;
  amount: number;
  currency: string;
  providerReference?: string;
}

@Injectable()
export class PaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreatePaymentInput): Promise<Payment> {
    return this.prisma.payment.create({ data: input });
  }

  findById(id: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({ where: { id } });
  }

  findByOrderId(orderId: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({ where: { orderId } });
  }

  findByProviderReference(providerReference: string): Promise<Payment | null> {
    return this.prisma.payment.findFirst({ where: { providerReference } });
  }

  update(
    id: string,
    data: Partial<{
      status: PaymentStatus;
      providerReference: string;
      failureReason: string;
      paidAt: Date;
    }>,
  ): Promise<Payment> {
    return this.prisma.payment.update({ where: { id }, data });
  }
}
