import { Injectable } from '@nestjs/common';
import { ChainOfCustodyEvent, CustodyEventType, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateCustodyEventInput {
  catchId?: string;
  lotId?: string;
  eventType: CustodyEventType;
  fromUserId?: string;
  toUserId?: string;
  location?: string;
  latitude?: number;
  longitude?: number;
  notes?: string;
}

@Injectable()
export class CustodyEventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateCustodyEventInput): Promise<ChainOfCustodyEvent> {
    return this.prisma.chainOfCustodyEvent.create({ data: input });
  }

  findMany(filters: { catchId?: string; lotId?: string }): Promise<ChainOfCustodyEvent[]> {
    const where: Prisma.ChainOfCustodyEventWhereInput = {
      ...(filters.catchId ? { catchId: filters.catchId } : {}),
      ...(filters.lotId ? { lotId: filters.lotId } : {}),
    };
    return this.prisma.chainOfCustodyEvent.findMany({ where, orderBy: { occurredAt: 'asc' } });
  }
}
