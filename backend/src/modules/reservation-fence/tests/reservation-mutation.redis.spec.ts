import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { assertDisposableEnvironment, withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { RESERVATION_FENCE_CONTROL_LUA, RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { RESERVATION_METADATA_LUA } from '../lua/reservation-metadata.lua';
import { mutationGuard, REGISTER_MUTATION_PERMIT_LUA } from '../lua/reservation-mutation-guard.lua';
import { executionGateKey, MUTATION_HISTORY_KEY, mutationPermitKey, resourceGuardKey } from '../lua/reservation-mutation-common.lua';
import { MutationPermit, MutationRejection, MutationResult } from '../types/reservation-mutation.types';
import { FenceTuple } from '../types/reservation-fence.types';

type Fixture = Awaited<ReturnType<typeof setup>>;
async function setup(redis: Redis, owned: string[]) {
  owned.push(RESERVATION_FENCE_KEY, MUTATION_HISTORY_KEY);
  const t: FenceTuple = { incarnation: randomUUID(), epoch: 1, revision: 1, phase: 'FROZEN', protocol: 1, transitionId: randomUUID() };
  const call = async (verb: string, target: FenceTuple, expected?: FenceTuple) => redis.eval(RESERVATION_FENCE_CONTROL_LUA,
    1, RESERVATION_FENCE_KEY, verb, JSON.stringify(target), expected ? JSON.stringify(expected) : '');
  expect(await call('BOOTSTRAP', t)).toEqual(['ACCEPTED']);
  const open = { ...t, revision: 2, phase: 'OPEN' as const, transitionId: randomUUID() };
  expect(await call('CAS', open, t)).toEqual(['ACCEPTED']);
  const r = { customerId: randomUUID(), cartId: randomUUID(), productId: randomUUID(), markerId: randomUUID(), generation: 1, holdInstanceId: randomUUID() };
  const operationId = randomUUID();
  const gate = { incarnation: t.incarnation, epoch: t.epoch, operationId, gateId: operationId, state: 'ENABLED' };
  const guard = { incarnation: t.incarnation, epoch: t.epoch, resource: r };
  const synthetic = `test:fence:${randomUUID()}`;
  const p: MutationPermit = { tuple: open, family: 'CHECKOUT_EXECUTION_OR_SETTLEMENT', purpose: 'CHECKOUT_EXECUTION',
    effect: 'CHECKOUT_MARK', resources: [r], execution: { operationId, attemptId: randomUUID(), gateId: operationId },
    permitId: randomUUID(), replayId: randomUUID(), expiresAt: 1 };
  owned.push(mutationPermitKey(p.permitId), resourceGuardKey(r.markerId), executionGateKey(operationId), synthetic);
  const metadata = async (action: string, key: string, record: object) => JSON.parse(await redis.eval(RESERVATION_METADATA_LUA,
    3, RESERVATION_FENCE_KEY, MUTATION_HISTORY_KEY, key, JSON.stringify(open), action, JSON.stringify(record)) as string) as MutationResult<true>;
  expect((await metadata('RESOURCE_INIT', resourceGuardKey(r.markerId), guard)).code).toBe('ACCEPTED');
  expect((await metadata('GATE_INIT', executionGateKey(operationId), gate)).code).toBe('ACCEPTED');
  const registered = JSON.parse(await redis.eval(REGISTER_MUTATION_PERMIT_LUA, 2, RESERVATION_FENCE_KEY,
    mutationPermitKey(p.permitId), JSON.stringify(p), '5000') as string) as MutationResult<MutationPermit>;
  if (registered.code !== 'ACCEPTED') throw new Error('Fixture registration failed');
  Object.assign(p, registered.value);
  await redis.set(synthetic, 'unchanged');
  const execute = async (expected = p) => JSON.parse(await redis.eval(mutationGuard('CHECKOUT_MARK') +
    "redis.call('SET',KEYS[3],'changed') return accepted()", 3, RESERVATION_FENCE_KEY,
  mutationPermitKey(p.permitId), synthetic, JSON.stringify(expected)) as string) as MutationResult<true>;
  return { redis, t: open, r, p, gate, guard, synthetic, metadata, execute,
    keys: [RESERVATION_FENCE_KEY, MUTATION_HISTORY_KEY, mutationPermitKey(p.permitId),
      resourceGuardKey(r.markerId), executionGateKey(operationId), synthetic] };
}
async function isolated(work: (f: Fixture) => Promise<void>) {
  assertDisposableEnvironment();
  const redis = new Redis(process.env.REDIS_URL!);
  const owned: string[] = [];
  return withCleanup(() => withCleanup(async () => {
    expect(await redis.exists(RESERVATION_FENCE_KEY, MUTATION_HISTORY_KEY)).toBe(0);
    const f = await setup(redis, owned);
    await work(f);
  }, [async () => { if (owned.length) await redis.del(...owned); }]), [() => redis.quit()]);
}
async function rejection(f: Fixture, reason: MutationRejection, expected = f.p) {
  expect(await f.execute(expected)).toEqual({ code: 'FENCE_REJECTED', reason });
  expect(await f.redis.get(f.synthetic)).toBe('unchanged');
}

describe('G.4b.2a real Redis authorization before synthetic mutation', () => {
  it('accepts an exact registered permit and uses Redis expiry', () => isolated(async f => {
    const time = await f.redis.time();
    expect(f.p.expiresAt).toBeGreaterThan(Number(time[0]) * 1000);
    expect(await f.redis.pttl(mutationPermitKey(f.p.permitId))).toBeGreaterThan(0);
    expect(await f.execute()).toEqual({ code: 'ACCEPTED', value: true });
    expect(await f.redis.get(f.synthetic)).toBe('changed');
  }));
  it.each([
    ['incarnation', randomUUID(), 'WRONG_INCARNATION'], ['epoch', 99, 'EPOCH_MISMATCH'],
    ['revision', 99, 'STALE_REVISION'], ['protocol', 99, 'PROTOCOL_MISMATCH'],
    ['transitionId', randomUUID(), 'DURABLE_REDIS_DISAGREEMENT'],
  ] as const)('rejects wrong %s', (field, value, reason) => isolated(f =>
    rejection(f, reason, { ...f.p, tuple: { ...f.t, [field]: value } })));
  it.each(['FROZEN', 'RETIRED'] as const)('denies %s before mutation', phase => isolated(async f => {
    f.p.tuple.phase = phase;
    await f.redis.set(RESERVATION_FENCE_KEY, JSON.stringify(f.p.tuple));
    await f.redis.set(mutationPermitKey(f.p.permitId), JSON.stringify(f.p));
    await rejection(f, 'PHASE_DENIED');
  }));
  it.each(['control', 'permit', 'resource', 'gate'] as const)('missing %s is denied', kind => isolated(async f => {
    const map = { control: [RESERVATION_FENCE_KEY, 'MISSING_CONTROL'], permit: [mutationPermitKey(f.p.permitId), 'MISSING_PERMIT'],
      resource: [resourceGuardKey(f.r.markerId), 'MISSING_RESOURCE_GUARD'], gate: [executionGateKey(f.gate.gateId), 'MISSING_EXECUTION_GATE'] } as const;
    await f.redis.del(map[kind][0]); await rejection(f, map[kind][1]);
  }));
  it.each(['control', 'permit', 'resource', 'gate'] as const)('malformed %s is denied', kind => isolated(async f => {
    const map = { control: [RESERVATION_FENCE_KEY, 'MALFORMED_CONTROL'], permit: [mutationPermitKey(f.p.permitId), 'MALFORMED_PERMIT'],
      resource: [resourceGuardKey(f.r.markerId), 'MALFORMED_RESOURCE_GUARD'], gate: [executionGateKey(f.gate.gateId), 'MALFORMED_EXECUTION_GATE'] } as const;
    await f.redis.set(map[kind][0], '{}'); await rejection(f, map[kind][1]);
  }));
  it('checks expiry against Redis time, not caller time', () => isolated(async f => {
    await f.redis.set(mutationPermitKey(f.p.permitId), JSON.stringify({ ...f.p, expiresAt: 1 }));
    await rejection(f, 'EXPIRED_PERMIT');
  }));
  it('binds scope', () => isolated(f => rejection(f, 'PERMIT_SCOPE_MISMATCH',
    { ...f.p, resources: [{ ...f.r, customerId: randomUUID() }] })));
  it('binds replay identity', () => isolated(f => rejection(f, 'REPLAY_MISMATCH', { ...f.p, replayId: randomUUID() })));
  it('hardcodes effect even if both request and record lie', () => isolated(async f => {
    f.p.effect = 'CHECKOUT_LEASE_EXTEND'; await f.redis.set(mutationPermitKey(f.p.permitId), JSON.stringify(f.p));
    await rejection(f, 'EFFECT_MISMATCH');
  }));
  it('cannot disguise execution as settlement to bypass a closed gate', () => isolated(async f => {
    await f.metadata('GATE_CLOSE', executionGateKey(f.gate.gateId), f.gate);
    f.p.purpose = 'CHECKOUT_SETTLEMENT';
    await f.redis.set(mutationPermitKey(f.p.permitId), JSON.stringify(f.p));
    await rejection(f, 'MALFORMED_PERMIT');
  }));
  it('rejects a delayed permit after revision change', () => isolated(async f => {
    await f.redis.set(RESERVATION_FENCE_KEY, JSON.stringify({ ...f.t, revision: f.t.revision + 1 }));
    await rejection(f, 'STALE_REVISION');
  }));
  it('supersedes resource generation and never revives deleted/replaced instances', () => isolated(async f => {
    const newer = { ...f.guard, resource: { ...f.r, generation: 2, holdInstanceId: randomUUID() } };
    expect((await f.metadata('RESOURCE_ADVANCE', resourceGuardKey(f.r.markerId), newer)).code).toBe('ACCEPTED');
    await rejection(f, 'RESOURCE_GENERATION_MISMATCH');
    expect((await f.metadata('RESOURCE_INIT', resourceGuardKey(f.r.markerId), f.guard)).code).toBe('FENCE_REJECTED');
    await f.redis.del(resourceGuardKey(f.r.markerId));
    expect(await f.metadata('RESOURCE_INIT', resourceGuardKey(f.r.markerId), f.guard))
      .toEqual({ code: 'FENCE_REJECTED', reason: 'MISSING_RESOURCE_GUARD' });
  }));
  it.each(['CLOSED', 'REVOKED'] as const)('a delayed initializer cannot reopen %s or reconstruct a lost gate', state => isolated(async f => {
    expect((await f.metadata(state === 'CLOSED' ? 'GATE_CLOSE' : 'GATE_REVOKE', executionGateKey(f.gate.gateId), f.gate)).code).toBe('ACCEPTED');
    await rejection(f, state === 'CLOSED' ? 'EXECUTION_GATE_CLOSED' : 'CAPABILITY_REVOKED');
    expect((await f.metadata('GATE_INIT', executionGateKey(f.gate.gateId), f.gate)).code).toBe('FENCE_REJECTED');
    expect(await f.redis.pttl(executionGateKey(f.gate.gateId))).toBe(-1);
    await f.redis.del(executionGateKey(f.gate.gateId));
    expect(await f.metadata('GATE_INIT', executionGateKey(f.gate.gateId), f.gate))
      .toEqual({ code: 'FENCE_REJECTED', reason: 'MISSING_EXECUTION_GATE' });
  }));
  it('duplicate initialization and restrictive transitions are idempotent', () => isolated(async f => {
    for (const action of ['GATE_INIT', 'GATE_CLOSE', 'GATE_CLOSE', 'GATE_REVOKE', 'GATE_REVOKE', 'GATE_CLOSE'])
      expect((await f.metadata(action, executionGateKey(f.gate.gateId), f.gate)).code).toBe('ACCEPTED');
    await rejection(f, 'CAPABILITY_REVOKED');
  }));
  it.each([['incarnation', randomUUID(), 'WRONG_INCARNATION'], ['epoch', 2, 'EPOCH_MISMATCH']] as const)
    ('gate rejects wrong %s without touching newer state', (field, value, reason) => isolated(async f => {
      const key = executionGateKey(f.gate.gateId);
      const before = await f.redis.get(key);
      expect(await f.metadata('GATE_REVOKE', key, { ...f.gate, [field]: value }))
        .toEqual({ code: 'FENCE_REJECTED', reason });
      expect(await f.redis.get(key)).toBe(before);
    }));
  it('duplicate resource initialization preserves exact hold identity', () => isolated(async f => {
    const key = resourceGuardKey(f.r.markerId);
    expect((await f.metadata('RESOURCE_INIT', key, f.guard)).code).toBe('ACCEPTED');
    expect((await f.metadata('RESOURCE_ADVANCE', key, { ...f.guard,
      resource: { ...f.r, holdInstanceId: randomUUID() } })).code).toBe('FENCE_REJECTED');
    expect(await f.redis.pttl(key)).toBe(-1);
  }));
  it('lost initialization history cannot be recreated by bootstrap replay', () => isolated(async f => {
    await f.redis.del(MUTATION_HISTORY_KEY);
    expect((await f.metadata('GATE_INIT', executionGateKey(f.gate.gateId), f.gate)).code).toBe('FENCE_REJECTED');
    await f.redis.eval(RESERVATION_FENCE_CONTROL_LUA, 1, RESERVATION_FENCE_KEY, 'BOOTSTRAP', JSON.stringify(f.t), '');
    expect(await f.redis.exists(MUTATION_HISTORY_KEY)).toBe(0);
  }));
});
