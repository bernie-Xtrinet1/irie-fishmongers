import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { assertDisposableEnvironment, withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY, resourceGuardKey, executionGateKey } from '../lua/reservation-mutation-common.lua';
import { RESERVATION_METADATA_LUA } from '../lua/reservation-metadata.lua';
import { checkoutPinKey, settlementGrantKey, settlementReceiptKey, REGISTER_SETTLEMENT_GRANT_LUA, settlementProtocol } from '../lua/checkout-settlement.lua';
import { FenceTuple } from '../types/reservation-fence.types';
import { REGISTER_MUTATION_PERMIT_LUA } from '../lua/reservation-mutation-guard.lua';
import { mutationPermitKey } from '../lua/reservation-mutation-common.lua';

async function isolated(work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  assertDisposableEnvironment();
  const redis = new Redis(process.env.REDIS_URL!);
  const keys: string[] = [];
  return withCleanup(() => withCleanup(async () => work(await setup(redis, keys)),
    [async () => { if (keys.length) await redis.del(...keys); }]), [() => redis.quit()]);
}
async function setup(redis: Redis, keys: string[]) {
  const tuple: FenceTuple = { incarnation: randomUUID(), epoch: 1, revision: 1, protocol: 1, phase: 'OPEN', transitionId: randomUUID() };
  const operationId = randomUUID(), manifestId = randomUUID();
  const resources = [0, 1].map(() => ({ customerId: randomUUID(), cartId: randomUUID(), productId: randomUUID(),
    markerId: randomUUID(), generation: 1, holdInstanceId: randomUUID() }));
  const identity = { manifestId, acquisitionReplayId: randomUUID(), incarnation: tuple.incarnation, epoch: tuple.epoch,
    execution: { operationId, attemptId: randomUUID(), gateId: operationId }, resources };
  const countKey = `test:settlement:count:${manifestId}`;
  keys.push(RESERVATION_FENCE_KEY, MUTATION_HISTORY_KEY, executionGateKey(operationId), countKey,
    settlementReceiptKey(manifestId), `reservation:fence:settlement-acquisition:${manifestId}`);
  expect(await redis.exists(RESERVATION_FENCE_KEY)).toBe(0);
  await redis.set(RESERVATION_FENCE_KEY, JSON.stringify(tuple));
  await redis.hset(MUTATION_HISTORY_KEY, 'incarnation', tuple.incarnation);
  await redis.set(executionGateKey(operationId), JSON.stringify({ incarnation: tuple.incarnation, epoch: 1,
    operationId, gateId: operationId, state: 'ENABLED' }));
  for (const r of resources) {
    keys.push(resourceGuardKey(r.markerId), checkoutPinKey(r.markerId));
    await redis.set(resourceGuardKey(r.markerId), JSON.stringify({ incarnation: tuple.incarnation, epoch: 1, resource: r }));
    await redis.hset(MUTATION_HISTORY_KEY, resourceGuardKey(r.markerId), '1');
  }
  await redis.set(countKey, '0');
  const terminalReplayId = randomUUID();
  const call = async (action: Parameters<typeof settlementProtocol>[0], override = identity, replayId = action === 'ACQUIRE' ? identity.acquisitionReplayId : terminalReplayId) => {
    const grant = settlementGrantKey(randomUUID()); keys.push(grant);
    const registered = JSON.parse(await redis.eval(REGISTER_SETTLEMENT_GRANT_LUA, 2, RESERVATION_FENCE_KEY, grant,
      JSON.stringify({ tuple, identity: JSON.stringify(override), action, replayId })) as string) as { code: string };
    if (registered.code !== 'ACCEPTED') return registered;
    return JSON.parse(await redis.eval(settlementProtocol(action,
      "if redis.call('TYPE',KEYS[3]).ok~='string' or not tonumber(redis.call('GET',KEYS[3])) then return rejected('PERMIT_SCOPE_MISMATCH') end",
      "redis.call('INCR',KEYS[3])"), 3, RESERVATION_FENCE_KEY, grant, countKey) as string) as { code: string; value?: unknown };
  };
  const advance = async () => JSON.parse(await redis.eval(RESERVATION_METADATA_LUA, 3, RESERVATION_FENCE_KEY,
    MUTATION_HISTORY_KEY, resourceGuardKey(resources[0]!.markerId), JSON.stringify(tuple), 'RESOURCE_ADVANCE',
    JSON.stringify({ incarnation: tuple.incarnation, epoch: 1, resource: { ...resources[0]!, generation: 2, holdInstanceId: randomUUID() } })) as string) as { code: string };
  return { redis, keys, tuple, identity, resources, countKey, call, advance };
}

