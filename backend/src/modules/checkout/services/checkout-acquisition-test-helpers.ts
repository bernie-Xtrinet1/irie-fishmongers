import { PrismaService } from '../../../database/prisma.service';
import { withSettlementSchema } from '../../reservation-fence/tests/checkout-settlement-test-helpers';
import { Redis } from 'ioredis';
import { ordinaryHoldInstanceId } from '../../reservation-fence/ordinary-hold-instance-id';
import { resourceGuardKey } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { reservationKey } from '../../inventory/constants/inventory.constants';

// Test-only ordinary ownership fixture. W1 canonical production creation is
// deferred; never make checkout acquisition repair an unconverted W1 entry.
export async function seedCanonicalOrdinaryOwnership(db: PrismaService, redis: Redis, cartId: string, customerId: string) {
  const fence = await db.reservationFenceTransition.findFirstOrThrow({ orderBy: { revision: 'desc' } });
  const markers = await db.cartReservationSyncState.findMany({ where: { cartId, expectedQuantity: { gt: 0 } } });
  const keys: string[] = [];
  for (const marker of markers) {
    const resource = { markerId: marker.id, generation: marker.generation,
      holdInstanceId: ordinaryHoldInstanceId(marker.id, marker.generation), cartId, customerId, productId: marker.productId };
    const key = reservationKey(cartId, marker.productId);
    const entry = JSON.parse((await redis.get(key))!) as Record<string, unknown>;
    if (entry.status !== 'ACTIVE' || entry.quantity !== marker.expectedQuantity || entry.customerId !== customerId)
      throw new Error('Invalid ordinary fixture');
    await redis.set(key, JSON.stringify({ ...entry, markerId: resource.markerId, generation: resource.generation,
      holdInstanceId: resource.holdInstanceId, reservationExecutionEpoch: fence.epoch }), 'KEEPTTL');
    const guard = resourceGuardKey(marker.id); keys.push(guard);
    await redis.set(guard, JSON.stringify({ incarnation: fence.incarnation, epoch: fence.epoch, resource }));
  }
  return keys;
}

// Reuse the repository's disposable-schema fixture, including endpoint
// validation and failure-safe cleanup. Retained manifests forbid row deletion.
export async function openAcquisitionSchema() {
  let complete!: () => void;
  const finished = new Promise<void>(resolve => { complete = resolve; });
  let resolveReady!: (db: PrismaService) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<PrismaService>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const lifetime = withSettlementSchema(async (db) => {
    resolveReady(db);
    await finished;
  }, 68);
  void lifetime.catch(rejectReady);
  const prisma = await ready;
  try {
    const rows = await prisma.$queryRaw<{ schema: string }[]>`SELECT current_schema() AS schema`;
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('schema', rows[0]!.schema);
    return { prisma, newClient: () => new PrismaService({ datasources: { db: { url: url.toString() } } }),
      close: async () => { complete(); await lifetime; } };
  } catch (error) {
    complete();
    try { await lifetime; } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Acquisition fixture setup and cleanup failed'); }
    throw error;
  }
}
