import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { RedisService } from '../../../common/redis/redis.service';
import { assertDisposableEnvironment, withCleanup, latch } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { claimOrdinaryMutation, ordinaryFixture, openOrdinarySchema, acknowledgement } from './ordinary-provenance-test-helpers';
import { OrdinaryCommandPhysicalService } from '../services/ordinary-command-physical.service';
import { OrdinaryPhysicalGrant, ordinaryPhysicalLedgerKey } from '../types/ordinary-command-physical.types';
import { ORDINARY_PHYSICAL_EXECUTE } from '../lua/ordinary-command-physical.lua';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY, resourceGuardKey } from '../lua/reservation-mutation-common.lua';
import { reservationKey, cartIndexKey, productIndexKey, productTotalKey, productSuspectKey } from '../../inventory/constants/inventory.constants';
import { ordinaryHoldInstanceId } from '../ordinary-hold-instance-id';

type MutableJsonObject = Record<string, unknown>;

function parseJsonObject(value: string): MutableJsonObject {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected JSON object');
  }
  return parsed as MutableJsonObject;
}
describe('inactive ordinary command physical protocol: standalone disposable Redis', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>>;
  let client: Redis;
  let redis: RedisService;
  let service: OrdinaryCommandPhysicalService;
  let previousControl: string | null;
  let previousIncarnation: string | null;
  const keys = new Set<string>(), historyFields = new Set<string>();
  const evaluate = (...args: Parameters<RedisService['eval']>) => {
    if (args[1][3]) keys.add(args[1][3]);
    return RedisService.prototype.eval.call(redis, ...args);
  };
  beforeAll(async () => {
    assertDisposableEnvironment();
    schema = await openOrdinarySchema();
    client = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await client.connect();
    previousControl = await client.get(RESERVATION_FENCE_KEY);
    previousIncarnation = await client.hget(MUTATION_HISTORY_KEY, 'incarnation');
    redis = new RedisService(client);
    service = new OrdinaryCommandPhysicalService(schema.db, redis);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => withCleanup(async () => {}, [() => withCleanup(async () => {
    if (!client || client.status !== 'ready') return;
    if (keys.size) await client.del(...keys);
    if (historyFields.size) await client.hdel(MUTATION_HISTORY_KEY, ...historyFields);
    if (previousControl !== undefined) {
      if (previousControl === null) await client.del(RESERVATION_FENCE_KEY); else await client.set(RESERVATION_FENCE_KEY, previousControl);
    }
    if (previousIncarnation !== undefined) {
      if (previousIncarnation === null) await client.hdel(MUTATION_HISTORY_KEY, 'incarnation');
      else await client.hset(MUTATION_HISTORY_KEY, 'incarnation', previousIncarnation);
    }
  }, [async () => { if (client) { if (client.status === 'ready') await client.quit(); else client.disconnect(); } }]),
  async () => { if (schema) await schema.close(); }]));

  async function executionArgs(commandId: string) {
    const admission = await claimOrdinaryMutation(schema.db, commandId, 'EXECUTE_ONLY');
    return [admission.capability, admission.issuer] as const;
  }
  async function fixture(initialize = true) {
    const f = await ordinaryFixture(schema.db);
    const issued = await f.commands.issue(f.issuance, f.payload);
    const command = await f.commands.promote(f.marker.id);
    if (!command) throw new Error('Missing committed pending fixture');
    const tuple = { incarnation: f.transition.incarnation, epoch: 1, revision: f.transition.revision,
      phase: 'OPEN', protocol: 1, transitionId: f.transition.id };
    await client.set(RESERVATION_FENCE_KEY, JSON.stringify(tuple));
    await client.hset(MUTATION_HISTORY_KEY, 'incarnation', tuple.incarnation);
    const ledger = ordinaryPhysicalLedgerKey(f.marker.id), entry = reservationKey(f.cartId, f.productId), guard = resourceGuardKey(f.marker.id);
    const pin = `reservation:fence:checkout-pin:${f.marker.id}`;
    const physical = [entry, guard, ledger, pin, cartIndexKey(f.cartId), productIndexKey(f.productId), productTotalKey(f.productId), productSuspectKey(f.productId)];
    physical.forEach(key => keys.add(key)); historyFields.add(ledger); historyFields.add(guard);
    const original = evaluate;
    jest.spyOn(redis, 'eval').mockImplementation(async (script, scriptKeys, args) => {
      if (scriptKeys[3]) keys.add(scriptKeys[3]);
      return original(script, scriptKeys, args);
    });
    const admission = initialize ? await claimOrdinaryMutation(schema.db, command.id, 'GENESIS_THEN_EXECUTE') : null;
    const initialized = admission ? await service.initialize(admission.capability, admission.issuer) : null;
    if (initialize) expect(initialized?.code).toBe('INITIALIZED');
    const execute = () => {
      if (!admission || initialized?.code !== 'INITIALIZED') throw new Error('Missing fixture continuation');
      return service.execute(initialized.continuation, admission.issuer);
    };
    const snapshot = async () => ({ values: await Promise.all(physical.map(async key => (await client.dumpBuffer(key))?.toString('base64') ?? null)),
      history: await client.hmget(MUTATION_HISTORY_KEY, ledger, guard) });
    const cancel = async () => {
      const row = await f.commands.enqueue(f.marker.id, { ownerId: issued.owner.id, effect: 'CANCEL_W1', reason: 'STALE_W1',
        cancelledCommandId: command.id, intentGeneration: 0, expectedMutationVersion: 0 });
      await f.commands.promote(f.marker.id);
      return row;
    };
    return { ...f, ...issued, command, ledger, entry, guard, pin, tuple, snapshot, cancel, execute };
  }

  it('executes committed INITIAL atomically and exact replay never renews', async () => {
    const f = await fixture();
    let replay: Parameters<RedisService['eval']> | undefined;
    jest.spyOn(redis, 'eval').mockImplementation(async (...args) => {
      if (args[0] === ORDINARY_PHYSICAL_EXECUTE) replay = args;
      return evaluate(...args);
    });
    const result = await f.execute();
    expect(result.code).toBe('COMPLETED');
    const e = parseJsonObject((await client.get(f.entry))!);
    expect(e).toMatchObject({ quantity: 2, holdInstanceId: ordinaryHoldInstanceId(f.marker.id, 0), reservationMutationId: f.command.replayId });
    expect(await client.get(productTotalKey(f.productId))).toBe('2');
    expect(await client.smembers(cartIndexKey(f.cartId))).toEqual([f.productId]);
    expect(await client.smembers(productIndexKey(f.productId))).toEqual([f.cartId]);
    expect(JSON.parse((await client.hget(f.ledger, 'cursor'))!)).toMatchObject({ sequence: 1, commandId: f.command.id });
    const before = await f.snapshot();
    expect(await f.execute()).toEqual({ code: 'REJECTED' });
    expect(await service.observe(f.command.id)).toEqual(result);
    if (!replay || !('receipt' in result)) throw new Error('Missing original script evidence');
    const replayed: unknown = JSON.parse(String(await evaluate(...replay)));
    expect(replayed).toMatchObject({ code: 'COMPLETED', receipt: result.receipt, identity: result.identity });
    expect(await f.snapshot()).toEqual(before);
    expect(await schema.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: f.command.id } })).toMatchObject({ state: 'PENDING', completionReceiptHash: null });
  });
  it('retains lost-response evidence across fresh clients and entry expiry/change', async () => {
    const f = await fixture();
    const original = evaluate;
    jest.spyOn(redis, 'eval').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0] === ORDINARY_PHYSICAL_EXECUTE) throw new Error('response lost');
      return result;
    });
    expect(await f.execute()).toEqual({ code: 'UNCERTAIN' });
    jest.restoreAllMocks();
    await f.commands.recordDispatch(f.marker.id, f.command.id, f.transition.id, true, null);
    await client.pexpire(f.entry, 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await client.get(f.entry)).toBeNull();
    const fresh = schema.fresh();
    try {
      const restarted = new OrdinaryCommandPhysicalService(fresh, redis);
      const observed = await restarted.observe(f.command.id);
      expect(observed.code).toBe('COMPLETED');
      expect(await Reflect.apply(restarted.execute.bind(restarted), restarted, [f.command.id])).toEqual({ code: 'REJECTED' });
      await client.set(f.entry, 'later unrelated live state');
      expect(await restarted.observe(f.command.id)).toEqual(observed);
    } finally { await fresh.$disconnect(); }
  });
  it.each(['missing', 'history-only', 'physical-entry', 'physical-guard'] as const)('genesis fails closed for %s', async fault => {
    const f = await fixture(false);
    if (fault === 'history-only') await client.hset(MUTATION_HISTORY_KEY, f.ledger, '1');
    if (fault === 'physical-entry') await client.set(f.entry, '{}');
    if (fault === 'physical-guard') await client.set(f.guard, '{}');
    const before = await f.snapshot();
    const admission = await claimOrdinaryMutation(schema.db, f.command.id, fault === 'missing' ? 'EXECUTE_ONLY' : 'GENESIS_THEN_EXECUTE');
    expect(await (fault === 'missing' ? service.execute(admission.capability, admission.issuer)
      : service.initialize(admission.capability, admission.issuer))).toEqual({ code: 'REJECTED' });
    expect(await f.snapshot()).toEqual(before);
  });
  it.each(['pin', 'suspect', 'cart-type', 'product-type', 'total-type', 'negative-total', 'overflow-total', 'cart-membership',
    'product-membership', 'cursor-missing', 'cursor-malformed', 'cursor-newer', 'cursor-epoch', 'receipt-malformed'] as const)(
    'rejects %s before physical writes', async fault => {
      const f = await fixture();
      if (fault === 'pin') await client.set(f.pin, 'other checkout');
      if (fault === 'suspect') await client.set(productSuspectKey(f.productId), '1');
      if (fault === 'cart-type') await client.set(cartIndexKey(f.cartId), 'wrong');
      if (fault === 'product-type') await client.set(productIndexKey(f.productId), 'wrong');
      if (fault === 'total-type') await client.sadd(productTotalKey(f.productId), 'wrong');
      if (fault === 'negative-total') await client.set(productTotalKey(f.productId), '-1');
      if (fault === 'overflow-total') await client.set(productTotalKey(f.productId), '9007199254740991');
      if (fault === 'cart-membership') await client.sadd(cartIndexKey(f.cartId), f.productId);
      if (fault === 'product-membership') await client.sadd(productIndexKey(f.productId), f.cartId);
      if (fault === 'cursor-missing') await client.hdel(f.ledger, 'cursor');
      if (fault === 'cursor-malformed') await client.hset(f.ledger, 'cursor', '{}');
      if (fault === 'cursor-newer' || fault === 'cursor-epoch') {
        const c = parseJsonObject((await client.hget(f.ledger, 'cursor'))!);
        if (fault === 'cursor-newer') c.sequence = 10; else c.epoch = 2;
        await client.hset(f.ledger, 'cursor', JSON.stringify(c));
      }
      if (fault === 'receipt-malformed') await client.hset(f.ledger, `receipt:${f.command.id}`, '{}');
      const before = await f.snapshot();
      expect(await f.execute()).toEqual({ code: 'REJECTED' });
      expect(await f.snapshot()).toEqual(before);
    });
  it.each(['SAME_GENERATION', 'IMMEDIATE_PREDECESSOR'] as const)('executes exact %s and denies non-initial genesis', async transition => {
    const f = await fixture();
    expect((await f.execute()).code).toBe('COMPLETED');
    // Fixture advancement only, using the existing inert journal API. The
    // Stage-B service never acknowledges PostgreSQL, even in these tests.
    await f.commands.acknowledge(f.marker.id, acknowledgement(f.command));
    const generation = transition === 'SAME_GENERATION' ? 0 : 1;
    await schema.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation, expectedMutationVersion: 1, expectedQuantity: 3 } });
    const command = transition === 'SAME_GENERATION'
      ? await f.commands.enqueue(f.marker.id, { ...f.payload, ownerId: f.owner.id, sourceOwnerId: f.owner.id,
        effect: 'W1', w1Transition: transition, expectedMutationVersion: 1, authorizedQuantity: 3 })
      : (await f.commands.issue({ ...f.issuance, generation }, { ...f.payload, sourceOwnerId: f.owner.id,
        w1Transition: transition, intentGeneration: generation, expectedMutationVersion: 1, authorizedQuantity: 3 })).command;
    await f.commands.promote(f.marker.id);
    await expect(claimOrdinaryMutation(schema.db, command.id, 'GENESIS_THEN_EXECUTE')).rejects.toThrow();
    expect((await service.execute(...await executionArgs(command.id))).code).toBe('COMPLETED');
    expect(JSON.parse((await client.get(f.entry))!)).toMatchObject({ quantity: 3, generation, holdInstanceId: ordinaryHoldInstanceId(f.marker.id, generation) });
    expect(await client.get(productTotalKey(f.productId))).toBe('3');
    expect((await service.observe(f.command.id)).code).toBe('COMPLETED');
  });
  it.each(['cancel-first', 'execution-first'] as const)('arbitrates delayed issued W1 against %s cancellation', async order => {
    const f = await fixture();
    const reached = latch(), release = latch();
    const original = evaluate;
    jest.spyOn(redis, 'eval').mockImplementation(async (...args) => {
      if (args[0] === ORDINARY_PHYSICAL_EXECUTE) {
        const g = JSON.parse(String(args[2][0])) as OrdinaryPhysicalGrant;
        if (parseJsonObject(g.identity).action === 'W1') { reached.release(); await release.promise; }
      }
      return original(...args);
    });
    const running = f.execute();
    let result: Awaited<typeof running> | undefined;
    try {
      await reached.promise;
      const cancel = await f.cancel();
      if (order === 'execution-first') { release.release(); result = await running; }
      const cancellation = await service.execute(...await executionArgs(cancel.id));
      expect(cancellation.code).toBe(order === 'cancel-first' ? 'COMPLETED' : 'EXECUTION_WON');
      release.release(); result = await running;
      expect(result.code).toBe(order === 'cancel-first' ? 'CANCELLED' : 'COMPLETED');
      expect(await client.get(productTotalKey(f.productId))).toBe(order === 'cancel-first' ? null : '2');
      expect(JSON.parse((await client.hget(f.ledger, 'cursor'))!)).toMatchObject({ sequence: order === 'cancel-first' ? 2 : 1 });
    } finally { release.release(); await running; }
  });
  it('initial cancellation establishes genesis without creating a reservation', async () => {
    const f = await fixture(false);
    const cancel = await f.cancel();
    const admission = await claimOrdinaryMutation(schema.db, cancel.id, 'GENESIS_THEN_EXECUTE');
    const initialized = await service.initialize(admission.capability, admission.issuer);
    expect(initialized.code).toBe('INITIALIZED');
    if (initialized.code !== 'INITIALIZED') throw new Error('Cancellation genesis rejected');
    expect((await service.execute(initialized.continuation, admission.issuer)).code).toBe('COMPLETED');
    expect(await client.get(f.entry)).toBeNull();
  });
  it.each(['commandId', 'replayId', 'ownerId', 'markerId', 'epoch', 'expired'] as const)('grant %s tampering fails without writes', async field => {
    const f = await fixture();
    const original = evaluate;
    jest.spyOn(redis, 'eval').mockImplementation(async (script, scriptKeys, args) => {
      if (script === ORDINARY_PHYSICAL_EXECUTE) {
        const g = JSON.parse(String(args[0])) as OrdinaryPhysicalGrant;
        if (field === 'expired') await client.pexpire(scriptKeys[3]!, 1);
        else {
          const identity = parseJsonObject(g.identity);
          if (field === 'markerId') {
            const target = identity.target;
            if (typeof target !== 'object' || target === null || Array.isArray(target)) {
              throw new Error('Expected grant target object');
            }
            (target as MutableJsonObject).markerId = randomUUID();
          } else {
            identity[field] = field === 'epoch' ? 2 : randomUUID();
          }
          g.identity = JSON.stringify(identity);
        }
        if (field === 'expired') await new Promise(resolve => setTimeout(resolve, 5));
        return original(script, scriptKeys, [JSON.stringify(g)]);
      }
      return original(script, scriptKeys, args);
    });
    const before = await f.snapshot();
    expect(await f.execute()).toEqual({ code: 'REJECTED' });
    expect(await f.snapshot()).toEqual(before);
  });

  it('accepts the legal sequence gap after execution wins cancellation', async () => {
    const f = await fixture();
    expect((await f.execute()).code).toBe('COMPLETED');
    const cancel = await f.cancel();
    expect((await service.execute(...await executionArgs(cancel.id))).code).toBe('EXECUTION_WON');
    await f.commands.acknowledge(f.marker.id, acknowledgement(f.command));
    await schema.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { expectedMutationVersion: 1 } });
    const next = await f.commands.enqueue(f.marker.id, { ...f.payload, effect: 'W1', ownerId: f.owner.id,
      sourceOwnerId: f.owner.id, w1Transition: 'SAME_GENERATION', expectedMutationVersion: 1 });
    expect(await f.commands.promote(f.marker.id)).toMatchObject({ sequence: 3, expectedSequence: 1 });
    expect((await service.execute(...await executionArgs(next.id))).code).toBe('COMPLETED');
    expect(JSON.parse((await client.hget(f.ledger, 'cursor'))!)).toMatchObject({ sequence: 3 });
  });

  it('concurrent preissued W1 and cancellation choose one physical winner', async () => {
    const f = await fixture();
    const reached = latch(), release = latch();
    jest.spyOn(redis, 'eval').mockImplementation(async (...args) => {
      if (args[0] === ORDINARY_PHYSICAL_EXECUTE && parseJsonObject(parseJsonObject(String(args[2][0])).identity as string).action === 'W1') {
        reached.release(); await release.promise;
      }
      return evaluate(...args);
    });
    const running = f.execute();
    try {
      await reached.promise;
      const cancel = await f.cancel();
      const cancellation = service.execute(...await executionArgs(cancel.id));
      release.release();
      const [w, c] = await Promise.all([running, cancellation]);
      expect([['COMPLETED', 'EXECUTION_WON'], ['CANCELLED', 'COMPLETED']]).toContainEqual([w.code, c.code]);
      expect(await client.get(productTotalKey(f.productId))).toBe(w.code === 'COMPLETED' ? '2' : null);
    } finally { release.release(); await running; }
  });

  it('retains identical receipt/hash after its grant expires and after fence restriction', async () => {
    const f = await fixture();
    const result = await f.execute();
    expect(result.code).toBe('COMPLETED');
    for (const key of keys) if (key.startsWith('reservation:fence:ordinary-command-grant:')) await client.pexpire(key, 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    await client.set(RESERVATION_FENCE_KEY, JSON.stringify({ ...f.tuple, phase: 'FROZEN' }));
    expect(await service.observe(f.command.id)).toEqual(result);
    expect(await f.execute()).toEqual({ code: 'REJECTED' });
  });

  it.each(['missing-receipt', 'wrong-command', 'wrong-replay', 'wrong-owner', 'wrong-quantity', 'stale-cursor'] as const)(
    'observation rejects %s without repairing evidence', async fault => {
      const f = await fixture();
      expect((await f.execute()).code).toBe('COMPLETED');
      const receiptKey = `receipt:${f.command.id}`;
      if (fault === 'missing-receipt') await client.hdel(f.ledger, receiptKey);
      else if (fault === 'stale-cursor') {
        const c = parseJsonObject((await client.hget(f.ledger, 'cursor'))!);
        c.sequence = 0; c.commandId = null; c.replayId = null;
        await client.hset(f.ledger, 'cursor', JSON.stringify(c));
      } else {
        const r = parseJsonObject((await client.hget(f.ledger, receiptKey))!);
        const i = parseJsonObject(r.identity as string);
        if (fault === 'wrong-command') i.commandId = randomUUID();
        if (fault === 'wrong-replay') i.replayId = randomUUID();
        if (fault === 'wrong-owner') i.ownerId = randomUUID();
        if (fault === 'wrong-quantity') {
          const result = r.result;
          if (typeof result !== 'object' || result === null || Array.isArray(result)) {
            throw new Error('Expected receipt result object');
          }
          (result as MutableJsonObject).quantity = 999;
        }
        r.identity = JSON.stringify(i);
        await client.hset(f.ledger, receiptKey, JSON.stringify(r));
      }
      const before = await f.snapshot();
      expect(await service.observe(f.command.id)).toEqual({ code: 'REJECTED' });
      expect(await f.snapshot()).toEqual(before);
    });

  it.each(['generation', 'hold', 'guard-incarnation', 'guard-epoch', 'checkout-operation', 'checkout-attempt', 'checkout-key',
    'pin', 'accounting', 'index', 'absolute-expiry'] as const)('replacement rejects contradictory %s with zero writes', async fault => {
    const f = await fixture();
    expect((await f.execute()).code).toBe('COMPLETED');
    await f.commands.acknowledge(f.marker.id, acknowledgement(f.command));
    await schema.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 1, expectedMutationVersion: 1, expectedQuantity: 3 } });
    const next = await f.commands.issue({ ...f.issuance, generation: 1 }, { ...f.payload, sourceOwnerId: f.owner.id,
      w1Transition: 'IMMEDIATE_PREDECESSOR', intentGeneration: 1, expectedMutationVersion: 1, authorizedQuantity: 3 });
    await f.commands.promote(f.marker.id);
    const e = parseJsonObject((await client.get(f.entry))!);
    const guard = parseJsonObject((await client.get(f.guard))!);
    if (fault === 'generation') e.generation = 2;
    if (fault === 'hold') e.holdInstanceId = randomUUID();
    if (fault === 'guard-incarnation') guard.incarnation = randomUUID();
    if (fault === 'guard-epoch') guard.epoch = 2;
    if (fault === 'checkout-operation') e.checkoutOperationId = randomUUID();
    if (fault === 'checkout-attempt') e.checkoutAttemptId = randomUUID();
    if (fault === 'checkout-key') e.checkoutIdempotencyKey = randomUUID();
    if (fault === 'pin') await client.set(f.pin, 'checkout');
    if (fault === 'accounting') await client.set(productTotalKey(f.productId), '1');
    if (fault === 'index') await client.srem(productIndexKey(f.productId), f.cartId);
    if (fault === 'absolute-expiry') e.absoluteExpiresAt = 1;
    await client.set(f.entry, JSON.stringify(e)); await client.set(f.guard, JSON.stringify(guard));
    const before = await f.snapshot();
    expect(await service.execute(...await executionArgs(next.command.id))).toEqual({ code: 'REJECTED' });
    expect(await f.snapshot()).toEqual(before);
  });
});
