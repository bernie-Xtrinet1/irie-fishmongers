import { Redis } from 'ioredis';
import { RedisService } from '../../../common/redis/redis.service';
import { assertDisposableEnvironment, withCleanup, latch } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { claimOrdinaryMutation, ordinaryFixture, openOrdinarySchema } from './ordinary-provenance-test-helpers';
import { OrdinaryCommandPhysicalService } from '../services/ordinary-command-physical.service';
import { OrdinaryCommandClosureService } from '../services/ordinary-command-closure.service';
import { ordinaryPhysicalLedgerKey } from '../types/ordinary-command-physical.types';
import { ORDINARY_PHYSICAL_EXECUTE } from '../lua/ordinary-command-physical.lua';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY, resourceGuardKey } from '../lua/reservation-mutation-common.lua';
import { reservationKey, cartIndexKey, productIndexKey, productTotalKey } from '../../inventory/constants/inventory.constants';

describe('closure real retained evidence: disposable standalone Redis', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>>;
  let client: Redis, redis: RedisService, physical: OrdinaryCommandPhysicalService, closure: OrdinaryCommandClosureService;
  let priorControl: string | null | undefined, priorIncarnation: string | null | undefined;
  const keys = new Set<string>(), history = new Set<string>();
  const evaluate = (...args: Parameters<RedisService['eval']>) => {
    if (args[1][3]) keys.add(args[1][3]);
    return RedisService.prototype.eval.call(redis, ...args);
  };
  beforeAll(async () => {
    assertDisposableEnvironment();
    if (process.env.REDIS_URL !== 'redis://127.0.0.1:16479/11') throw new Error('Exact disposable Redis /11 required');
    schema = await openOrdinarySchema();
    client = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await client.connect();
    priorControl = await client.get(RESERVATION_FENCE_KEY);
    priorIncarnation = await client.hget(MUTATION_HISTORY_KEY, 'incarnation');
    redis = new RedisService(client);
    physical = new OrdinaryCommandPhysicalService(schema.db, redis);
    closure = new OrdinaryCommandClosureService(schema.db, physical);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => withCleanup(async () => {}, [() => withCleanup(async () => {
    if (!client || client.status !== 'ready') return;
    if (keys.size) await client.del(...keys);
    if (history.size) await client.hdel(MUTATION_HISTORY_KEY, ...history);
    if (priorControl !== undefined) {
      if (priorControl === null) await client.del(RESERVATION_FENCE_KEY); else await client.set(RESERVATION_FENCE_KEY, priorControl);
    }
    if (priorIncarnation !== undefined) {
      if (priorIncarnation === null) await client.hdel(MUTATION_HISTORY_KEY, 'incarnation');
      else await client.hset(MUTATION_HISTORY_KEY, 'incarnation', priorIncarnation);
    }
  }, [async () => { if (client) { if (client.status === 'ready') await client.quit(); else client.disconnect(); } }]),
  async () => { if (schema) await schema.close(); }]));

  async function executionArgs(commandId: string) {
    const a = await claimOrdinaryMutation(schema.db, commandId, 'EXECUTE_ONLY');
    return [a.capability, a.issuer] as const;
  }
  async function fixture() {
    const f = await ordinaryFixture(schema.db);
    const issued = await f.commands.issue(f.issuance, f.payload);
    const command = await f.commands.promote(f.marker.id);
    if (!command) throw new Error('Missing pending fixture');
    const tuple = { incarnation: f.transition.incarnation, epoch: 1, revision: f.transition.revision,
      phase: 'OPEN', protocol: 1, transitionId: f.transition.id };
    await client.set(RESERVATION_FENCE_KEY, JSON.stringify(tuple));
    await client.hset(MUTATION_HISTORY_KEY, 'incarnation', tuple.incarnation);
    const ledger = ordinaryPhysicalLedgerKey(f.marker.id), entry = reservationKey(f.cartId, f.productId), guard = resourceGuardKey(f.marker.id);
    const owned = [ledger, entry, guard, cartIndexKey(f.cartId), productIndexKey(f.productId), productTotalKey(f.productId)];
    owned.forEach(k => keys.add(k)); history.add(ledger); history.add(guard);
    jest.spyOn(redis, 'eval').mockImplementation(evaluate);
    const admission = await claimOrdinaryMutation(schema.db, command.id, 'GENESIS_THEN_EXECUTE');
    const initialized = await physical.initialize(admission.capability, admission.issuer);
    expect(initialized.code).toBe('INITIALIZED');
    if (initialized.code !== 'INITIALIZED') throw new Error('Fixture initialization rejected');
    const execute = () => physical.execute(initialized.continuation, admission.issuer);
    const snapshot = async () => Promise.all(owned.map(async k => (await client.dumpBuffer(k))?.toString('base64') ?? null));
    const cancel = async () => {
      const row = await f.commands.enqueue(f.marker.id, { ownerId: issued.owner.id, effect: 'CANCEL_W1', reason: 'STALE_W1',
        cancelledCommandId: command.id, intentGeneration: 0, expectedMutationVersion: 0 });
      await f.commands.promote(f.marker.id);
      return row;
    };
    return { ...f, ...issued, command, tuple, ledger, entry, guard, snapshot, cancel, execute };
  }

  it('ACKs exact physical evidence and repeated/concurrent closure never mutates Redis', async () => {
    const f = await fixture();
    expect((await f.execute()).code).toBe('COMPLETED');
    const before = await f.snapshot();
    const execute = jest.spyOn(physical, 'execute'), initialize = jest.spyOn(physical, 'initialize');
    const results = await Promise.all(Array.from({ length: 5 }, () => closure.close(f.command.id)));
    expect(results.every(r => r.status === 'ACKNOWLEDGED')).toBe(true);
    expect(await closure.close(f.command.id)).toEqual(results[0]);
    expect(await f.snapshot()).toEqual(before);
    expect(execute).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled();
    expect(await f.owners.loadAuthority(f.owner.id)).toMatchObject({ state: 'ACTIVE' });
  });

  it('lost response, entry expiry and fresh PostgreSQL/Redis clients reconstruct and close retained evidence', async () => {
    const f = await fixture();
    jest.spyOn(redis, 'eval').mockImplementation(async (...args) => {
      const result = await evaluate(...args);
      if (args[0] === ORDINARY_PHYSICAL_EXECUTE) throw new Error('lost response');
      return result;
    });
    expect(await f.execute()).toEqual({ code: 'UNCERTAIN' });
    jest.restoreAllMocks();
    await client.pexpire(f.entry, 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await client.get(f.entry)).toBeNull();
    const freshDb = schema.fresh();
    const freshRedis = new Redis('redis://127.0.0.1:16479/11', { lazyConnect: true, maxRetriesPerRequest: 1 });
    await withCleanup(async () => {
      await freshRedis.connect();
      const service = new OrdinaryCommandClosureService(freshDb, new OrdinaryCommandPhysicalService(freshDb, new RedisService(freshRedis)));
      const before = await f.snapshot();
      const page = await service.closePage({ limit: 100 });
      expect(page.results.find(r => r.commandId === f.command.id)?.result.status).toBe('ACKNOWLEDGED');
      expect(await f.snapshot()).toEqual(before);
      expect(await client.get(f.entry)).toBeNull();
    }, [() => freshDb.$disconnect(), async () => { if (freshRedis.status === 'ready') await freshRedis.quit(); else freshRedis.disconnect(); }]);
  });

  it.each(['receipt-missing', 'receipt-corrupt', 'cursor-missing', 'history-missing', 'ledger-missing'] as const)(
    '%s remains unresolved without rearm, repair or physical retry', async fault => {
      const f = await fixture();
      expect((await f.execute()).code).toBe('COMPLETED');
      if (fault === 'receipt-missing') await client.hdel(f.ledger, `receipt:${f.command.id}`);
      if (fault === 'receipt-corrupt') await client.hset(f.ledger, `receipt:${f.command.id}`, '{}');
      if (fault === 'cursor-missing') await client.hdel(f.ledger, 'cursor');
      if (fault === 'history-missing') await client.hdel(MUTATION_HISTORY_KEY, f.ledger);
      if (fault === 'ledger-missing') await client.del(f.ledger);
      const before = await f.snapshot();
      const execute = jest.spyOn(physical, 'execute'), initialize = jest.spyOn(physical, 'initialize');
      expect(await closure.close(f.command.id)).toEqual({ status: 'UNRESOLVED' });
      expect(await closure.close(f.command.id)).toEqual({ status: 'UNRESOLVED' });
      expect(await schema.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: f.command.id } }))
        .toMatchObject({ state: 'UNCERTAIN', attemptCount: 1, completionReceiptHash: null });
      expect(await f.snapshot()).toEqual(before);
      expect(execute).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled();
    });

  it('cancellation-first closes its parent and delayed preissued W1 cannot execute or dual-ACK', async () => {
    const f = await fixture();
    const reached = latch(), release = latch();
    jest.spyOn(redis, 'eval').mockImplementation(async (...args) => {
      if (args[0] === ORDINARY_PHYSICAL_EXECUTE) { reached.release(); await release.promise; }
      return evaluate(...args);
    });
    const running = f.execute();
    try {
      await reached.promise;
      const cancellation = await f.cancel();
      jest.spyOn(redis, 'eval').mockImplementation(evaluate);
      expect((await physical.execute(...await executionArgs(cancellation.id))).code).toBe('COMPLETED');
      release.release();
      expect((await running).code).toBe('CANCELLED');
      const before = await f.snapshot();
      const results = await Promise.all([closure.close(f.command.id), closure.close(cancellation.id)]);
      expect(results.every(r => r.status === 'ACKNOWLEDGED' && r.commandId === cancellation.id)).toBe(true);
      expect(await schema.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: f.command.id } })).toMatchObject({ state: 'CANCELLED' });
      expect(await f.owners.loadAuthority(f.owner.id)).toMatchObject({ state: 'ISSUED' });
      expect(await f.snapshot()).toEqual(before);
    } finally { release.release(); await running; }
  });

  it('W1-first closes execution-won and permits the legal sequence gap acknowledgement', async () => {
    const f = await fixture();
    expect((await f.execute()).code).toBe('COMPLETED');
    const cancellation = await f.cancel();
    expect((await physical.execute(...await executionArgs(cancellation.id))).code).toBe('EXECUTION_WON');
    const results = await Promise.all([closure.close(cancellation.id), closure.close(f.command.id)]);
    expect(results.every(r => r.status === 'ACKNOWLEDGED' && r.commandId === f.command.id)).toBe(true);
    expect(await schema.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: cancellation.id } })).toMatchObject({ state: 'REVOKED' });
    await schema.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { expectedMutationVersion: 1 } });
    const next = await f.commands.enqueue(f.marker.id, { ...f.payload, ownerId: f.owner.id, sourceOwnerId: f.owner.id,
      effect: 'W1', w1Transition: 'SAME_GENERATION', expectedMutationVersion: 1 });
    expect(await f.commands.promote(f.marker.id)).toMatchObject({ sequence: 3, expectedSequence: 1 });
    expect((await physical.execute(...await executionArgs(next.id))).code).toBe('COMPLETED');
    expect((await closure.close(next.id)).status).toBe('ACKNOWLEDGED');
    expect(await schema.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } }))
      .toMatchObject({ ordinaryAcknowledgedSequence: 3 });
  });

  it('replacement ACK atomically activates target and supersedes exact predecessor', async () => {
    const f = await fixture();
    expect((await f.execute()).code).toBe('COMPLETED');
    expect((await closure.close(f.command.id)).status).toBe('ACKNOWLEDGED');
    await schema.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 1, expectedMutationVersion: 1, expectedQuantity: 3 } });
    const next = await f.commands.issue({ ...f.issuance, generation: 1 }, { ...f.payload, sourceOwnerId: f.owner.id,
      w1Transition: 'IMMEDIATE_PREDECESSOR', intentGeneration: 1, expectedMutationVersion: 1, authorizedQuantity: 3 });
    await f.commands.promote(f.marker.id);
    expect((await physical.execute(...await executionArgs(next.command.id))).code).toBe('COMPLETED');
    expect((await closure.close(next.command.id)).status).toBe('ACKNOWLEDGED');
    const predecessor = await f.owners.loadAuthority(f.owner.id);
    expect(predecessor.state).toBe('SUPERSEDED');
    expect(predecessor.closedAt).toBeInstanceOf(Date);
    expect(await f.owners.loadAuthority(next.owner.id)).toMatchObject({ state: 'ACTIVE' });
    expect((await closure.close(f.command.id)).status).toBe('ACKNOWLEDGED');
    expect(await f.owners.loadAuthority(f.owner.id)).toMatchObject({ state: 'SUPERSEDED' });
  });
});
