import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { assertDisposableEnvironment, withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { RESERVATION_FENCE_CONTROL_LUA, RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { FenceTuple, FENCE_PHASES, phaseTransition } from '../types/reservation-fence.types';

export function tuple(overrides: Partial<FenceTuple> = {}): FenceTuple {
  return { incarnation: randomUUID(), epoch: 1, revision: 1, phase: 'FROZEN', protocol: 1,
    transitionId: randomUUID(), ...overrides };
}
export async function command(redis: Redis, verb: string, target?: FenceTuple, expected?: FenceTuple) {
  return (await redis.eval(RESERVATION_FENCE_CONTROL_LUA, 1, RESERVATION_FENCE_KEY, verb,
    target ? JSON.stringify(target) : '', expected ? JSON.stringify(expected) : '')) as string[];
}
async function isolated(work: (redis: Redis) => Promise<void>) {
  assertDisposableEnvironment(); // Before client construction or destructive work.
  const redis = new Redis(process.env.REDIS_URL!);
  return withCleanup(async () => {
    expect(await redis.exists(RESERVATION_FENCE_KEY)).toBe(0);
    return withCleanup(() => work(redis), [() => redis.del(RESERVATION_FENCE_KEY)]);
  }, [() => redis.quit()]);
}

describe('G.4b.1 real Redis control CAS (standalone isolated endpoint)', () => {
  it('missing control cannot CAS or read; closed bootstrap only', () => isolated(async redis => {
    const initial = tuple();
    expect((await command(redis, 'READ'))[0]).toBe('MISSING_CONTROL');
    expect((await command(redis, 'CAS', tuple({ ...initial, revision: 2, phase: 'OPEN' }), initial))[0]).toBe('MISSING_CONTROL');
    expect((await command(redis, 'BOOTSTRAP', { ...initial, phase: 'OPEN' }))[0]).toBe('ILLEGAL_PHASE_TRANSITION');
    expect((await command(redis, 'BOOTSTRAP', initial))[0]).toBe('ACCEPTED');
    expect((JSON.parse((await command(redis, 'READ'))[1]!) as FenceTuple).phase).toBe('FROZEN');
    expect((await command(redis, 'BOOTSTRAP', initial))[0]).toBe('ACCEPTED');
    expect((await command(redis, 'BOOTSTRAP', tuple()))[0]).toBe('DURABLE_REDIS_DISAGREEMENT');
  }));
  it.each(['invalid', '{}', 'null', '[]', '{"phase":"OPEN"}'])('malformed control fails closed %#', raw => isolated(async redis => {
    await redis.set(RESERVATION_FENCE_KEY, raw);
    expect((await command(redis, 'BOOTSTRAP', tuple()))[0]).toBe('MALFORMED_CONTROL');
    expect((await command(redis, 'READ'))[0]).toBe('MALFORMED_CONTROL');
  }));
  it('wrong Redis data type is a typed failure', () => isolated(async redis => {
    await redis.hset(RESERVATION_FENCE_KEY, 'phase', 'OPEN');
    expect((await command(redis, 'READ'))[0]).toBe('MALFORMED_CONTROL');
  }));
  for (const from of FENCE_PHASES) for (const to of FENCE_PHASES) {
    it(`real CAS ${from} -> ${to}`, () => isolated(async redis => {
      const old = tuple({ phase: from });
      // Explicit test fixture: simulates each predecessor; not control API.
      await redis.set(RESERVATION_FENCE_KEY, JSON.stringify(old));
      const next = { ...old, revision: 2, phase: to, transitionId: randomUUID() };
      expect((await command(redis, 'CAS', next, old))[0]).toBe(phaseTransition(from, to) ? 'ACCEPTED' : 'ILLEGAL_PHASE_TRANSITION');
    }));
  }
  it.each([
    ['incarnation', randomUUID(), 'WRONG_INCARNATION'],
    ['epoch', 2, 'EPOCH_MISMATCH'],
    ['revision', 2, 'STALE_REVISION'],
    ['transitionId', randomUUID(), 'PREDECESSOR_MISMATCH'],
    ['phase', 'DRAINING', 'PREDECESSOR_MISMATCH'],
    ['protocol', 2, 'PROTOCOL_MISMATCH'],
  ])('rejects mismatched predecessor %s', (field, value, code) => isolated(async redis => {
    const expected = tuple({ phase: 'OPEN' });
    await redis.set(RESERVATION_FENCE_KEY, JSON.stringify({ ...expected, [field]: value }));
    expect((await command(redis, 'CAS', { ...expected, revision: 3, phase: 'FROZEN', transitionId: randomUUID() }, expected))[0]).toBe(code);
  }));
  it('delayed OPEN and delayed DRAINING cannot replace newer FROZEN', () => isolated(async redis => {
    const first = tuple();
    await command(redis, 'BOOTSTRAP', first);
    const open = tuple({ ...first, revision: 2, phase: 'OPEN', transitionId: randomUUID() });
    const frozen = tuple({ ...first, revision: 3, transitionId: randomUUID() });
    expect((await command(redis, 'CAS', open, first))[0]).toBe('ACCEPTED');
    expect((await command(redis, 'CAS', frozen, open))[0]).toBe('ACCEPTED');
    expect((await command(redis, 'CAS', open, first))[0]).toBe('STALE_REVISION');
    expect((await command(redis, 'CAS', tuple({ ...open, revision: 4, phase: 'DRAINING', transitionId: randomUUID() }), open))[0]).toBe('STALE_REVISION');
  }));
  it('concurrent physical CAS has one winner; exact crash replay is idempotent', () => isolated(async redis => {
    const first = tuple();
    await command(redis, 'BOOTSTRAP', first);
    const left = tuple({ ...first, revision: 2, phase: 'OPEN', transitionId: randomUUID() });
    const right = tuple({ ...left, transitionId: randomUUID() });
    const replies = await Promise.all([command(redis, 'CAS', left, first), command(redis, 'CAS', right, first)]);
    expect(replies.map(r => r[0]).sort()).toEqual(['ACCEPTED', 'STALE_REVISION']);
    const winner = replies[0][0] === 'ACCEPTED' ? left : right;
    expect((await command(redis, 'CAS', winner, first))[0]).toBe('ACCEPTED');
  }));
  it('restored OPEN is never overwritten by bootstrap', () => isolated(async redis => {
    await redis.set(RESERVATION_FENCE_KEY, JSON.stringify(tuple({ phase: 'OPEN' })));
    expect((await command(redis, 'BOOTSTRAP', tuple()))[0]).toBe('DURABLE_REDIS_DISAGREEMENT');
  }));
});
