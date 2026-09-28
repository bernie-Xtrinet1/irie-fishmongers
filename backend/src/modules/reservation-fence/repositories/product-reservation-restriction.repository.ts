import { Prisma } from '@prisma/client';

// Caller holds ReservationFenceRepository.locked. No Redis-derived authority.
export async function requireUnrestrictedProduct(tx: Prisma.TransactionClient, productId: string): Promise<void> {
  await tx.product.findUniqueOrThrow({ where: { id: productId }, select: { id: true } });
  if (await tx.productReservationRestriction.findUnique({ where: { productId } }))
    throw new Error('PRODUCT_RESERVATION_RESTRICTED');
}
