import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { RedisService } from '../../../common/redis/redis.service';
import { assertDisposableEnvironment, latch, withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { OrdinaryInvalidationService } from '../services/ordinary-invalidation.service';
import { OrdinaryInvalidationPublicationService } from '../services/ordinary-invalidation-publication.service';
import { OrdinaryCommandPhysicalService } from '../services/ordinary-command-physical.service';
import { OrdinaryCommandClosureService } from '../services/ordinary-command-closure.service';
import { ReservationFenceRepository, transitionTuple } from '../repositories/reservation-fence.repository';
import { barrierAcknowledgement, canonicalInvalidationJson, invalidationDigest, InvalidationRequest, invalidationRedisKey } from '../types/ordinary-invalidation.types';
import { OrdinaryPhysicalGrant, ordinaryPhysicalGrantKey, ordinaryPhysicalLedgerKey } from '../types/ordinary-command-physical.types';
import { ORDINARY_PHYSICAL_REGISTER, ORDINARY_PHYSICAL_GENESIS, ORDINARY_PHYSICAL_EXECUTE } from '../lua/ordinary-command-physical.lua';
import { invalidationHistoryKey, ORDINARY_INVALIDATION_LUA } from '../lua/ordinary-invalidation.lua';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY, resourceGuardKey } from '../lua/reservation-mutation-common.lua';
import { reservationKey, cartIndexKey, productIndexKey, productTotalKey, productSuspectKey } from '../../inventory/constants/inventory.constants';