describe('inactive settlement pin and outcome receipt protocol (synthetic physical effect)', () => {
  it.each(['OPEN', 'DRAINING'] as const)('pin blocks RESOURCE_ADVANCE in %s', phase => isolated(async f => {
    expect((await f.call('ACQUIRE')).code).toBe('ACCEPTED');
    f.tuple.phase = phase; await f.redis.set(RESERVATION_FENCE_KEY, JSON.stringify(f.tuple));
    expect((await f.advance()).code).toBe('FENCE_REJECTED');
    expect(await f.redis.get(checkoutPinKey(f.resources[0]!.markerId))).toBe(JSON.stringify(f.identity));
  }));
  it('recognizes exact owner and rejects relabel by another operation with zero writes', () => isolated(async f => {
    expect((await f.call('ACQUIRE')).code).toBe('ACCEPTED');
    expect((await f.call('ACQUIRE', { ...f.identity, execution: { ...f.identity.execution, attemptId: randomUUID() } })).code).toBe('FENCE_REJECTED');
    expect((await f.call('ACQUIRE')).code).toBe('ACCEPTED');
    expect(await f.redis.get(f.countKey)).toBe('1');
  }));
  it('rejects RESOURCE_INIT with a surviving pin and missing guard', () => isolated(async f => {
    await f.call('ACQUIRE');
    const r = f.resources[0]!;
    const pin = await f.redis.get(checkoutPinKey(r.markerId));
    await f.redis.del(resourceGuardKey(r.markerId));
    const result = JSON.parse(await f.redis.eval(RESERVATION_METADATA_LUA, 3, RESERVATION_FENCE_KEY,
      MUTATION_HISTORY_KEY, resourceGuardKey(r.markerId), JSON.stringify(f.tuple), 'RESOURCE_INIT',
      JSON.stringify({ incarnation: f.tuple.incarnation, epoch: 1, resource: r })) as string) as { code: string };
    expect(result.code).toBe('FENCE_REJECTED');
    expect(await f.redis.get(checkoutPinKey(r.markerId))).toBe(pin);
    expect(await f.redis.exists(resourceGuardKey(r.markerId))).toBe(0);
  }));
  it('retains unpinned valid RESOURCE_INIT and RESOURCE_ADVANCE', () => isolated(async f => {
    const r = { ...f.resources[0]!, markerId: randomUUID(), holdInstanceId: randomUUID() };
    const key = resourceGuardKey(r.markerId); f.keys.push(key);
    const init = JSON.parse(await f.redis.eval(RESERVATION_METADATA_LUA, 3, RESERVATION_FENCE_KEY,
      MUTATION_HISTORY_KEY, key, JSON.stringify(f.tuple), 'RESOURCE_INIT',
      JSON.stringify({ incarnation: f.tuple.incarnation, epoch: 1, resource: r })) as string) as { code: string };
    expect(init.code).toBe('ACCEPTED');
    expect((await f.advance()).code).toBe('ACCEPTED');
    expect(JSON.parse((await f.redis.get(resourceGuardKey(f.resources[0]!.markerId)))!) as object)
      .toMatchObject({ resource: { generation: 2 } });
  }));
  it('acquisition replay identity cannot substitute for terminal action identity', () => isolated(async f => {
    await f.call('ACQUIRE');
    expect((await f.call('CHECKOUT_FINALIZE', f.identity, f.identity.acquisitionReplayId)).code).toBe('FENCE_REJECTED');
    expect(await f.redis.get(f.countKey)).toBe('1');
    expect((await f.call('CHECKOUT_FINALIZE')).code).toBe('ACCEPTED');
    expect((await f.call('CHECKOUT_REVERT_DELETE_ONLY')).code).toBe('FENCE_REJECTED');
    expect(await f.redis.get(f.countKey)).toBe('2');
  }));
  it('blocks ordinary reserve authority while preserving W7 fixed-ceiling registration', () => isolated(async f => {
    await f.call('ACQUIRE');
    const register = async (lease: boolean) => {
      const permitId = randomUUID(); const key = mutationPermitKey(permitId); f.keys.push(key);
      const permit = { tuple: f.tuple, family: lease ? 'CHECKOUT_EXECUTION_OR_SETTLEMENT' : 'PRE_CHECKOUT_CART',
        purpose: lease ? 'CHECKOUT_EXECUTION' : 'CART_CONVERGENCE', effect: lease ? 'CHECKOUT_LEASE_EXTEND' : 'RESERVE',
        authorizationPhase: 'OPEN', constraint: lease ? { kind: 'LEASE_CEILING', ceilingMs: Date.now() + 1000 } : { kind: 'NONE' },
        resources: f.resources, execution: lease ? f.identity.execution : null, permitId, replayId: randomUUID(), expiresAt: 1 };
      return JSON.parse(await f.redis.eval(REGISTER_MUTATION_PERMIT_LUA, 2, RESERVATION_FENCE_KEY, key,
        JSON.stringify(permit), '5000') as string) as { code: string };
    };
    expect((await register(false)).code).toBe('FENCE_REJECTED');
    expect((await register(true)).code).toBe('ACCEPTED');
    expect(await f.redis.get(f.countKey)).toBe('1');
  }));
  it.each(['CHECKOUT_FINALIZE', 'CHECKOUT_REVERT_DELETE_ONLY'] as const)('%s in DRAINING releases pins and replay never repeats effect', action => isolated(async f => {
    await f.call('ACQUIRE'); f.tuple.phase = 'DRAINING'; await f.redis.set(RESERVATION_FENCE_KEY, JSON.stringify(f.tuple));
    expect(await f.call(action)).toMatchObject({ code: 'ACCEPTED', value: { completed: true, replayed: false } });
    expect(await f.call(action)).toMatchObject({ code: 'ACCEPTED', value: { completed: true, replayed: true } });
    expect(await f.redis.get(f.countKey)).toBe('2');
    expect(await f.redis.exists(...f.resources.map(r => checkoutPinKey(r.markerId)))).toBe(0);
  }));
  it('old receipt cannot settle a replacement identity', () => isolated(async f => {
    await f.call('ACQUIRE'); await f.call('CHECKOUT_FINALIZE');
    await f.redis.set(resourceGuardKey(f.resources[0]!.markerId), JSON.stringify({ incarnation: f.tuple.incarnation,
      epoch: 1, resource: { ...f.resources[0]!, generation: 2, holdInstanceId: randomUUID() } }));
    expect((await f.call('CHECKOUT_FINALIZE')).code).toBe('ACCEPTED'); // evidence only, no effect
    expect(await f.redis.get(f.countKey)).toBe('2');
    expect((await f.call('CHECKOUT_FINALIZE', { ...f.identity, resources: f.resources.map(r => ({ ...r, generation: 2 })) })).code).toBe('FENCE_REJECTED');
  }));
  it('concurrent completion attempts execute the aggregate effect once', () => isolated(async f => {
    await f.call('ACQUIRE');
    const results = await Promise.all([f.call('CHECKOUT_FINALIZE'), f.call('CHECKOUT_FINALIZE')]);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ACCEPTED', value: { completed: true, replayed: false } }),
      expect.objectContaining({ code: 'ACCEPTED', value: { completed: true, replayed: true } }),
    ]));
    expect(await f.redis.get(f.countKey)).toBe('2');
  }));
  it.each(['missing', 'malformed'] as const)('%s completion evidence remains unresolved after uncertainty', kind => isolated(async f => {
    await f.call('ACQUIRE'); await f.call('CHECKOUT_FINALIZE');
    const key = settlementReceiptKey(f.identity.manifestId);
    if (kind === 'missing') await f.redis.del(key); else await f.redis.set(key, 'not-json');
    expect((await f.call('CHECKOUT_FINALIZE')).code).toBe('FENCE_REJECTED');
    expect(await f.redis.get(f.countKey)).toBe('2');
  }));
  it('gate revocation alone does not consume settlement', () => isolated(async f => {
    await f.call('ACQUIRE');
    const key = executionGateKey(f.identity.execution.operationId);
    const gate = JSON.parse((await f.redis.get(key))!) as object;
    await f.redis.set(key, JSON.stringify({ ...gate, state: 'REVOKED' }));
    expect(await f.redis.exists(settlementReceiptKey(f.identity.manifestId))).toBe(0);
    expect((await f.call('CHECKOUT_FINALIZE')).code).toBe('ACCEPTED');
  }));
  it('validates every resource before any effect or pin release', () => isolated(async f => {
    await f.call('ACQUIRE');
    await f.redis.set(checkoutPinKey(f.resources[1]!.markerId), 'conflict');
    expect((await f.call('CHECKOUT_FINALIZE')).code).toBe('FENCE_REJECTED');
    expect(await f.redis.get(f.countKey)).toBe('1');
    expect(await f.redis.exists(checkoutPinKey(f.resources[0]!.markerId))).toBe(1);
  }));
  it.each(['FROZEN', 'RETIRED'] as const)('cannot mutate in %s', phase => isolated(async f => {
    await f.call('ACQUIRE'); f.tuple.phase = phase; await f.redis.set(RESERVATION_FENCE_KEY, JSON.stringify(f.tuple));
    expect((await f.call('CHECKOUT_FINALIZE')).code).toBe('FENCE_REJECTED');
    expect(await f.redis.get(f.countKey)).toBe('1');
  }));
});
