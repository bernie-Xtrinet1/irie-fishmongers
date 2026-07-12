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

// Closes the Phase 12B.0 finding that the plain DeliveryException list
// under-fetches for a dispatcher screen: a dispatcher needs to know which
// vendor/customer/driver an exception belongs to without a second lookup
// per row.
const deliveryExceptionWithContext = Prisma.validator<Prisma.DeliveryExceptionDefaultArgs>()({
  include: {
    delivery: {
      include: {
        vendorOrder: {
          include: {
            vendor: { select: { businessName: true } },
            order: {
              select: {
                customer: { select: { firstName: true, lastName: true } },
                deliveryAddressLine1: true,
                deliveryParish: true,
              },
            },
          },
        },
        driver: { include: { user: { select: { firstName: true, lastName: true } } } },
      },
    },
  },
});

export type DeliveryExceptionWithContext = Prisma.DeliveryExceptionGetPayload<
  typeof deliveryExceptionWithContext
>;

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

  async findManyWithContext(
    resolved: boolean | undefined,
    page: Page,
  ): Promise<{ items: DeliveryExceptionWithContext[]; total: number }> {
    const where: Prisma.DeliveryExceptionWhereInput = resolved === undefined ? {} : { resolved };

    const [items, total] = await Promise.all([
      this.prisma.deliveryException.findMany({
        where,
        include: deliveryExceptionWithContext.include,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.deliveryException.count({ where }),
    ]);

    return { items, total };
  }
}
