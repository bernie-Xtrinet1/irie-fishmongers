import { Injectable } from '@nestjs/common';
import { DeliveryException, DeliveryExceptionType, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateDeliveryExceptionInput {
  deliveryId: string;
  type: DeliveryExceptionType;
  reason: string;
  photos: string[];
  notes?: string;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class DeliveryExceptionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateDeliveryExceptionInput): Promise<DeliveryException> {
    return this.prisma.deliveryException.create({ data: input });
  }

  findById(id: string): Promise<DeliveryException | null> {
    return this.prisma.deliveryException.findUnique({ where: { id } });
  }

  resolve(id: string, resolvedById: string): Promise<DeliveryException> {
    return this.prisma.deliveryException.update({
      where: { id },
      data: { resolved: true, resolvedAt: new Date(), resolvedById },
    });
  }

  findByDeliveryId(deliveryId: string): Promise<DeliveryException[]> {
    return this.prisma.deliveryException.findMany({
      where: { deliveryId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findMany(
    resolved: boolean | undefined,
    page: Page,
  ): Promise<{ items: DeliveryException[]; total: number }> {
    const where: Prisma.DeliveryExceptionWhereInput = resolved === undefined ? {} : { resolved };

    const [items, total] = await Promise.all([
      this.prisma.deliveryException.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.deliveryException.count({ where }),
    ]);

    return { items, total };
  }
}
