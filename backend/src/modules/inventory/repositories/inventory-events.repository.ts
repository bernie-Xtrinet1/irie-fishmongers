import { Injectable } from '@nestjs/common';
import { InventoryEvent, InventoryEventType, Prisma } from '@prisma/client';

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
}
