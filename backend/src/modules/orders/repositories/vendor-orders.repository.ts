import { Injectable } from '@nestjs/common';
import { Prisma, VendorOrderStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { PrismaClientOrTx } from './orders.repository';

const vendorOrderWithItems = Prisma.validator<Prisma.VendorOrderDefaultArgs>()({
  include: { items: true, order: true },
});

export type VendorOrderWithItems = Prisma.VendorOrderGetPayload<typeof vendorOrderWithItems>;

@Injectable()
export class VendorOrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<VendorOrderWithItems | null> {
    return this.prisma.vendorOrder.findUnique({
      where: { id },
      include: vendorOrderWithItems.include,
    });
  }

  updateStatus(
    id: string,
    status: VendorOrderStatus,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<VendorOrderWithItems> {
    return client.vendorOrder.update({
      where: { id },
      data: { status },
      include: vendorOrderWithItems.include,
    });
  }

  async findManyByVendor(
    vendorId: string,
    status: VendorOrderStatus | undefined,
    page: { skip: number; take: number },
  ): Promise<{ items: VendorOrderWithItems[]; total: number }> {
    const where: Prisma.VendorOrderWhereInput = {
      vendorId,
      ...(status ? { status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.vendorOrder.findMany({
        where,
        include: vendorOrderWithItems.include,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.vendorOrder.count({ where }),
    ]);

    return { items, total };
  }

  async countByStatus(range?: { from?: Date; to?: Date }): Promise<Record<VendorOrderStatus, number>> {
    const where: Prisma.VendorOrderWhereInput =
      range?.from || range?.to
        ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
        : {};

    const groups = await this.prisma.vendorOrder.groupBy({ by: ['status'], where, _count: { _all: true } });

    const countByStatus: Record<VendorOrderStatus, number> = {
      PENDING: 0,
      ACCEPTED: 0,
      PREPARING: 0,
      READY_FOR_PICKUP: 0,
      ASSIGNED_TO_DRIVER: 0,
      IN_TRANSIT: 0,
      DELIVERED: 0,
      DELIVERY_FAILED: 0,
      REJECTED: 0,
      CANCELLED: 0,
    };
    for (const group of groups) {
      countByStatus[group.status] = group._count._all;
    }
    return countByStatus;
  }
}
