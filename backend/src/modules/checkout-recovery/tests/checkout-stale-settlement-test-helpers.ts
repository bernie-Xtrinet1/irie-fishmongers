import { randomUUID } from 'crypto';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { ordinaryFixture, openOrdinarySchema } from '../../reservation-fence/tests/ordinary-provenance-test-helpers';
import { CheckoutSettlementRepository, SettlementManifest } from '../../reservation-fence/repositories/checkout-settlement.repository';
import { ordinaryHoldInstanceId } from '../../reservation-fence/ordinary-hold-instance-id';
import { Redis } from 'ioredis';
import { transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY, resourceGuardKey, executionGateKey } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { checkoutPinKey, settlementReceiptKey } from '../../reservation-fence/lua/checkout-settlement.lua';
import { CheckoutSettlementAuthorityService } from '../../reservation-fence/services/checkout-settlement-authority.service';
import { ReservationMutationAuthorityService } from '../../reservation-fence/services/reservation-mutation-authority.service';
import { CheckoutAcquisitionService } from '../../checkout/services/checkout-acquisition.service';
import { CheckoutStaleSettlementService } from '../services/checkout-stale-settlement.service';
import { seedHistoricalActiveReservation, trackKeysFor } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { seedCanonicalOrdinaryOwnership } from '../../checkout/services/checkout-acquisition-test-helpers';
import { reservationKey, productTotalKey, cartIndexKey, productIndexKey } from '../../inventory/constants/inventory.constants';
import { ReservationFenceRepository } from '../../reservation-fence/repositories/reservation-fence.repository';
import { CheckoutRecoverySettlementRepository } from '../repositories/checkout-recovery-settlement.repository';
import { CheckoutRecoveryAcquisitionEvidenceService } from '../services/checkout-recovery-acquisition-evidence.service';

export { openOrdinarySchema };

export function unitManifest(): SettlementManifest {
  const id = randomUUID(), operationId = randomUUID(), attemptId = randomUUID();
  const customerId = randomUUID(), cartId = randomUUID(), key = randomUUID(), markerId = randomUUID();
  const now = new Date();
  return { id, operationId, attemptId, incarnation: randomUUID(), reservationExecutionEpoch: 1,
    captureTransitionId: randomUUID(), acquisitionReplayId: randomUUID(), settlementReplayId: randomUUID(),
    state: 'REVERT_PENDING', effect: 'CHECKOUT_REVERT_DELETE_ONLY', completionReceiptHash: null, sealed: true,
    createdAt: now, updatedAt: now,
    operation: { id: operationId, customerId, cartId, operationKey: key, retryKeyHash: 'a'.repeat(64),
      selectedPath: 'CART_SCOPED', reservationExecutionEpoch: 1, reservationCapabilityState: 'ACTIVE',
      priceLockFingerprint: null, createdAt: now, updatedAt: now },
    attempt: { id: attemptId, customerId, cartId, idempotencyKey: key, selectedPath: 'CART_SCOPED',
      reservationExecutionEpoch: 1, status: 'FAILED', orderId: null, failureCode: 'STALE_RECOVERY_FENCED',
      failureMessage: null, lastHeartbeatAt: new Date(0), createdAt: now, updatedAt: now },
    resources: [{ id: randomUUID(), settlementId: id, productId: randomUUID(), markerId, generation: 0,
      holdInstanceId: ordinaryHoldInstanceId(markerId, 0), quantity: 2 }] };
}

// PostgreSQL fixture only. ACQUIRED is structural fixture state, not a claim
// that this helper executes or proves physical W4 acquisition.
export async function staleFixture(db: PrismaService, acquired = true) {
  const f = await ordinaryFixture(db);
  const fences = new ReservationFenceRepository(db);
  const manifests = new CheckoutSettlementRepository(db, fences);
  const operation = await db.checkoutOperation.create({ data: { customerId: f.customerId,
    cartId: f.cartId, operationKey: randomUUID(), retryKeyHash: randomUUID(), selectedPath: 'CART_SCOPED',
    reservationExecutionEpoch: 1, reservationCapabilityState: 'ACTIVE' } });
  const heartbeat = new Date(Date.now() - 600_000);
  const attempt = await db.checkoutAttempt.create({ data: { customerId: f.customerId, cartId: f.cartId,
    idempotencyKey: operation.operationKey, selectedPath: 'CART_SCOPED', reservationExecutionEpoch: 1,
    lastHeartbeatAt: heartbeat } });
  const prepared = await manifests.prepare(operation.id, attempt.id, f.customerId);
  if (acquired) await fences.locked(tx => manifests.markAcquired(tx, prepared.id));
  const manifest = await manifests.find(prepared.id);
  if (!manifest) throw new Error('Missing test manifest');
  const redis = { eval: jest.fn().mockResolvedValue(JSON.stringify({ code: 'FENCE_REJECTED' })) };
  const evidence = new CheckoutRecoveryAcquisitionEvidenceService(redis as unknown as RedisService);
  const repository = new CheckoutRecoverySettlementRepository(db, fences, manifests, evidence);
  const observedAt = new Date();
  const candidate = { attemptId: attempt.id, customerId: f.customerId, observedHeartbeatAt: heartbeat,
    staleBefore: new Date(observedAt.getTime() - 180_000), observedAt };
  return { ...f, fences, manifests, operation, attempt, manifest, redis, evidence, repository, candidate };
}

