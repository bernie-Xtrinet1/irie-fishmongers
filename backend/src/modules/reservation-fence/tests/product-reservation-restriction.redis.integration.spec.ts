import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY, resourceGuardKey } from '../lua/reservation-mutation-common.lua';
import { PRODUCT_CONTROL_INSTALL } from '../lua/product-reservation-restriction.lua';
import { controlBytes, productControlKey } from '../types/product-reservation-restriction.types';
import { FenceTuple } from '../types/reservation-fence.types';
import { ordinaryHoldInstanceId } from '../ordinary-hold-instance-id';
import { reservationKey, cartIndexKey, productIndexKey, productTotalKey, productSuspectKey } from '../../inventory/constants/inventory.constants';

async function isolated(work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  if (process.env.REDIS_URL !== 'redis://127.0.0.1:16479/11') throw new Error('Exact disposable Redis required');
  const client = new Redis(process.env.REDIS_URL, { lazyConnect: true, retryStrategy: null, maxRetriesPerRequest: 0 });
  const keys = new Set<string>(), fields = new Set<string>(), failures: unknown[] = [];
  let previous: string | null | undefined, incarnation: string | null | undefined;
  try {
    await client.connect();
    for (const [key, value] of [['bind', '127.0.0.1'], ['port', '16479'], ['save', ''], ['appendonly', 'no'], ['daemonize', 'no']])
      expect(await client.config('GET', key!)).toEqual([key, value]);
    expect(await client.info('server')).toContain('redis_mode:standalone');
    previous = await client.get(RESERVATION_FENCE_KEY);
    incarnation = await client.hget(MUTATION_HISTORY_KEY, 'incarnation');
    await work(await setup(client, keys, fields));
  } catch (error) { failures.push(error); }
  finally {
    try {
      if (client.status === 'ready') {
        if (keys.size) await client.del(...keys);
        if (fields.size) await client.hdel(MUTATION_HISTORY_KEY, ...fields);
        if (previous !== undefined) {
          if (previous === null) await client.del(RESERVATION_FENCE_KEY); else await client.set(RESERVATION_FENCE_KEY, previous);
        }
        if (incarnation !== undefined) {
          if (incarnation === null) await client.hdel(MUTATION_HISTORY_KEY, 'incarnation');
          else await client.hset(MUTATION_HISTORY_KEY, 'incarnation', incarnation);
        }
      }
    } catch (error) { failures.push(error); }
    try { if (client.status === 'ready') await client.quit(); else client.disconnect(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'W3-P disposable fixture failed');
}
async function setup(client: Redis, keys: Set<string>, fields: Set<string>) {
  const markerId = randomUUID(), productId = randomUUID(), cartId = randomUUID(), customerId = randomUUID();
  const tuple: FenceTuple = { incarnation: randomUUID(), epoch: 1, revision: 1, phase: 'OPEN', protocol: 1, transitionId: randomUUID() };
  const resource = { markerId, productId, cartId, customerId, generation: 0, holdInstanceId: ordinaryHoldInstanceId(markerId, 0) };
  const product = productControlKey(productId);
  const physical = [reservationKey(cartId, productId), resourceGuardKey(markerId), cartIndexKey(cartId),
    productIndexKey(productId), productTotalKey(productId), productSuspectKey(productId), 'reservation:fence:checkout-pin:' + markerId];
  physical.forEach(key => keys.add(key)); keys.add(product); fields.add(resourceGuardKey(markerId));
  await client.set(RESERVATION_FENCE_KEY, JSON.stringify(tuple));
  await client.hset(MUTATION_HISTORY_KEY, 'incarnation', tuple.incarnation);
  const evaluate = async (script: string, ks: string[], args: string[]) => {
    ks.filter(k => k !== RESERVATION_FENCE_KEY && k !== MUTATION_HISTORY_KEY).forEach(k => keys.add(k));
    const raw = await client.eval(script, ks.length, ...ks, ...args);
    if (typeof raw !== 'string') throw new Error('Expected protocol result');
    return JSON.parse(raw) as Record<string, unknown>;
  };
  const record = (state: 'ALLOW' | 'RESTRICTED', id = randomUUID()) => controlBytes({ version: 1, productId,
    state, restrictionId: state === 'ALLOW' ? null : id, restrictionRevision: state === 'ALLOW' ? 0 : 1,
    incarnation: tuple.incarnation, epoch: tuple.epoch });
  const install = (bytes: string) => evaluate(PRODUCT_CONTROL_INSTALL, [RESERVATION_FENCE_KEY, product], [JSON.stringify(tuple), bytes]);
  const snapshot = async () => ({ values: await Promise.all(physical.map(async key => (await client.dumpBuffer(key))?.toString('base64') ?? null)),
    history: await client.hget(MUTATION_HISTORY_KEY, resourceGuardKey(markerId)) });
  return { client, tuple, resource, product, physical, evaluate, record, install, snapshot, keys, fields };
}

describe('W3-P exact physical restriction installation', () => {
  it('installs from absent, duplicates exactly, and never touches reservation accounting', () => isolated(async f => {
    const before = await f.snapshot(), bytes = f.record('RESTRICTED');
    expect(await f.install(bytes)).toEqual({ code: 'ACCEPTED', value: bytes });
    expect(await f.install(bytes)).toEqual({ code: 'ACCEPTED', value: bytes });
    expect(await f.client.pttl(f.product)).toBe(-1);
    expect(await f.snapshot()).toEqual(before);
    expect((await f.install(f.record('RESTRICTED'))).code).toBe('FENCE_REJECTED');
    expect((await f.install(f.record('ALLOW'))).code).toBe('FENCE_REJECTED');
    expect(await f.client.get(f.product)).toBe(bytes);
  }));
  it('restricts valid ALLOW without changing physical resources', () => isolated(async f => {
    expect((await f.install(f.record('ALLOW'))).code).toBe('ACCEPTED');
    const before = await f.snapshot();
    expect((await f.install(f.record('RESTRICTED'))).code).toBe('ACCEPTED');
    expect(await f.snapshot()).toEqual(before);
  }));
  it.each(['malformed', 'wrong-incarnation', 'ttl', 'missing-history'])('fails closed for %s', fault => isolated(async f => {
    const bytes = f.record('RESTRICTED');
    if (fault === 'malformed') await f.client.set(f.product, '{');
    if (fault === 'wrong-incarnation') await f.client.set(f.product, JSON.stringify({ ...JSON.parse(bytes), incarnation: randomUUID() }));
    if (fault === 'ttl') await f.client.set(f.product, bytes, 'PX', 30000);
    if (fault === 'missing-history') await f.client.hdel(MUTATION_HISTORY_KEY, 'incarnation');
    const before = await f.snapshot(), control = await f.client.get(f.product);
    expect((await f.install(bytes)).code).toBe('FENCE_REJECTED');
    expect(await f.client.get(f.product)).toBe(control);
    expect(await f.snapshot()).toEqual(before);
  }));
});
