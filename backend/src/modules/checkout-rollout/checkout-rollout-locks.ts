import { Prisma } from '@prisma/client';

// Shared by G.3a global writers, G.1 participant writers and G.3b admissions.
// Always global first, then participant. No external work inside the transaction.
export const ROLLOUT_CONTROL_LOCK_NAMESPACE = 1196634962;
export const ROLLOUT_CONTROL_LOCK_ID = 1;

export async function lockRolloutGlobal(
  tx: Prisma.TransactionClient,
  exclusive = false,
): Promise<void> {
  if (exclusive)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ROLLOUT_CONTROL_LOCK_NAMESPACE}::integer, ${ROLLOUT_CONTROL_LOCK_ID}::integer)`;
  else
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${ROLLOUT_CONTROL_LOCK_NAMESPACE}::integer, ${ROLLOUT_CONTROL_LOCK_ID}::integer)`;
}

export async function lockRolloutParticipant(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<void> {
  const lockKey = `checkout_rollout_participant:${customerId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
}
