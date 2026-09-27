import { ORDINARY_PHYSICAL_EXECUTE, ORDINARY_PHYSICAL_REGISTER, ORDINARY_PHYSICAL_OBSERVE } from '../lua/ordinary-command-physical.lua';
import { OrdinaryPhysicalGrant, OrdinaryPhysicalIdentity } from '../types/ordinary-command-physical.types';
import { MUTATION_HISTORY_KEY } from '../lua/reservation-mutation-common.lua';
import { ordinaryHoldInstanceId } from '../ordinary-hold-instance-id';
import { randomUUID } from 'crypto';
import { withOrdinaryReleaseRedis } from './ordinary-provenance-test-helpers';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';

function object(raw: string | null): Record<string, unknown> {
  const value: unknown = JSON.parse(raw ?? 'null');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed fixture object');
  return value as Record<string, unknown>;
}

describe('inactive exact RELEASE: standalone Redis', () => {
  jest.setTimeout(120000);
  it('physical duplicate delivery returns the exact retained receipt; application capability replay is denied', () => withOrdinaryReleaseRedis(async f => {
    const evaluator = jest.spyOn(f.redis, 'eval'), original = evaluator.getMockImplementation();
    if (!original) throw new Error('Missing evaluator');
    let duplicateVerified = false;
    evaluator.mockImplementation(async (script, keys, args) => {
      const first = await original(script, keys, args);
      if (script === ORDINARY_PHYSICAL_EXECUTE) {
        expect(object(String(first)).code).toBe('COMPLETED');
        const after = await f.snapshot();
        expect(after.entry).toBeNull(); expect(after.total).toBe('0');
        expect(object(String(await original(script, keys, args)))).toEqual(object(String(first)));
        expect(await f.snapshot()).toEqual(after);
        duplicateVerified = true;
      }
      return first;
    });
    expect((await f.physical.execute(f.release.id)).code).toBe('REJECTED');
    expect((await f.physical.executeRelease(f.claim, f.claims)).code).toBe('COMPLETED');
    expect(await f.client.get(f.entry)).toBeNull();
    expect(await f.client.get(f.total)).toBe('0');
    const first = await f.physical.observe(f.release.id);
    expect(duplicateVerified).toBe(true);
    const before = await f.snapshot();
    expect(await f.physical.observe(f.release.id)).toEqual(first);
    expect((await f.physical.executeRelease(f.claim, f.claims)).code).toBe('REJECTED');
    expect(await f.snapshot()).toEqual(before);
  }));
  it('DRAINING cleanup accepts exact CLOSED publication barriers while W1 remains denied', () => withOrdinaryReleaseRedis(async f => {
    expect(f.drainingOrdinaryChecked).toBe(true);
    expect((await f.physical.executeRelease(f.claim, f.claims)).code).toBe('COMPLETED');
    expect((await f.closure.close(f.release.id)).status).toBe('ACKNOWLEDGED');
    expect(object(await f.client.get(f.markerBarrier)).state).toBe('CLOSED');
  }, 'DRAINING'));
  it('delayed N RELEASE cannot mutate a coherent N+1 produced by the real W1 Lua protocol', () => withOrdinaryReleaseRedis(async f => {
    const evaluator = jest.spyOn(f.redis, 'eval'), original = evaluator.getMockImplementation();
    if (!original) throw new Error('Missing evaluator');
    let successor: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    let history: string | null = null;
    evaluator.mockImplementation(async (script, keys, args) => {
      if (script === ORDINARY_PHYSICAL_EXECUTE) {
        const delayed = JSON.parse(String(args[0])) as OrdinaryPhysicalGrant;
        const old = JSON.parse(delayed.identity) as OrdinaryPhysicalIdentity;
        if (!delayed.barrierBinding) throw new Error('Missing enrolled binding');
        const next: OrdinaryPhysicalIdentity = { ...old, action: 'W1', commandId: randomUUID(), replayId: randomUUID(),
          ownerId: randomUUID(), sourceOwnerId: old.ownerId, source: old.target,
          target: { ...old.target, generation: old.target.generation + 1,
            holdInstanceId: ordinaryHoldInstanceId(old.target.markerId, old.target.generation + 1) },
          sequence: old.sequence + 1, expectedSequence: old.expectedSequence,
          transition: 'IMMEDIATE_PREDECESSOR', quantity: 3, parent: null };
        // Lower-protocol race fixture: real Lua creates all successor structures.
        // This is not a PostgreSQL issuance path or a reconstructed application claim.
        await f.install(f.request, 'READY');
        const grant: OrdinaryPhysicalGrant = { version: 1, grantId: randomUUID(), tuple: f.tuple,
          identity: JSON.stringify(next), purpose: 'EXECUTE', expiresAt: 0,
          barrierBinding: { ...delayed.barrierBinding, commandId: next.commandId, replayId: next.replayId } };
        const nextKeys = [...keys.slice(0, 3), `reservation:fence:ordinary-command-grant:${grant.grantId}`];
        const nextArgs = [JSON.stringify(grant)];
        expect(object(String(await original(ORDINARY_PHYSICAL_REGISTER, nextKeys, nextArgs))).code).toBe('REGISTERED');
        const produced = object(String(await original(ORDINARY_PHYSICAL_EXECUTE, nextKeys, nextArgs)));
        expect(produced.code).toBe('COMPLETED');
        expect(object(String(await original(ORDINARY_PHYSICAL_OBSERVE, nextKeys.slice(0, 3), [grant.identity]))).receipt).toBe(produced.receipt);
        successor = await f.snapshot();
        expect(object(successor.entry)).toMatchObject({ generation: next.target.generation,
          holdInstanceId: next.target.holdInstanceId, quantity: 3, reservationMutationId: next.replayId });
        expect(object(successor.guard)).toMatchObject({ resource: next.target, incarnation: next.incarnation, epoch: next.epoch });
        expect(successor.cart).toContain(f.productId); expect(successor.product).toContain(f.cartId);
        expect(successor.total).toBe('3');
        history = await f.client.hget(MUTATION_HISTORY_KEY, f.guard);
        expect(history).not.toBeNull();
      }
      return original(script, keys, args);
    });
    expect((await f.physical.executeRelease(f.claim, f.claims)).code).toBe('REJECTED');
    expect(successor).toBeDefined();
    expect(await f.snapshot()).toEqual(successor);
    expect(await f.client.hget(MUTATION_HISTORY_KEY, f.guard)).toBe(history);
    expect(await f.client.hget(f.ledger, `receipt:${f.release.id}`)).toBeNull();
  }));
  it.each(['barrier', 'fence', 'owner'])('loaded grant cannot cross later %s at the mutation point', fault => withOrdinaryReleaseRedis(async f => {
    const evaluator = jest.spyOn(f.redis, 'eval');
    const original = evaluator.getMockImplementation();
    if (!original) throw new Error('Missing tracked fixture evaluator');
    let before: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    evaluator.mockImplementation(async (script, keys, args) => {
      if (script === ORDINARY_PHYSICAL_EXECUTE) {
        if (fault === 'barrier') {
          const barrier = object(await f.client.get(f.markerBarrier)); barrier.revision = Number(barrier.revision) + 1;
          await f.client.set(f.markerBarrier, JSON.stringify(barrier));
        } else if (fault === 'fence') await f.client.set(RESERVATION_FENCE_KEY, JSON.stringify({ ...f.tuple, revision: f.tuple.revision + 1 }));
        else {
          const request = object(String(args[0]));
          const identity = object(String(request.identity)); identity.ownerId = randomUUID();
          request.identity = JSON.stringify(identity);
          before = await f.snapshot();
          return original(script, keys, [JSON.stringify(request)]);
        }
        before = await f.snapshot();
      }
      return original(script, keys, args);
    });
    expect((await f.physical.executeRelease(f.claim, f.claims)).code).toBe('REJECTED');
    expect(before).toBeDefined();
    expect(await f.snapshot()).toEqual(before);
  }));
  it.each(['generation', 'hold', 'quantity', 'pin', 'checkout', 'guard', 'cursor', 'absent', 'total',
    'receipt-missing', 'receipt-hash', 'barrier', 'fence', 'incarnation', 'epoch', 'FROZEN', 'RETIRED'])('%s mismatch rejects with zero release writes', fault => withOrdinaryReleaseRedis(async f => {
    const entry = object(await f.client.get(f.entry));
    if (fault === 'generation') entry.generation = Number(entry.generation) + 1;
    if (fault === 'hold') entry.holdInstanceId = randomUUID();
    if (fault === 'quantity') entry.quantity = Number(entry.quantity) + 1;
    if (fault === 'checkout') entry.checkoutAttemptId = randomUUID();
    if (['generation','hold','quantity','checkout'].includes(fault)) await f.client.set(f.entry, JSON.stringify(entry));
    if (fault === 'pin') await f.client.set(f.pin, '{}');
    if (fault === 'guard') await f.client.del(f.guard);
    if (fault === 'cursor') await f.client.hset(f.ledger, 'cursor', '{}');
    if (fault === 'absent') await f.client.del(f.entry);
    if (fault === 'total') await f.client.set(f.total, '1');
    if (fault === 'receipt-missing') await f.client.hdel(f.ledger, `receipt:${f.pending.id}`);
    if (fault === 'receipt-hash') {
      const raw = await f.client.hget(f.ledger, `receipt:${f.pending.id}`);
      if (!raw) throw new Error('Missing ownership receipt');
      // Equivalent JSON with different bytes must fail the durable hash check.
      await f.client.hset(f.ledger, `receipt:${f.pending.id}`, ` ${raw}`);
    }
    if (fault === 'barrier') {
      const barrier = object(await f.client.get(f.markerBarrier)); barrier.revision = Number(barrier.revision) + 1;
      await f.client.set(f.markerBarrier, JSON.stringify(barrier));
    }
    if (['fence','incarnation','epoch','FROZEN','RETIRED'].includes(fault)) await f.client.set(RESERVATION_FENCE_KEY,
      JSON.stringify({ ...f.tuple, ...(fault === 'fence' ? { revision: f.tuple.revision + 1 }
        : fault === 'incarnation' ? { incarnation: randomUUID() } : fault === 'epoch' ? { epoch: 2 } : { phase: fault }) }));
    const before = await f.snapshot();
    expect((await f.physical.executeRelease(f.claim, f.claims)).code).toBe('REJECTED');
    expect(await f.snapshot()).toEqual(before);
    expect((await f.closure.close(f.release.id)).status).toBe('UNRESOLVED');
  }));
});
