import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { assertDisposableEnvironment, withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { invalidationHistoryKey, ORDINARY_INVALIDATION_LUA } from '../lua/ordinary-invalidation.lua';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { BarrierAcknowledgement, canonicalInvalidationJson, invalidationRedisKey } from '../types/ordinary-invalidation.types';

describe('isolated monotonic invalidation Redis barrier', () => {
  let client: Redis;
  let previous: string | null;
  const keys = new Set<string>();
  beforeAll(async () => {
    assertDisposableEnvironment();
    if (process.env.REDIS_URL !== 'redis://127.0.0.1:16479/11') throw new Error('Exact disposable Redis DB required');
    client = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
    await client.connect();
    expect(await client.config('GET', 'bind')).toEqual(['bind', '127.0.0.1']);
    expect(await client.config('GET', 'port')).toEqual(['port', '16479']);
    expect(await client.config('GET', 'save')).toEqual(['save', '']);
    expect(await client.config('GET', 'appendonly')).toEqual(['appendonly', 'no']);
    expect(await client.info('server')).toContain('redis_mode:standalone');
    previous = await client.get(RESERVATION_FENCE_KEY);
  });
  afterAll(() => withCleanup(async () => {}, [async () => {
    if (!client || client.status !== 'ready') return;
    if (keys.size) await client.del(...keys);
    if (previous !== undefined) {
      if (previous === null) await client.del(RESERVATION_FENCE_KEY); else await client.set(RESERVATION_FENCE_KEY, previous);
    }
  }]).finally(async () => { if (client?.status === 'ready') await client.quit(); else client?.disconnect(); }));
  async function fixture() {
    const ack: BarrierAcknowledgement = { version: 1, intentId: randomUUID(), digest: 'a'.repeat(64), incarnation: randomUUID(),
      epoch: 1, scopes: [{ scope: `MARKER:${randomUUID()}`, previousRevision: 0, revision: 1 }] };
    const key = invalidationRedisKey(ack.scopes[0]!.scope); keys.add(key); keys.add(invalidationHistoryKey(key));
    await client.set(RESERVATION_FENCE_KEY, JSON.stringify({ incarnation: ack.incarnation, epoch: 1, phase: 'OPEN', protocol: 1, revision: 1, transitionId: randomUUID() }));
    const run = async (a = ack, command = 'INSTALL') => JSON.parse(String(await client.eval(ORDINARY_INVALIDATION_LUA, 2,
      RESERVATION_FENCE_KEY, key, canonicalInvalidationJson(a), command))) as { code: string; acknowledgement?: string };
    return { ack, key, run };
  }
  it('retains no-TTL exact identity; duplicates do not roll back readiness or barriers', async () => {
    const f = await fixture();
    expect((await f.run()).code).toBe('CONFIRMED');
    expect(await client.pttl(f.key)).toBe(-1);
    expect(await client.pttl(invalidationHistoryKey(f.key))).toBe(-1);
    const history = await client.get(invalidationHistoryKey(f.key));
    expect((await f.run(f.ack, 'READY')).code).toBe('CONFIRMED');
    const ready = await client.get(f.key);
    expect((await f.run()).code).toBe('CONFIRMED');
    expect(await client.get(f.key)).toBe(ready);
    const next = { ...f.ack, intentId: randomUUID(), scopes: [{ ...f.ack.scopes[0]!, previousRevision: 1, revision: 2 }] };
    expect((await f.run(next)).code).toBe('CONFIRMED');
    const barrier = await client.get(f.key);
    expect((await f.run()).code).toBe('REJECTED');
    expect((await f.run(f.ack, 'READY')).code).toBe('REJECTED');
    expect(await client.get(f.key)).toBe(barrier);
    expect(await client.get(invalidationHistoryKey(f.key))).toBe(history);
  });
  it.each(['missing', 'malformed', 'expiring'] as const)('rejects %s initialization evidence without changing the retained head', async fault => {
    const f = await fixture(); await f.run();
    const history = invalidationHistoryKey(f.key), before = await client.get(f.key);
    if (fault === 'missing') await client.del(history);
    if (fault === 'malformed') await client.set(history, '{}');
    if (fault === 'expiring') await client.pexpire(history, 60000);
    expect((await f.run()).code).toBe('REJECTED');
    expect((await f.run(f.ack, 'READY')).code).toBe('REJECTED');
    expect(await client.get(f.key)).toBe(before);
  });
  it('rejects conflicting same revision, malformed state and missing non-genesis revision with zero writes', async () => {
    const f = await fixture(); await f.run();
    const before = await client.get(f.key);
    expect((await f.run({ ...f.ack, intentId: randomUUID() })).code).toBe('REJECTED');
    expect(await client.get(f.key)).toBe(before);
    await client.set(f.key, '{}');
    expect((await f.run()).code).toBe('REJECTED'); expect(await client.get(f.key)).toBe('{}');
    await client.del(f.key); // Owned disposable fixture corruption, not a protocol operation.
    expect((await f.run({ ...f.ack, scopes: [{ ...f.ack.scopes[0]!, previousRevision: 1, revision: 2 }] })).code).toBe('REJECTED');
    expect(await client.exists(f.key)).toBe(0);
  });
  it('rejects a stale incarnation without adopting its barrier', async () => {
    const f = await fixture(); await f.run(); const before = await client.get(f.key);
    await client.set(RESERVATION_FENCE_KEY, JSON.stringify({ incarnation: randomUUID(), epoch: 2, phase: 'FROZEN' }));
    expect((await f.run()).code).toBe('REJECTED');
    expect(await client.get(f.key)).toBe(before);
  });
});
