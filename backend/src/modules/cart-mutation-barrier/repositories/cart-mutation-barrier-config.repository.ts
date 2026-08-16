import { Injectable } from '@nestjs/common';
import { CartMutationBarrierConfig, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export type PrismaClientOrTx = PrismaService | Prisma.TransactionClient;

export interface CreateCartMutationBarrierConfigInput {
  active: boolean;
  activatedById: string;
}

// CART_SCOPED activation-boundary gate (see the gate design review).
// Persistence only, mirroring ReservationEngineModeConfigRepository
// exactly: append-only, "current" is always the most recently created
// row by `revision` (never `createdAt`, for the same same-millisecond-tie
// reason recorded on that repository). The shared/exclusive advisory-lock
// protocol that makes activation/deactivation safe against a concurrent
// mutation transaction is entirely owned by CartMutationBarrierService -
// this repository has no way to enforce it itself, by design.
@Injectable()
export class CartMutationBarrierConfigRepository {
  constructor(private readonly prisma: PrismaService) {}

  findCurrent(client: PrismaClientOrTx = this.prisma): Promise<CartMutationBarrierConfig | null> {
    return client.cartMutationBarrierConfig.findFirst({ orderBy: { revision: 'desc' } });
  }

  create(
    input: CreateCartMutationBarrierConfigInput,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<CartMutationBarrierConfig> {
    return client.cartMutationBarrierConfig.create({ data: input });
  }
}
