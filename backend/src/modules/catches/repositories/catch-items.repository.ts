import { Injectable } from '@nestjs/common';
import { Catch, CatchItem } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export type CatchItemWithCatch = CatchItem & { catch: Catch };

@Injectable()
export class CatchItemsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<CatchItemWithCatch | null> {
    return this.prisma.catchItem.findUnique({ where: { id }, include: { catch: true } });
  }
}
