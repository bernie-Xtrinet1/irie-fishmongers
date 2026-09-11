import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { assertDisposableEnvironment } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { executionGateKey, mutationPermitKey, resourceGuardKey } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { REGISTER_MUTATION_PERMIT_LUA } from '../../reservation-fence/lua/reservation-mutation-guard.lua';
import { MutationPermit, MutationResult } from '../../reservation-fence/types/reservation-mutation.types';
import { cartIndexKey } from '../constants/inventory.constants';

// Synthetic authority fixture only; never imported by production. Callers own
// the disposable Redis control key and all UUID metadata in their cleanup set.
export async function leasePermit(client: Redis, owned: Set<string>, cartId: string, customerId: string,
  now: number, seconds: number): Promise<MutationPermit> {
  assertDisposableEnvironment();
  const existing = await client.get(RESERVATION_FENCE_KEY);
  if (existing && !owned.has(RESERVATION_FENCE_KEY)) throw new Error('Unexpected fixture control');
  const tuple = existing ? JSON.parse(existing) as MutationPermit['tuple'] : {
    incarnation: randomUUID(), epoch: 1, revision: 1, transitionId: randomUUID(), phase: 'OPEN' as const, protocol: 1,
  };
  owned.add(RESERVATION_FENCE_KEY);
  await client.set(RESERVATION_FENCE_KEY, JSON.stringify(tuple));
  const products = await client.smembers(cartIndexKey(cartId));
  const resources = (products.length ? products : [randomUUID()]).map(productId => ({
    customerId, cartId, productId, markerId: randomUUID(), generation: 1, holdInstanceId: randomUUID(),
  }));
  const operationId = randomUUID();
  const p: MutationPermit = { tuple, effect: 'CHECKOUT_LEASE_EXTEND', authorizationPhase: 'OPEN',
    constraint: { kind: 'LEASE_CEILING', ceilingMs: now + seconds * 1000 },
    family: 'CHECKOUT_EXECUTION_OR_SETTLEMENT', purpose: 'CHECKOUT_EXECUTION', resources,
    execution: { operationId, attemptId: randomUUID(), gateId: operationId },
    permitId: randomUUID(), replayId: randomUUID(), expiresAt: 1 };
  for (const resource of resources) {
    owned.add(resourceGuardKey(resource.markerId));
    await client.set(resourceGuardKey(resource.markerId), JSON.stringify({ incarnation: tuple.incarnation, epoch: tuple.epoch, resource }));
  }
  owned.add(executionGateKey(operationId)); owned.add(mutationPermitKey(p.permitId));
  await client.set(executionGateKey(operationId), JSON.stringify({ incarnation: tuple.incarnation, epoch: tuple.epoch,
    operationId, gateId: operationId, state: 'ENABLED' }));
  const result = JSON.parse(await client.eval(REGISTER_MUTATION_PERMIT_LUA, 2, RESERVATION_FENCE_KEY,
    mutationPermitKey(p.permitId), JSON.stringify(p), '5000') as string) as MutationResult<MutationPermit>;
  if (result.code !== 'ACCEPTED') throw new Error('Fixture permit registration rejected');
  return result.value;
}
