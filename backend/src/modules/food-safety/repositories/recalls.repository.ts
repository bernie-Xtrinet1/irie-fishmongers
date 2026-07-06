import { Injectable } from '@nestjs/common';
import { Prisma, RecallSeverityClass, RecallStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateRecallInput {
  severityClass: RecallSeverityClass;
  reason: string;
  createdById: string;
  lotIds: string[];
}

export interface Page {
  skip: number;
  take: number;
}

const recallWithLots = Prisma.validator<Prisma.RecallDefaultArgs>()({
  include: { lots: true },
});

export type RecallWithLots = Prisma.RecallGetPayload<typeof recallWithLots>;

const affectedOrderItem = Prisma.validator<Prisma.OrderItemDefaultArgs>()({
  include: {
    product: true,
    vendorOrder: { include: { order: { include: { customer: true } } } },
  },
});

export type AffectedOrderItem = Prisma.OrderItemGetPayload<typeof affectedOrderItem>;

@Injectable()
export class RecallsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateRecallInput): Promise<RecallWithLots> {
    return this.prisma.recall.create({
      data: {
        severityClass: input.severityClass,
        reason: input.reason,
        createdById: input.createdById,
        lots: { create: input.lotIds.map((lotId) => ({ lotId })) },
      },
      include: recallWithLots.include,
    });
  }

  findById(id: string): Promise<RecallWithLots | null> {
    return this.prisma.recall.findUnique({ where: { id }, include: recallWithLots.include });
  }

  updateStatus(
    id: string,
    status: RecallStatus,
    data: { rootCause?: string; resolutionNotes?: string; closedAt?: Date } = {},
  ): Promise<RecallWithLots> {
    return this.prisma.recall.update({
      where: { id },
      data: { status, ...data },
      include: recallWithLots.include,
    });
  }

  async findMany(
    status: RecallStatus | undefined,
    page: Page,
  ): Promise<{ items: RecallWithLots[]; total: number }> {
    const where: Prisma.RecallWhereInput = status ? { status } : {};

    const [items, total] = await Promise.all([
      this.prisma.recall.findMany({
        where,
        include: recallWithLots.include,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.recall.count({ where }),
    ]);

    return { items, total };
  }

  findAffectedOrderItems(lotIds: string[]): Promise<AffectedOrderItem[]> {
    return this.prisma.orderItem.findMany({
      where: { product: { lotId: { in: lotIds } } },
      include: affectedOrderItem.include,
    });
  }
}
