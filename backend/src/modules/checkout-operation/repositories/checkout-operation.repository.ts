import { Injectable } from '@nestjs/common';
import { CheckoutOperation, CheckoutPath, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class CheckoutOperationRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Serializable retries are bounded and repeat database-only work. No Redis,
  // provider calls or logging may be placed inside this callback.
  async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          attempt >= 2 ||
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          !['P2034', 'P2002'].includes(error.code)
        )
          throw error;
      }
    }
  }

  async resolve(
    customerId: string,
    retryKeyHash: string,
    cartId: string,
    tx: Prisma.TransactionClient,
  ): Promise<CheckoutOperation> {
    const existing = await tx.checkoutOperation.findUnique({
      where: { customerId_retryKeyHash: { customerId, retryKeyHash } },
    });
    if (existing) return existing;
    return tx.checkoutOperation.create({
      data: { customerId, cartId, retryKeyHash, operationKey: randomUUID() },
    });
  }

  findOwned(
    id: string,
    customerId: string,
    tx: Prisma.TransactionClient,
  ): Promise<CheckoutOperation | null> {
    return tx.checkoutOperation.findFirst({ where: { id, customerId } });
  }

  assignPath(
    id: string,
    customerId: string,
    selectedPath: CheckoutPath,
    tx: Prisma.TransactionClient,
  ) {
    return tx.checkoutOperation.updateMany({
      where: { id, customerId, selectedPath: null },
      data: { selectedPath },
    });
  }

  bindFingerprint(
    id: string,
    customerId: string,
    priceLockFingerprint: string,
    tx: Prisma.TransactionClient,
  ) {
    return tx.checkoutOperation.updateMany({
      where: { id, customerId, priceLockFingerprint: null },
      data: { priceLockFingerprint },
    });
  }
}
