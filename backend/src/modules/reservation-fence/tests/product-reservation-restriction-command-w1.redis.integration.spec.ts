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

import { ORDINARY_PHYSICAL_REGISTER, ORDINARY_PHYSICAL_GENESIS, ORDINARY_PHYSICAL_EXECUTE } from '../lua/ordinary-command-physical.lua';
import { OrdinaryPhysicalGrant, OrdinaryPhysicalIdentity, ordinaryPhysicalLedgerKey } from '../types/ordinary-command-physical.types';
import { withOrdinaryReleaseRedis } from './ordinary-provenance-test-helpers';

describe('W3-P command W1 mutation-time restriction', () => {
  jest.setTimeout(120000);
  it.each(['OPEN', 'DRAINING'] as const)('permanent restriction preserves exact W2 %s release and closure', phase => isolated(async outer => {
    // The existing release fixture tracks its resources; additionally retain new
    // product-control keys for failure-safe cleanup even if fixture setup fails.
    await withOrdinaryReleaseRedis(async f => {
      outer.keys.add(productControlKey(f.productId));
      const existingEval = (f.redis.eval as jest.Mock).getMockImplementation() as
        | ((...a: unknown[]) => Promise<unknown>)
        | undefined;
      jest.spyOn(f.redis, 'eval').mockImplementation(async (script: string, keys: string[], args: (string | number)[]) => {
        if (script === PRODUCT_CONTROL_INSTALL && keys[1]) outer.keys.add(keys[1]);
        const result: unknown = existingEval
          ? await existingEval(script, keys, args)
          : await f.client.eval(script, keys.length, ...keys, ...args);
        return result;
      });
      try {
        const restriction = await f.db.productReservationRestriction.create({ data: { productId: f.productId,
          reasonCategory: 'ACCOUNTING_DRIFT', observationDigest: 'a'.repeat(64) } });
        const bytes = controlBytes({ version: 1, productId: f.productId, state: 'RESTRICTED', restrictionId: restriction.id,
          restrictionRevision: 1, incarnation: f.tuple.incarnation, epoch: f.tuple.epoch });
        expect(JSON.parse(String(await f.redis.eval(PRODUCT_CONTROL_INSTALL,
          [RESERVATION_FENCE_KEY, productControlKey(f.productId)], [JSON.stringify(f.tuple), bytes]))))
          .toEqual({ code: 'ACCEPTED', value: bytes });
        expect((await f.physical.executeRelease(f.claim, f.claims)).code).toBe('COMPLETED');
        expect(await f.client.get(f.entry)).toBeNull();
        expect(await f.client.get(f.total)).toBe('0');
        expect((await f.closure.close(f.release.id)).status).toBe('ACKNOWLEDGED');
        const after = await f.snapshot();
        expect((await f.physical.executeRelease(f.claim, f.claims)).code).toBe('REJECTED');
        expect(await f.snapshot()).toEqual(after);
        expect(await f.client.get(productControlKey(f.productId))).toBe(bytes);
      } finally {
        if (existingEval) (f.redis.eval as jest.Mock).mockImplementation(existingEval);
      }
    }, phase);
  }));
  it.each(['RESTRICTED', 'MISSING', 'WRONG_INCARNATION', 'I1_GRANT_I2_FENCE'] as const)('loaded command denied by %s without resource writes', fault => isolated(async f => {
    expect(await f.client.exists('reservation:fence:ordinary-invalidation:GLOBAL', 'reservation:fence:ordinary-invalidation:GLOBAL:initialized')).toBe(0);
    expect((await f.install(f.record('ALLOW'))).code).toBe('ACCEPTED');
    const identity: OrdinaryPhysicalIdentity = { version: 1, commandId: randomUUID(), replayId: randomUUID(),
      action: 'W1', sequence: 1, expectedSequence: 0, mutationVersion: 0, incarnation: f.tuple.incarnation,
      epoch: 1, ownerId: randomUUID(), sourceOwnerId: null, target: f.resource, source: null,
      transition: 'INITIAL', quantity: 2, parent: null };
    const ledger = ordinaryPhysicalLedgerKey(f.resource.markerId); f.keys.add(ledger); f.fields.add(ledger);
    const register = async (purpose: 'GENESIS' | 'EXECUTE') => {
      const grant: OrdinaryPhysicalGrant = { version: 1, grantId: randomUUID(), identity: JSON.stringify(identity),
        tuple: f.tuple, purpose, expiresAt: 0, controlRevision: 0 };
      const keys = [RESERVATION_FENCE_KEY, MUTATION_HISTORY_KEY, ledger, 'reservation:fence:ordinary-command-grant:' + grant.grantId];
      const args = [JSON.stringify(grant)];
      expect((await f.evaluate(ORDINARY_PHYSICAL_REGISTER, keys, args)).code).toBe('REGISTERED');
      return { keys, args };
    };
    const genesis = await register('GENESIS');
    expect((await f.evaluate(ORDINARY_PHYSICAL_GENESIS, genesis.keys, genesis.args)).code).toBe('INITIALIZED');
    const loaded = await register('EXECUTE');
    if (fault === 'RESTRICTED') expect((await f.install(f.record('RESTRICTED'))).code).toBe('ACCEPTED');
    if (fault === 'MISSING') await f.client.del(f.product);
    if (fault === 'WRONG_INCARNATION') await f.client.set(f.product, JSON.stringify({ ...JSON.parse(f.record('ALLOW')), incarnation: randomUUID() }));
    if (fault === 'I1_GRANT_I2_FENCE') {
      const incarnation = randomUUID();
      await f.client.set(RESERVATION_FENCE_KEY, JSON.stringify({ ...f.tuple, incarnation, transitionId: randomUUID() }));
      await f.client.hset(MUTATION_HISTORY_KEY, 'incarnation', incarnation);
      await f.client.set(f.product, JSON.stringify({ ...JSON.parse(f.record('ALLOW')), incarnation }));
    }
    await f.client.del(productSuspectKey(f.resource.productId));
    const before = await f.snapshot(), retained = await f.client.hgetall(ledger);
    expect((await f.evaluate(ORDINARY_PHYSICAL_EXECUTE, loaded.keys, loaded.args)).code).toBe('REJECTED');
    expect(await f.snapshot()).toEqual(before); expect(await f.client.hgetall(ledger)).toEqual(retained);
  }));
});
