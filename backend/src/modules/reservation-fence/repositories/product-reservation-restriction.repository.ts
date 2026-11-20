import { Prisma, ProductReservationRestriction, ProductSuspectRecovery } from '@prisma/client';

import {
  ACTIVE_RESTRICTION_STATES,
  BLOCKING_RECOVERY_STATES,
} from '../types/product-reservation-restriction.types';

export function findActiveProductRestriction(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<ProductReservationRestriction | null> {
  return tx.productReservationRestriction.findFirst({
    where: { productId, state: { in: [...ACTIVE_RESTRICTION_STATES] } },
    orderBy: { restrictionRevision: 'desc' },
  });
}

export function findBlockingProductSuspectRecovery(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<ProductSuspectRecovery | null> {
  return tx.productSuspectRecovery.findFirst({
    where: { productId, status: { in: [...BLOCKING_RECOVERY_STATES] } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function currentAllowedControlRevision(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<number> {
  const latestCompleted = await tx.productSuspectRecovery.findFirst({
    where: { productId, status: 'COMPLETED' },
    orderBy: { clearedControlRevision: 'desc' },
    select: { clearedControlRevision: true },
  });
  return latestCompleted?.clearedControlRevision ?? 0;
}

export async function nextOddRestrictionRevision(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<number> {
  const [latestRestriction, latestCleared] = await Promise.all([
    tx.productReservationRestriction.findFirst({
      where: { productId },
      orderBy: { restrictionRevision: 'desc' },
      select: { restrictionRevision: true },
    }),
    currentAllowedControlRevision(tx, productId),
  ]);
  const floor = Math.max(latestRestriction?.restrictionRevision ?? 0, latestCleared);
  return floor % 2 === 0 ? floor + 1 : floor + 2;
}

// Caller holds ReservationFenceRepository.locked. No Redis-derived authority.
export async function requireUnrestrictedProduct(tx: Prisma.TransactionClient, productId: string): Promise<void> {
  await tx.product.findUniqueOrThrow({ where: { id: productId }, select: { id: true } });
  if (await findActiveProductRestriction(tx, productId)) {
    throw new Error('PRODUCT_RESERVATION_RESTRICTED');
  }
  if (await findBlockingProductSuspectRecovery(tx, productId)) {
    throw new Error('PRODUCT_RESERVATION_RESTRICTED');
  }
}
