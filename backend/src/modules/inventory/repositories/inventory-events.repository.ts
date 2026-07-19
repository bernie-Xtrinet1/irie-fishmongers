import { Injectable } from '@nestjs/common';
import { InventoryEvent, InventoryEventType, Prisma } from '@prisma/client';

import { DateRange } from '../../../common/dto/date-range.type';
import { PrismaService } from '../../../database/prisma.service';

export type PrismaClientOrTx = PrismaService | Prisma.TransactionClient;

export interface CreateInventoryEventInput {
  productId: string;
  eventType: InventoryEventType;
  quantityDelta: number;
  vendorOrderId?: string;
  triggeredById?: string;
  notes?: string;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class InventoryEventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    input: CreateInventoryEventInput,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<InventoryEvent> {
    return client.inventoryEvent.create({ data: input });
  }

  async findByProduct(
    productId: string,
    page: Page,
  ): Promise<{ items: InventoryEvent[]; total: number }> {
    const where = { productId };

    const [items, total] = await Promise.all([
      this.prisma.inventoryEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.inventoryEvent.count({ where }),
    ]);

    return { items, total };
  }

  // 12B Inventory Analytics: stock movement activity by event type - how
  // much of each kind of change (restocks, manual adjustments, disposals,
  // decrements from sales) happened, not just per-product history.
  async countAndSumByType(range?: DateRange): Promise<Record<InventoryEventType, { count: number; totalQuantityDelta: number }>> {
    const where: Prisma.InventoryEventWhereInput =
      range?.from || range?.to
        ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
        : {};

    const groups = await this.prisma.inventoryEvent.groupBy({
      by: ['eventType'],
      where,
      _count: { _all: true },
      _sum: { quantityDelta: true },
    });

    const countAndSumByType: Record<InventoryEventType, { count: number; totalQuantityDelta: number }> = {
      DECREMENTED: { count: 0, totalQuantityDelta: 0 },
      RESTOCKED: { count: 0, totalQuantityDelta: 0 },
      MANUAL_ADJUSTMENT: { count: 0, totalQuantityDelta: 0 },
      DISPOSED: { count: 0, totalQuantityDelta: 0 },
    };
    for (const group of groups) {
      countAndSumByType[group.eventType] = {
        count: group._count._all,
        totalQuantityDelta: group._sum.quantityDelta ?? 0,
      };
    }
    return countAndSumByType;
  }
}
