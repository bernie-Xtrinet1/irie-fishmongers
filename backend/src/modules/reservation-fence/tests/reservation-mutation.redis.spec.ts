import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { assertDisposableEnvironment, withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { RESERVATION_FENCE_CONTROL_LUA, RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { RESERVATION_METADATA_LUA } from '../lua/reservation-metadata.lua';
import { mutationGuard, REGISTER_MUTATION_PERMIT_LUA } from '../lua/reservation-mutation-guard.lua';
import { executionGateKey, MUTATION_HISTORY_KEY, mutationPermitKey, resourceGuardKey } from '../lua/reservation-mutation-common.lua';
import { DRAINING_MUTATION_EFFECTS, MAX_LEASE_CEILING_MS, MutationAuthorizationPhase, MutationEffect, MutationPermit, MutationRejection, MutationResult } from '../types/reservation-mutation.types';
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
    effect: 'CHECKOUT_MARK', authorizationPhase: 'OPEN', constraint: { kind: 'NONE' },
    resources: [r], execution: { operationId, attemptId: randomUUID(), gateId: operationId },
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
  const execute = async (expected: MutationPermit = p) => JSON.parse(await redis.eval(mutationGuard('CHECKOUT_MARK') +
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
async function rejection(f: Fixture, reason: MutationRejection, expected: MutationPermit = f.p) {
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
    const spoof: MutationPermit = { ...f.p, effect: 'CHECKOUT_LEASE_EXTEND', constraint: { kind: 'LEASE_CEILING', ceilingMs: Date.now() + 30000 } };
    await f.redis.set(mutationPermitKey(f.p.permitId), JSON.stringify(spoof));
    await rejection(f, 'EFFECT_MISMATCH', spoof);
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

// Synthetic effects only: no W1-W8 writer or production caller is integrated.
async function snapshot(f: Fixture) {
  return Promise.all(f.keys.map(key => f.redis.dump(key)));
}
async function register(f: Fixture, permit: unknown) {
  return JSON.parse(await f.redis.eval(REGISTER_MUTATION_PERMIT_LUA, 2, RESERVATION_FENCE_KEY,
    mutationPermitKey(f.p.permitId), JSON.stringify(permit), '5000') as string) as MutationResult<MutationPermit>;
}
async function preparePermit(f: Fixture, effect: MutationEffect, phase: MutationAuthorizationPhase = 'OPEN'): Promise<MutationPermit> {
  let tuple: FenceTuple = f.t;
  if (phase === 'DRAINING') {
    tuple = { ...f.t, phase, revision: f.t.revision + 1, transitionId: randomUUID() };
    expect(await f.redis.eval(RESERVATION_FENCE_CONTROL_LUA, 1, RESERVATION_FENCE_KEY,
      'CAS', JSON.stringify(tuple), JSON.stringify(f.t))).toEqual(['ACCEPTED']);
  }
  await f.redis.del(mutationPermitKey(f.p.permitId));
  const purpose = ['RESERVE', 'RENEW', 'REDUCTION_RECREATE', 'RELEASE'].includes(effect) ? 'CART_CONVERGENCE' :
    ['CHECKOUT_MARK', 'CHECKOUT_LEASE_EXTEND'].includes(effect) ? 'CHECKOUT_EXECUTION' :
      effect.startsWith('CHECKOUT_') ? 'CHECKOUT_SETTLEMENT' : 'RESOURCE_REPAIR';
  const family = purpose === 'CART_CONVERGENCE' ? 'PRE_CHECKOUT_CART' :
    purpose === 'RESOURCE_REPAIR' ? 'ADMIN_OR_RECOVERY' : 'CHECKOUT_EXECUTION_OR_SETTLEMENT';
  const identity = { ...f.p, tuple, authorizationPhase: phase, purpose, family,
    execution: family === 'CHECKOUT_EXECUTION_OR_SETTLEMENT' ? f.p.execution : null } as const;
  return effect === 'CHECKOUT_LEASE_EXTEND'
    ? { ...identity, effect, constraint: { kind: 'LEASE_CEILING', ceilingMs: Date.now() + 30000 } }
    : { ...identity, effect, constraint: { kind: 'NONE' } };
}
async function registered(f: Fixture, permit: MutationPermit) {
  const result = await register(f, permit);
  expect(result.code).toBe('ACCEPTED');
  if (result.code !== 'ACCEPTED') throw new Error('Synthetic permit denied');
  return result.value;
}
async function mutate(f: Fixture, effect: MutationEffect, expected: unknown, target = '') {
  const body = effect === 'CHECKOUT_LEASE_EXTEND'
    ? "redis.call('SET',KEYS[3],tostring(authorizedLeaseTargetMs)) return accepted()"
    : "redis.call('SET',KEYS[3],'changed') return accepted()";
  return JSON.parse(await f.redis.eval(mutationGuard(effect) + body, 3, RESERVATION_FENCE_KEY,
    mutationPermitKey(f.p.permitId), f.synthetic, JSON.stringify(expected), target) as string) as MutationResult<true>;
}
async function unchanged(f: Fixture, work: () => Promise<MutationResult<unknown>>, reason?: MutationRejection) {
  const before = await snapshot(f);
  const result = await work();
  if (reason) expect(result).toEqual({ code: 'FENCE_REJECTED', reason });
  else expect(result.code).toBe('FENCE_REJECTED');
  expect(await snapshot(f)).toEqual(before);
}

describe('G.4b.2a.1 explicit physical phase and bounded lease authority', () => {
  it.each(DRAINING_MUTATION_EFFECTS)('registers and executes narrow DRAINING %s', effect => isolated(async f => {
    const p = await registered(f, await preparePermit(f, effect, 'DRAINING'));
    const target = p.effect === 'CHECKOUT_LEASE_EXTEND' ? String(p.constraint.ceilingMs) : '';
    expect(await mutate(f, effect, p, target)).toEqual({ code: 'ACCEPTED', value: true });
    expect(await f.redis.get(f.synthetic)).not.toBe('unchanged');
  }));
  it.each(['RESERVE', 'RENEW', 'REDUCTION_RECREATE', 'CHECKOUT_MARK', 'CHECKOUT_REVERT_RESTORE_ACTIVE',
    'RECONCILE_POSITIVE', 'BACKFILL', 'CART_SYNC_RECOVERY', 'COMPENSATION', 'ORPHAN_CLEANUP',
    'FRESHNESS_SWEEP', 'TERMINAL_CLEANUP', 'EXPIRED_ACTIVE_RELEASE'] as const)
    ('never registers DRAINING %s', effect => isolated(async f => {
      const p = await preparePermit(f, effect, 'DRAINING');
      await unchanged(f, () => register(f, p));
      // A forged physical record still cannot bypass the compiled prefix.
      await f.redis.set(mutationPermitKey(p.permitId), JSON.stringify({ ...p, expiresAt: Date.now() + 5000 }));
      await unchanged(f, () => mutate(f, effect, p));
    }));
  it('rejects an explicit DRAINING authorization against OPEN even with an OPEN tuple', () => isolated(async f => {
    const p = { ...await preparePermit(f, 'RELEASE'), authorizationPhase: 'DRAINING' as const };
    await unchanged(f, () => register(f, p), 'PHASE_DENIED');
  }));
  it.each(['OPEN', 'DRAINING'] as const)('invalidates %s permits on a restrictive CAS', phase => isolated(async f => {
    const p = await registered(f, await preparePermit(f, 'RELEASE', phase));
    const next = { ...p.tuple, revision: p.tuple.revision + 1,
      phase: phase === 'OPEN' ? 'DRAINING' : 'FROZEN', transitionId: randomUUID() };
    expect(await f.redis.eval(RESERVATION_FENCE_CONTROL_LUA, 1, RESERVATION_FENCE_KEY,
      'CAS', JSON.stringify(next), JSON.stringify(p.tuple))).toEqual(['ACCEPTED']);
    await unchanged(f, () => mutate(f, 'RELEASE', p), 'STALE_REVISION');
  }));
  it.each(['OPEN', 'DRAINING'] as const)('denies %s permits under every different physical phase', phase => isolated(async f => {
    const p = await registered(f, await preparePermit(f, 'RELEASE', phase));
    for (const physical of ['OPEN', 'DRAINING', 'FROZEN', 'RETIRED'] as const) {
      if (physical === phase) continue;
      await f.redis.set(RESERVATION_FENCE_KEY, JSON.stringify({ ...p.tuple, phase: physical }));
      await unchanged(f, () => mutate(f, 'RELEASE', p), 'DURABLE_REDIS_DISAGREEMENT');
      // Caller cannot rebind either authorization to a closed phase.
      await f.redis.del(mutationPermitKey(p.permitId));
      await unchanged(f, () => register(f, { ...p, tuple: { ...p.tuple, phase: physical } }), 'PHASE_DENIED');
    }
  }));
  it('accepts only OPEN maintenance positive reconciliation and binds the compiled effect', () => isolated(async f => {
    const p = await registered(f, await preparePermit(f, 'RECONCILE_POSITIVE'));
    expect(p.purpose).toBe('RESOURCE_REPAIR');
    await unchanged(f, () => mutate(f, 'RECONCILE_NONINCREASING', p), 'EFFECT_MISMATCH');
    await unchanged(f, () => mutate(f, 'RECONCILE_POSITIVE', { ...p, purpose: 'CART_CONVERGENCE' }), 'MALFORMED_PERMIT');
    expect(await mutate(f, 'RECONCILE_POSITIVE', p)).toEqual({ code: 'ACCEPTED', value: true });
  }));
  it.each([
    ['incarnation', randomUUID(), 'WRONG_INCARNATION'], ['epoch', 9, 'EPOCH_MISMATCH'],
    ['revision', 9, 'STALE_REVISION'], ['protocol', 9, 'PROTOCOL_MISMATCH'],
    ['transitionId', randomUUID(), 'DURABLE_REDIS_DISAGREEMENT'],
  ] as const)('positive reconciliation rejects stale/wrong %s at registration and execution', (field, value, reason) => isolated(async f => {
    const p = await preparePermit(f, 'RECONCILE_POSITIVE');
    const bad = { ...p, tuple: { ...p.tuple, [field]: value } };
    await unchanged(f, () => register(f, bad), reason);
    const live = await registered(f, p);
    await unchanged(f, () => mutate(f, 'RECONCILE_POSITIVE', { ...live, tuple: bad.tuple }), reason);
  }));
  it.each(['FROZEN', 'RETIRED'] as const)('positive reconciliation cannot register or execute in %s', phase => isolated(async f => {
    const p = await preparePermit(f, 'RECONCILE_POSITIVE');
    p.tuple.phase = phase;
    await f.redis.set(RESERVATION_FENCE_KEY, JSON.stringify(p.tuple));
    await unchanged(f, () => register(f, p), 'PHASE_DENIED');
    await f.redis.set(mutationPermitKey(p.permitId), JSON.stringify({ ...p, expiresAt: Date.now() + 5000 }));
    await unchanged(f, () => mutate(f, 'RECONCILE_POSITIVE', p), 'PHASE_DENIED');
  }));
  it.each([undefined, null, {}, { kind: 'NONE' }, { kind: 'UNKNOWN', ceilingMs: 1000 },
    { kind: 'LEASE_CEILING' }, { kind: 'LEASE_CEILING', ceilingMs: '1000' },
    { kind: 'LEASE_CEILING', ceilingMs: 0 }, { kind: 'LEASE_CEILING', ceilingMs: -1 },
    { kind: 'LEASE_CEILING', ceilingMs: 1.5 }, { kind: 'LEASE_CEILING', ceilingMs: Number.MAX_SAFE_INTEGER + 1 },
    { kind: 'LEASE_CEILING', ceilingMs: 1000, refresh: true }])
    ('fails closed for invalid lease constraint %#', constraint => isolated(async f => {
      const p = await preparePermit(f, 'CHECKOUT_LEASE_EXTEND');
      const bad = { ...p, constraint };
      await unchanged(f, () => register(f, bad), 'MALFORMED_PERMIT');
      await registered(f, p);
      await unchanged(f, () => mutate(f, 'CHECKOUT_LEASE_EXTEND', bad, '1000'), 'MALFORMED_PERMIT');
      await f.redis.set(mutationPermitKey(p.permitId), JSON.stringify({ ...bad, expiresAt: Date.now() + 5000 }));
      await unchanged(f, () => mutate(f, 'CHECKOUT_LEASE_EXTEND', p, '1000'), 'MALFORMED_PERMIT');
    }));
  it.each(['', 'bad', '0', '-1', '1.5', 'Infinity', '9007199254740992'])
    ('rejects malformed requested lease target %s', target => isolated(async f => {
      const p = await registered(f, await preparePermit(f, 'CHECKOUT_LEASE_EXTEND'));
      await unchanged(f, () => mutate(f, p.effect, p, target), 'PERMIT_SCOPE_MISMATCH');
    }));
  it.each([MAX_LEASE_CEILING_MS, MAX_LEASE_CEILING_MS - 1])('preserves the exact upper-bound ceiling %s through Redis JSON', ceilingMs => isolated(async f => {
    const base = await preparePermit(f, 'CHECKOUT_LEASE_EXTEND');
    const p = await registered(f, { ...base, effect: 'CHECKOUT_LEASE_EXTEND', constraint: { kind: 'LEASE_CEILING', ceilingMs } });
    expect(p.constraint).toEqual({ kind: 'LEASE_CEILING', ceilingMs });
    await unchanged(f, () => mutate(f, p.effect, p, String(ceilingMs + 1)), 'PERMIT_SCOPE_MISMATCH');
    expect(await mutate(f, p.effect, p, String(ceilingMs))).toEqual({ code: 'ACCEPTED', value: true });
    expect(Number(await f.redis.get(f.synthetic))).toBe(ceilingMs);
  }));
  it('rejects a ceiling outside the exact serialization range', () => isolated(async f => {
    const p = await preparePermit(f, 'CHECKOUT_LEASE_EXTEND');
    await unchanged(f, () => register(f, { ...p, constraint: { kind: 'LEASE_CEILING', ceilingMs: MAX_LEASE_CEILING_MS + 1 } }), 'MALFORMED_PERMIT');
  }));
  it.each([0, -1000])('uses a fixed authorized lease target with offset %s', offset => isolated(async f => {
    const p = await registered(f, await preparePermit(f, 'CHECKOUT_LEASE_EXTEND'));
    if (p.effect !== 'CHECKOUT_LEASE_EXTEND') throw new Error('Wrong fixture effect');
    const target = p.constraint.ceilingMs + offset;
    await unchanged(f, () => mutate(f, p.effect, p, String(p.constraint.ceilingMs + 1)), 'PERMIT_SCOPE_MISMATCH');
    await unchanged(f, () => mutate(f, p.effect, { ...p, constraint: { kind: 'LEASE_CEILING', ceilingMs: p.constraint.ceilingMs + 10000 } },
      String(p.constraint.ceilingMs + 1)), 'PERMIT_SCOPE_MISMATCH');
    expect(await mutate(f, p.effect, p, String(target))).toEqual({ code: 'ACCEPTED', value: true });
    expect(Number(await f.redis.get(f.synthetic))).toBe(target);
    const stored = JSON.parse((await f.redis.get(mutationPermitKey(p.permitId)))!) as MutationPermit;
    expect(stored.constraint).toEqual(p.constraint);
  }));
  it('rejects lease metadata on an unrelated effect and missing/unknown phase without defaults', () => isolated(async f => {
    const p = await preparePermit(f, 'RELEASE');
    for (const bad of [{ ...p, constraint: { kind: 'LEASE_CEILING', ceilingMs: 1000 } },
      { ...p, authorizationPhase: undefined }, { ...p, authorizationPhase: 'FROZEN' },
      { ...p, authorizationPhase: 'RETIRED' }, { ...p, authorizationPhase: 'UNKNOWN' }, { ...p, arbitrary: true }]) {
      await unchanged(f, () => register(f, bad), 'MALFORMED_PERMIT');
    }
  }));
});