describe('inactive invalidation: real PostgreSQL/standalone Redis ordering', () => {
  jest.setTimeout(120000);
  async function fixture(work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, promote = true) {
    assertDisposableEnvironment();
    if (process.env.REDIS_URL !== 'redis://127.0.0.1:16479/11') throw new Error('Exact disposable endpoint required');
    const client = new Redis(process.env.REDIS_URL, { lazyConnect: true, retryStrategy: null, maxRetriesPerRequest: 0 });
    const schema = await openOrdinarySchema();
    const keys = new Set<string>(), history = new Set<string>();
    let control: string | null | undefined, global: string | null | undefined, incarnation: string | null | undefined;
    await withCleanup(async () => {
      await client.connect();
      expect(await client.config('GET', 'bind')).toEqual(['bind', '127.0.0.1']);
      expect(await client.config('GET', 'port')).toEqual(['port', '16479']);
      expect(await client.config('GET', 'save')).toEqual(['save', '']);
      expect(await client.config('GET', 'appendonly')).toEqual(['appendonly', 'no']);
      expect(await client.info('server')).toContain('redis_mode:standalone');
      control = await client.get(RESERVATION_FENCE_KEY);
      global = await client.get(invalidationRedisKey('GLOBAL'));
      incarnation = await client.hget(MUTATION_HISTORY_KEY, 'incarnation');
      // Exclusive serial fixture owns the shared control slots until restored.
      // A pre-existing global barrier is never deleted/adopted for a test.
      if (global !== null) throw new Error('Disposable global barrier must be absent');
      if (await client.exists(invalidationHistoryKey(invalidationRedisKey('GLOBAL')))) throw new Error('Disposable global history must be absent');
      keys.add(invalidationHistoryKey(invalidationRedisKey('GLOBAL')));
      await work(await setup(schema, client, keys, history, promote));
    }, [() => withCleanup(async () => {
      jest.restoreAllMocks();
      if (client.status !== 'ready') return;
      if (keys.size) await client.del(...keys);
      if (history.size) await client.hdel(MUTATION_HISTORY_KEY, ...history);
      for (const [key, value] of [[RESERVATION_FENCE_KEY, control], [invalidationRedisKey('GLOBAL'), global]] as const) {
        if (value !== undefined) { if (value === null) await client.del(key); else await client.set(key, value); }
      }
      if (incarnation !== undefined) {
        if (incarnation === null) await client.hdel(MUTATION_HISTORY_KEY, 'incarnation');
        else await client.hset(MUTATION_HISTORY_KEY, 'incarnation', incarnation);
      }
    }, [async () => { if (client.status === 'ready') await client.quit(); else client.disconnect(); }]), () => schema.close()]);
  }

  async function setup(schema: Awaited<ReturnType<typeof openOrdinarySchema>>, client: Redis,
    keys: Set<string>, history: Set<string>, promote: boolean) {
    const f = await ordinaryFixture(schema.db), redis = new RedisService(client);
    const repo = new OrdinaryInvalidationRepository(f.db), service = new OrdinaryInvalidationService(repo, redis);
    const publication = new OrdinaryInvalidationPublicationService(repo), physical = new OrdinaryCommandPhysicalService(f.db, redis);
    const tuple = transitionTuple(f.transition);
    await client.set(RESERVATION_FENCE_KEY, JSON.stringify(tuple));
    await client.hset(MUTATION_HISTORY_KEY, 'incarnation', tuple.incarnation);
    keys.add(invalidationRedisKey(`MARKER:${f.marker.id}`));
    keys.add(invalidationHistoryKey(invalidationRedisKey(`MARKER:${f.marker.id}`)));
    await f.db.ordinaryInvalidationHead.createMany({ data: ['GLOBAL', `MARKER:${f.marker.id}`].map(scope => ({ scope, incarnation: tuple.incarnation, epoch: 1 })) });
    const initial: InvalidationRequest = { version: 1, intentId: randomUUID(), operationId: randomUUID(), kind: 'CART',
      incarnation: tuple.incarnation, epoch: 1, scopes: [
        { kind: 'GLOBAL', revision: 0, before: tuple, after: tuple, modeBefore: { mode: 'CART_SCOPED', revision: f.transition.modeRevision }, modeAfter: null },
        { kind: 'MARKER', revision: 0, markerId: f.marker.id, cartId: f.cartId, customerId: f.customerId, productId: f.productId,
          before: { generation: 0, mutationVersion: 0, quantity: 2 }, after: { generation: 0, mutationVersion: 0, quantity: 2 },
          cartBefore: null, cartAfter: null, ownersBefore: [], ownersAfter: [] },
      ] };
    await service.prepare(initial); await service.reconcile(initial.intentId);
    await publication.publish(initial.intentId, () => Promise.resolve({ bootstrap: true }));
    await service.reconcileReadiness(initial.intentId);
    const issued = await f.commands.issue(f.issuance, f.payload), command = promote ? await f.commands.promote(f.marker.id) : issued.command;
    if (!command) throw new Error('Missing command');
    const ledger = ordinaryPhysicalLedgerKey(f.marker.id), guard = resourceGuardKey(f.marker.id);
    const physicalKeys = [ledger, guard, reservationKey(f.cartId, f.productId), cartIndexKey(f.cartId),
      productIndexKey(f.productId), productTotalKey(f.productId), productSuspectKey(f.productId), `reservation:fence:checkout-pin:${f.marker.id}`];
    physicalKeys.forEach(key => keys.add(key)); history.add(ledger); history.add(guard);
    const evaluate = (...args: Parameters<RedisService['eval']>) => {
      if (args[0] !== ORDINARY_INVALIDATION_LUA && args[1][3]) keys.add(args[1][3]);
      return RedisService.prototype.eval.call(redis, ...args);
    };
    jest.spyOn(redis, 'eval').mockImplementation(evaluate);
    const request: InvalidationRequest = { ...initial, intentId: randomUUID(), operationId: randomUUID(),
      scopes: initial.scopes.filter(scope => scope.kind === 'MARKER').map(scope => ({ ...scope, revision: 1,
        ownersBefore: [{ id: issued.owner.id, state: issued.owner.state }], ownersAfter: [{ id: issued.owner.id, state: issued.owner.state }] })) };
    const invalidate = async () => { await service.prepare(request); return service.reconcile(request.intentId); };
    const snapshot = async () => ({ values: await Promise.all(physicalKeys.map(async key => (await client.dumpBuffer(key))?.toString('base64') ?? null)),
      history: await client.hmget(MUTATION_HISTORY_KEY, ledger, guard) });
    const cancel = async () => {
      const row = await f.commands.enqueue(f.marker.id, { ownerId: issued.owner.id, effect: 'CANCEL_W1', reason: 'STALE_W1',
        cancelledCommandId: command.id, intentGeneration: 0, expectedMutationVersion: 0 });
      await f.commands.promote(f.marker.id); return row;
    };
    return { ...f, schema, client, redis, repo, service, publication, physical, command, request, initial, ledger,
      invalidate, snapshot, evaluate, cancel };
  }

  it.each(['REGISTER', 'GENESIS', 'EXECUTE'] as const)('delayed %s really arrives after timeout/barrier and makes zero physical writes', purpose => fixture(async f => {
    if (purpose === 'EXECUTE') expect(await f.physical.initialize(f.command.id)).toEqual({ code: 'INITIALIZED' });
    const reached = latch(), release = latch();
    const script = purpose === 'REGISTER' ? ORDINARY_PHYSICAL_REGISTER : purpose === 'GENESIS' ? ORDINARY_PHYSICAL_GENESIS : ORDINARY_PHYSICAL_EXECUTE;
    let delivery: Promise<unknown> | undefined;
    jest.spyOn(f.redis, 'eval').mockImplementation(async (...args) => {
      if (args[0] !== script) return f.evaluate(...args);
      delivery = (async () => { reached.release(); await release.promise; return f.evaluate(...args); })();
      // Client loses its response; the independent submitted request stays alive.
      throw new Error('SIMULATED_CLIENT_TIMEOUT');
    });
    try {
      const result = purpose === 'EXECUTE' ? f.physical.execute(f.command.id) : f.physical.initialize(f.command.id);
      await reached.promise;
      expect(await result).toEqual({ code: 'UNCERTAIN' });
      await f.invalidate(); const before = await f.snapshot();
      release.release();
      expect(JSON.parse(String(await delivery))).toEqual({ code: 'REJECTED' });
      expect(await f.snapshot()).toEqual(before);
    } finally { release.release(); await delivery; }
  }));

  it('lost head rejects original INSTALL and READY packets and delayed revision-one EXECUTE with zero writes', () => fixture(async f => {
    expect(await f.physical.initialize(f.command.id)).toEqual({ code: 'INITIALIZED' });
    const reached = latch(), release = latch();
    let delivery: Promise<unknown> | undefined;
    let grantKey: string | undefined;
    jest.spyOn(f.redis, 'eval').mockImplementation(async (...args) => {
      if (args[0] !== ORDINARY_PHYSICAL_EXECUTE) return f.evaluate(...args);
      grantKey = args[1][3];
      delivery = (async () => { reached.release(); await release.promise; return f.evaluate(...args); })();
      throw new Error('SIMULATED_CLIENT_TIMEOUT');
    });
    try {
      const execution = f.physical.execute(f.command.id);
      await reached.promise; expect(await execution).toEqual({ code: 'UNCERTAIN' });
      const key = invalidationRedisKey(`MARKER:${f.marker.id}`), historyKey = invalidationHistoryKey(key);
      const retained = await f.client.get(historyKey);
      expect(retained).not.toBeNull();
      await f.invalidate();
      expect(JSON.parse((await f.client.get(key))!)).toMatchObject({ revision: 2 });
      await f.client.del(key); // Explicit loss injection of this fixture's head only.
      const before = await f.snapshot();
      const ack = canonicalInvalidationJson(barrierAcknowledgement(f.initial));
      for (const command of ['INSTALL', 'READY']) {
        expect(JSON.parse(String(await f.evaluate(ORDINARY_INVALIDATION_LUA,
          [RESERVATION_FENCE_KEY, invalidationRedisKey('GLOBAL'), key], [ack, command])))).toEqual({ code: 'REJECTED' });
      }
      expect(await f.client.exists(key)).toBe(0);
      expect(await f.client.get(historyKey)).toBe(retained);
      expect(await f.client.pttl(historyKey)).toBe(-1);
      if (!grantKey) throw new Error('Missing submitted execution grant');
      expect(await f.client.pttl(grantKey)).toBeGreaterThan(0);
      release.release();
      expect(JSON.parse(String(await delivery))).toEqual({ code: 'REJECTED' });
      // Rejection must not be explained by expiry of the otherwise valid grant.
      expect(await f.client.pttl(grantKey)).toBeGreaterThan(0);
      expect(await f.snapshot()).toEqual(before);
    } finally { release.release(); await delivery; }
  }));

  it('retains command binding, rejects rebinding, and closes valid pre-barrier completion after process loss', () => fixture(async f => {
    const binding = await f.db.ordinaryCommandBarrierBinding.findUniqueOrThrow({ where: { commandId: f.command.id } });
    expect(binding).toMatchObject({ globalRevision: 1, markerRevision: 1 });
    await expect(f.db.ordinaryCommandBarrierBinding.update({ where: { commandId: f.command.id }, data: { markerRevision: 2 } })).rejects.toThrow();
    expect(await f.physical.initialize(f.command.id)).toEqual({ code: 'INITIALIZED' });
    expect((await f.physical.execute(f.command.id)).code).toBe('COMPLETED');
    await f.invalidate();
    const before = await f.snapshot();
    const fresh = f.schema.fresh();
    try {
      const observer = new OrdinaryCommandPhysicalService(fresh, f.redis);
      expect(await observer.execute(f.command.id)).toEqual({ code: 'REJECTED' });
      expect(await new OrdinaryCommandClosureService(fresh, observer).close(f.command.id))
        .toMatchObject({ status: 'ACKNOWLEDGED', historical: true });
      expect(await f.snapshot()).toEqual(before);
      expect(await f.db.ordinaryCommandBarrierBinding.findUniqueOrThrow({ where: { commandId: f.command.id } })).toEqual(binding);
    } finally { await fresh.$disconnect(); }
  }));

  it('an unbound grant cannot ignore global rejection when its marker barrier is missing', () => fixture(async f => {
    let registered: OrdinaryPhysicalGrant | undefined;
    jest.spyOn(f.redis, 'eval').mockImplementation(async (...args) => {
      if (args[0] === ORDINARY_PHYSICAL_REGISTER) {
        const payload = args[2][0];
        if (typeof payload !== 'string') throw new Error('Expected serialized grant');
        registered = JSON.parse(payload) as OrdinaryPhysicalGrant;
      }
      return f.evaluate(...args);
    });
    expect(await f.physical.initialize(f.command.id)).toEqual({ code: 'INITIALIZED' });
    if (!registered) throw new Error('Missing captured grant');
    const unbound = { ...registered, grantId: randomUUID() };
    delete unbound.barrierBinding;
    await f.client.del(invalidationRedisKey(`MARKER:${f.marker.id}`)); // Owned fixture evidence-loss injection.
    const before = await f.snapshot(), key = ordinaryPhysicalGrantKey(unbound.grantId);
    expect(JSON.parse(String(await f.evaluate(ORDINARY_PHYSICAL_REGISTER,
      [RESERVATION_FENCE_KEY, MUTATION_HISTORY_KEY, f.ledger, key], [JSON.stringify(unbound)])))).toEqual({ code: 'REJECTED' });
    expect(await f.client.exists(key)).toBe(0);
    expect(await f.snapshot()).toEqual(before);
  }));

  it.each(['missing', 'corrupt'] as const)('%s completion evidence never becomes acknowledgement', fault => fixture(async f => {
    expect(await f.physical.initialize(f.command.id)).toEqual({ code: 'INITIALIZED' });
    if (fault === 'corrupt') await f.client.hset(f.ledger, `receipt:${f.command.id}`, '{}');
    await f.invalidate();
    expect(await new OrdinaryCommandClosureService(f.db, f.physical).close(f.command.id)).toEqual({ status: 'UNRESOLVED' });
    expect(await f.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: f.command.id } })).not.toMatchObject({ state: 'ACKNOWLEDGED' });
  }));

  it.each(['W1', 'CANCEL'] as const)('preserves %s first-winner evidence independently of invalidation', winner => fixture(async f => {
    expect(await f.physical.initialize(f.command.id)).toEqual({ code: 'INITIALIZED' });
    if (winner === 'W1') expect((await f.physical.execute(f.command.id)).code).toBe('COMPLETED');
    const cancellation = await f.cancel();
    const result = await f.physical.execute(cancellation.id);
    expect(result.code).toBe(winner === 'W1' ? 'EXECUTION_WON' : 'COMPLETED');
    if (!('receipt' in result)) throw new Error('Missing winner receipt');
    expect(JSON.parse(result.receipt)).toMatchObject(winner === 'W1'
      ? { action: 'W1', complete: true } : { action: 'CANCEL_W1', result: 'CANCELLED', complete: true });
    await f.invalidate();
    const before = await f.snapshot();
    expect(await new OrdinaryCommandClosureService(f.db, f.physical).close(cancellation.id)).toMatchObject({ status: 'ACKNOWLEDGED', historical: true });
    expect(await f.snapshot()).toEqual(before);
  }));

  it('recovers lost Redis response and fresh PREPARED/confirmed/published services without reallocating', () => fixture(async f => {
    const prepare = f.repo.prepare.bind(f.repo);
    jest.spyOn(f.repo, 'prepare').mockImplementationOnce(async request => { await prepare(request); throw new Error('PREPARE_COMMIT_RESPONSE_LOST'); });
    expect((await f.service.prepare(f.request)).status).toBe('PREPARED');
    jest.spyOn(f.redis, 'eval').mockImplementation(async (...args) => {
      const result = await f.evaluate(...args);
      if (args[0] === ORDINARY_INVALIDATION_LUA) throw new Error('REDIS_RESPONSE_LOST');
      return result;
    });
    await expect(f.service.reconcile(f.request.intentId)).rejects.toThrow('REDIS_RESPONSE_LOST');
    expect((await f.repo.read(f.request.intentId))?.status).toBe('PREPARED');
    jest.spyOn(f.redis, 'eval').mockImplementation(f.evaluate);
    const confirmation = jest.spyOn(f.repo, 'confirm').mockImplementationOnce(async request => f.db.$transaction(async tx => {
      const ack = barrierAcknowledgement(request);
      await tx.ordinaryInvalidationIntent.update({ where: { id: request.intentId }, data: { status: 'BARRIER_CONFIRMED',
        acknowledgement: canonicalInvalidationJson(ack), acknowledgementHash: invalidationDigest(ack) } });
      throw new Error('CONFIRMATION_ROLLBACK');
    }));
    await expect(f.service.reconcile(f.request.intentId)).rejects.toThrow('CONFIRMATION_ROLLBACK');
    expect((await f.repo.read(f.request.intentId))?.status).toBe('PREPARED');
    confirmation.mockRestore();
    const fresh = f.schema.fresh();
    try {
      const repo = new OrdinaryInvalidationRepository(fresh), restarted = new OrdinaryInvalidationService(repo, f.redis);
      const confirm = repo.confirm.bind(repo);
      jest.spyOn(repo, 'confirm').mockImplementationOnce(async (...args) => { await confirm(...args); throw new Error('ACK_COMMIT_RESPONSE_LOST'); });
      expect((await restarted.reconcile(f.request.intentId)).status).toBe('BARRIER_CONFIRMED');
      const publish = new OrdinaryInvalidationPublicationService(repo);
      await expect(publish.publish(f.request.intentId, () => Promise.reject(new Error('ROLLBACK')))).rejects.toThrow('ROLLBACK');
      expect((await repo.read(f.request.intentId))?.status).toBe('BARRIER_CONFIRMED');
      await publish.publish(f.request.intentId, () => Promise.resolve({ result: 'retained' }));
      expect(await repo.discover(10)).toContainEqual({ id: f.request.intentId, status: 'PUBLISHED' });
      await restarted.reconcileReadiness(f.request.intentId);
      await restarted.reconcileReadiness(f.request.intentId);
      expect(await fresh.ordinaryInvalidationHead.findUniqueOrThrow({ where: { scope: `MARKER:${f.marker.id}` } }))
        .toMatchObject({ publishedRevision: 2, allocatedRevision: 2, ready: true });
      expect(await f.physical.execute(f.command.id)).toEqual({ code: 'REJECTED' });
    } finally { await fresh.$disconnect(); }
  }));

  it('supersession advances the installed barrier and cannot revive old readiness or authority', () => fixture(async f => {
    await f.service.prepare(f.request);
    const replacement: InvalidationRequest = { ...f.request, intentId: randomUUID(), operationId: randomUUID(),
      scopes: f.request.scopes.map(scope => ({ ...scope, revision: 2 })) };
    await f.service.supersede(f.request.intentId, replacement);
    expect((await f.repo.read(f.request.intentId))?.status).toBe('SUPERSEDED');
    await f.service.reconcile(replacement.intentId);
    await expect(f.publication.publish(f.request.intentId, () => Promise.resolve({ invalid: true }))).rejects.toThrow();
    await f.publication.publish(replacement.intentId, () => Promise.resolve({ replacement: true }));
    await f.service.reconcileReadiness(replacement.intentId);
    await expect(f.service.reconcileReadiness(f.initial.intentId)).rejects.toThrow('READINESS_SUPERSEDED');
    expect(await f.physical.execute(f.command.id)).toEqual({ code: 'REJECTED' });
  }));

  it('publishes a restrictive fence only after its global barrier; old physical authority cannot execute', () => fixture(async f => {
    const before = transitionTuple(f.transition), id = randomUUID();
    const after = { ...before, transitionId: id, revision: before.revision + 1, phase: 'DRAINING' as const };
    const request: InvalidationRequest = { ...f.request, kind: 'FENCE', scopes: [{ kind: 'GLOBAL', revision: 1,
      before, after, modeBefore: { mode: 'CART_SCOPED', revision: f.transition.modeRevision }, modeAfter: null }] };
    await f.service.prepare(request);
    await expect(f.publication.publish(request.intentId, () => Promise.resolve({ invalid: true }))).rejects.toThrow();
    await f.service.reconcile(request.intentId);
    await f.publication.publish(request.intentId, async tx => {
      const row = await new ReservationFenceRepository(f.db).insert(tx, { id, incarnation: after.incarnation,
        epoch: after.epoch, revision: after.revision, phase: 'DRAINING', protocol: 1, predecessor: { ...before },
        mode: 'CART_SCOPED', modeRevision: f.transition.modeRevision, reason: 'RESTRICT', actorId: randomUUID() });
      return { transitionId: row.id };
    });
    expect(await f.physical.execute(f.command.id)).toEqual({ code: 'REJECTED' });
    expect((await f.repo.read(request.intentId))?.status).toBe('PUBLISHED');
  }));

  it('database publication primitive preserves never-dispatched owner revocation lifecycle guards', () => fixture(async f => {
    const request: InvalidationRequest = { ...f.request, kind: 'OWNER', scopes: f.request.scopes.map(scope => {
      if (scope.kind !== 'MARKER') throw new Error('Expected marker');
      return { ...scope, ownersAfter: scope.ownersBefore.map(owner => ({ ...owner, state: 'REVOKED' as const })) };
    }) };
    await f.service.prepare(request); await f.service.reconcile(request.intentId);
    const ownerId = f.command.ownerId;
    await expect(f.db.ordinaryReservationOwner.update({ where: { id: ownerId }, data: { state: 'REVOKED', closedAt: new Date() } })).rejects.toThrow();
    // Tests the inactive transaction primitive and existing deferred lifecycle
    // guards, not integration of the production owner repository caller.
    await f.publication.publish(request.intentId, async tx => {
      await tx.ordinaryReservationCommand.update({ where: { id: f.command.id }, data: { state: 'REVOKED' } });
      await tx.ordinaryReservationOwner.update({ where: { id: ownerId }, data: { state: 'REVOKED', closedAt: new Date() } });
      return { ownerId };
    });
    expect(await f.db.ordinaryReservationOwner.findUniqueOrThrow({ where: { id: ownerId } })).toMatchObject({ state: 'REVOKED' });
    expect(await f.physical.execute(f.command.id)).toEqual({ code: 'REJECTED' });
  }, false));
});
