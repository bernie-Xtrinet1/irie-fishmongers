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

import { REGISTER_ORDINARY_RESERVATION, WRITE_ORDINARY_RESERVATION } from '../../inventory/lua/ordinary-reservation-lua';
import { OrdinaryReservationAuthorization } from '../types/ordinary-reservation-authorization';

describe('W3-P older W1 mutation-time deny', () => {
  it.each(['RESTRICTED', 'MISSING', 'WRONG_INCARNATION', 'I1_GRANT_I2_FENCE'] as const)('loaded same-quantity renewal denied by %s with zero writes', fault => isolated(async f => {
    expect((await f.install(f.record('ALLOW'))).code).toBe('ACCEPTED');
    const register = async (from: OrdinaryReservationAuthorization['from']) => {
      const a: OrdinaryReservationAuthorization = { version: 1, tuple: f.tuple, from, target: f.resource,
        quantity: 2, requestId: randomUUID(), expiresAt: 1, controlRevision: 0 };
      const keys = [RESERVATION_FENCE_KEY, 'reservation:fence:w1:' + a.requestId];
      const registered = await f.evaluate(REGISTER_ORDINARY_RESERVATION, keys, [JSON.stringify(a)]);
      expect(registered.code).toBe('ACCEPTED');
      return { keys, args: [JSON.stringify(registered.value)] };
    };
    const first = await register(null);
    expect((await f.evaluate(WRITE_ORDINARY_RESERVATION, first.keys, first.args)).code).toBe('ACCEPTED');
    const renewal = await register(f.resource);
    if (fault === 'RESTRICTED') expect((await f.install(f.record('RESTRICTED'))).code).toBe('ACCEPTED');
    if (fault === 'MISSING') await f.client.del(f.product);
    if (fault === 'WRONG_INCARNATION') await f.client.set(f.product, JSON.stringify({ ...JSON.parse(f.record('ALLOW')), incarnation: randomUUID() }));
    if (fault === 'I1_GRANT_I2_FENCE') {
      const incarnation = randomUUID();
      await f.client.set(RESERVATION_FENCE_KEY, JSON.stringify({ ...f.tuple, incarnation, transitionId: randomUUID() }));
      await f.client.hset(MUTATION_HISTORY_KEY, 'incarnation', incarnation);
      await f.client.set(f.product, JSON.stringify({ ...JSON.parse(f.record('ALLOW')), incarnation }));
    }
    // Suspect deletion does not reauthorize W1.
    await f.client.del(productSuspectKey(f.resource.productId));
    const before = await f.snapshot();
    expect((await f.evaluate(WRITE_ORDINARY_RESERVATION, renewal.keys, renewal.args)).code).toBe('FENCE_REJECTED');
    expect(await f.snapshot()).toEqual(before);
  }));
  it('missing control denies new authority before registration', () => isolated(async f => {
    const a: OrdinaryReservationAuthorization = { version: 1, tuple: f.tuple, from: null, target: f.resource,
      quantity: 2, requestId: randomUUID(), expiresAt: 1, controlRevision: 0 };
    const key = 'reservation:fence:w1:' + a.requestId, before = await f.snapshot();
    expect((await f.evaluate(REGISTER_ORDINARY_RESERVATION, [RESERVATION_FENCE_KEY, key], [JSON.stringify(a)])).code).toBe('FENCE_REJECTED');
    expect(await f.client.get(key)).toBeNull(); expect(await f.snapshot()).toEqual(before);
  }));
});
