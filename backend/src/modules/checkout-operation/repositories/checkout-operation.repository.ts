import { Injectable } from '@nestjs/common';
import { CheckoutOperation, CheckoutPath, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class CheckoutOperationRepository {
  constructor(private readonly prisma: PrismaService) {}

  // G.4b.1 inactive support. Caller holds the fence lock and this operation row
  // lock. Path and epoch are first-bound together; historical assigned NULL
  // capabilities are deliberately not upgraded.
  bindReservationCapability(id: string, epoch: number, tx: Prisma.TransactionClient) {
    return tx.checkoutOperation.updateMany({
      where: { id, selectedPath: null, reservationExecutionEpoch: null, reservationCapabilityState: null },
      data: { selectedPath: 'CART_SCOPED', reservationExecutionEpoch: epoch, reservationCapabilityState: 'ACTIVE' },
    });
  }

  revokeReservationCapability(id: string, tx: Prisma.TransactionClient) {
    return tx.checkoutOperation.updateMany({ where: { id, reservationCapabilityState: 'ACTIVE' },
      data: { reservationCapabilityState: 'REVOKED' } });
  }

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
  ): Promise<Prisma.BatchPayload> {
    return tx.checkoutOperation.updateMany({
      where: { id, customerId, selectedPath: null },
      data: { selectedPath },
    });
  }

  async lockOwned(
    id: string,
    customerId: string,
    tx: Prisma.TransactionClient,
  ): Promise<CheckoutOperation | null> {
    // Ownership filter prevents locking another customer's operation. Admission
    // holds this row until commit, including against other assignPath writers.
    await tx.$queryRaw`SELECT "id" FROM "checkout_operations" WHERE "id" = ${id} AND "customerId" = ${customerId} FOR UPDATE`;
    return this.findOwned(id, customerId, tx);
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
