import { Injectable } from '@nestjs/common';
import { Parish, Prisma, ProductUnit } from '@prisma/client';

import { DateRange } from '../../../common/dto/date-range.type';
import { PrismaService } from '../../../database/prisma.service';

export type PrismaClientOrTx = PrismaService | Prisma.TransactionClient;

const orderWithDetails = Prisma.validator<Prisma.OrderDefaultArgs>()({
  include: { vendorOrders: { include: { items: true }, orderBy: { createdAt: 'asc' } } },
});

export type OrderWithDetails = Prisma.OrderGetPayload<typeof orderWithDetails>;

export interface VendorOrderInput {
  vendorId: string;
  subtotal: number;
  items: {
    productId: string;
    productName: string;
    unitPrice: number;
    unit: ProductUnit;
    quantity: number;
    subtotal: number;
  }[];
}

export interface CreateOrderInput {
  customerId: string;
  deliveryAddressLine1: string;
  deliveryAddressLine2?: string;
  deliveryParish: Parish;
  deliveryPhone: string;
  deliveryZoneId?: string | null;
  vendorOrders: VendorOrderInput[];
}

@Injectable()
export class OrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateOrderInput, client: PrismaClientOrTx = this.prisma): Promise<OrderWithDetails> {
    return client.order.create({
      data: {
        customerId: input.customerId,
        deliveryAddressLine1: input.deliveryAddressLine1,
        deliveryAddressLine2: input.deliveryAddressLine2,
        deliveryParish: input.deliveryParish,
        deliveryPhone: input.deliveryPhone,
        deliveryZoneId: input.deliveryZoneId,
        vendorOrders: {
          create: input.vendorOrders.map((vendorOrder) => ({
            vendorId: vendorOrder.vendorId,
            subtotal: vendorOrder.subtotal,
            items: { create: vendorOrder.items },
          })),
        },
      },
      include: orderWithDetails.include,
    });
  }

  findById(id: string): Promise<OrderWithDetails | null> {
    return this.prisma.order.findUnique({ where: { id }, include: orderWithDetails.include });
  }

  async findManyByCustomer(
    customerId: string,
    page: { skip: number; take: number },
  ): Promise<{ items: OrderWithDetails[]; total: number }> {
    const where: Prisma.OrderWhereInput = { customerId };

    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: orderWithDetails.include,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { items, total };
  }

  count(range?: DateRange): Promise<number> {
    const where: Prisma.OrderWhereInput =
      range?.from || range?.to
        ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
        : {};
    return this.prisma.order.count({ where });
  }
}