// Dormant runtime fixture. Endpoint/config checks precede every Redis write.
// PostgreSQL cleanup and Redis cleanup are independent even on setup failure.
export async function withStaleRedis(work: (f: Awaited<ReturnType<typeof realStaleFixture>>) => Promise<void>) {
  if (process.env.REDIS_URL !== 'redis://127.0.0.1:16479/11') throw new Error('Exact disposable Redis required');
  const client = new Redis(process.env.REDIS_URL, { lazyConnect: true, retryStrategy: null, maxRetriesPerRequest: 0 });
  const keys = new Set<string>(), fields = new Set<string>(), errors: unknown[] = [];
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>> | undefined;
  let control: string | null | undefined, incarnation: string | null | undefined;
  try {
    await client.connect();
    for (const [key, value] of [['bind', '127.0.0.1'], ['port', '16479'], ['save', ''], ['appendonly', 'no'], ['daemonize', 'no']])
      expect(await client.config('GET', key!)).toEqual([key, value]);
    expect(await client.info('server')).toContain('redis_mode:standalone');
    control = await client.get(RESERVATION_FENCE_KEY); incarnation = await client.hget(MUTATION_HISTORY_KEY, 'incarnation');
    schema = await openOrdinarySchema();
    await work(await realStaleFixture(schema.db, client, keys, fields));
  } catch (error) { errors.push(error); }
  finally {
    try {
      if (client.status === 'ready') {
        if (keys.size) await client.del(...keys);
        if (fields.size) await client.hdel(MUTATION_HISTORY_KEY, ...fields);
        if (control !== undefined) { if (control === null) await client.del(RESERVATION_FENCE_KEY); else await client.set(RESERVATION_FENCE_KEY, control); }
        if (incarnation !== undefined) { if (incarnation === null) await client.hdel(MUTATION_HISTORY_KEY, 'incarnation'); else await client.hset(MUTATION_HISTORY_KEY, 'incarnation', incarnation); }
      }
    } catch (error) { errors.push(error); }
    try { if (client.status === 'ready') await client.quit(); else client.disconnect(); } catch (error) { errors.push(error); }
    try { if (schema) await schema.close(); } catch (error) { errors.push(error); }
    jest.restoreAllMocks();
  }
  if (errors.length) throw new AggregateError(errors, 'Stale settlement fixture failed');
}

async function realStaleFixture(db: PrismaService, client: Redis, keys: Set<string>, fields: Set<string>) {
  const f = await staleFixture(db, false), adapter = new RedisService(client);
  const authority = new CheckoutSettlementAuthorityService(f.manifests, f.fences, adapter);
  const acquisition = new CheckoutAcquisitionService(db, adapter, f.manifests, f.fences, authority,
    new ReservationMutationAuthorityService(f.fences, adapter));
  const repository = new CheckoutRecoverySettlementRepository(db, f.fences, f.manifests, new CheckoutRecoveryAcquisitionEvidenceService(adapter));
  const fresh = () => new CheckoutStaleSettlementService(repository, authority, adapter);
  trackKeysFor(keys, f.cartId, f.productId);
  for (const key of [resourceGuardKey(f.marker.id), executionGateKey(f.operation.id), checkoutPinKey(f.marker.id),
    settlementReceiptKey(f.manifest.id), `reservation:fence:settlement-acquisition:${f.manifest.id}`]) keys.add(key);
  fields.add(resourceGuardKey(f.marker.id)); fields.add(executionGateKey(f.operation.id));
  const evaluate = adapter.eval.bind(adapter);
  const evaluation = jest.spyOn(adapter, 'eval').mockImplementation((script, ks, args) => {
    for (const key of ks) if (key.includes(':settlement-grant:') || key.includes(':grant:')) keys.add(key);
    return evaluate(script, ks, args);
  });
  await client.set(RESERVATION_FENCE_KEY, JSON.stringify(transitionTuple(f.transition)));
  await client.hset(MUTATION_HISTORY_KEY, 'incarnation', f.transition.incarnation);
  await seedHistoricalActiveReservation(client, f.cartId, f.productId, f.customerId, 2);
  await seedCanonicalOrdinaryOwnership(db, client, f.cartId, f.customerId);
  const acquired = await acquisition.acquire(f.customerId, f.operation.id);
  if (!acquired.ok) throw new Error('Stale fixture W4 acquisition failed');
  const snapshot = async () => ({ entry: await client.get(reservationKey(f.cartId, f.productId)),
    total: await client.get(productTotalKey(f.productId)), cart: (await client.smembers(cartIndexKey(f.cartId))).sort(),
    product: (await client.smembers(productIndexKey(f.productId))).sort(), pin: await client.get(checkoutPinKey(f.marker.id)),
    guard: await client.get(resourceGuardKey(f.marker.id)), receipt: await client.get(settlementReceiptKey(f.manifest.id)) });
  return { ...f, client, adapter, authority, repository, fresh, snapshot, acquired, evaluation };
}
