import { randomUUID } from 'crypto';
import { OrdinaryCommandDispatchClaimRepository } from '../repositories/ordinary-command-dispatch-claim.repository';
import { OrdinaryDispatchIdentity, OrdinaryPurposePlan } from '../types/ordinary-command-dispatch-claim.types';
import { ORDINARY_PHYSICAL_REGISTER, ORDINARY_PHYSICAL_GENESIS, ORDINARY_PHYSICAL_EXECUTE } from '../lua/ordinary-command-physical.lua';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Redis } from 'ioredis';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { OrdinaryCommandPhysicalService } from '../services/ordinary-command-physical.service';

describe('inactive physical command service boundary', () => {
  const db = new PrismaService();
  const client = new Redis('redis://127.0.0.1:16479/11', { lazyConnect: true });
  const redis = new RedisService(client);
  const service = new OrdinaryCommandPhysicalService(db, redis);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { client.disconnect(); await db.$disconnect(); });
  it.each(['', 'not-a-command', '00000000-0000-0000-0000-000000000000\n'])('rejects invalid command ID %j without Redis', async id => {
    const evalSpy = jest.spyOn(redis, 'eval');
    expect(await Reflect.apply(service.execute.bind(service), service, [id])).toEqual({ code: 'REJECTED' });
    expect(evalSpy).not.toHaveBeenCalled();
  });
  it('is unwired and contains no issuance or PostgreSQL write API', () => {
    const source = readFileSync(resolve(__dirname, '../services/ordinary-command-physical.service.ts'), 'utf8');
    expect(source).not.toMatch(/@Injectable|OrdinaryW1IssuanceService|\.acknowledge\(|\.recordDispatch\(|(?:tx|prisma)\.\w+\.(?:update|create|delete|upsert)/);
    for (const file of ['../reservation-fence.module.ts', '../../inventory/inventory.module.ts'])
      expect(readFileSync(resolve(__dirname, file), 'utf8')).not.toContain('OrdinaryCommandPhysicalService');
    expect(readFileSync(resolve(__dirname, '../lua/ordinary-command-physical.lua.ts'), 'utf8')).toContain('Standalone Redis only');
  });
});

describe('Phase A issuer-backed mutation capabilities', () => {
  const db = new PrismaService();
  const client = new Redis('redis://127.0.0.1:16479', { lazyConnect: true });
  const redis = new RedisService(client);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { client.disconnect(); await db.$disconnect(); });

  function identity(action: 'W1' | 'CANCEL_W1'): OrdinaryDispatchIdentity {
    return { version: 1, commandId: randomUUID(), replayId: randomUUID(), action,
      sequence: 1, expectedSequence: 0, mutationVersion: 0, incarnation: randomUUID(), epoch: 1,
      ownerId: randomUUID(), sourceOwnerId: null,
      target: { customerId: randomUUID(), cartId: randomUUID(), productId: randomUUID(), markerId: randomUUID(),
        generation: 0, holdInstanceId: randomUUID() }, source: null, transition: 'INITIAL', quantity: 2, parent: null };
  }
  async function fixture(plan: OrdinaryPurposePlan, action: 'W1' | 'CANCEL_W1' = 'W1') {
    const value = identity(action), transitionId = randomUUID();
    // Mock confirmed database results, not capability issuance/consumption.
    // Real transaction eligibility is covered by persistence tests.
    const transaction = jest.spyOn(db, '$transaction').mockResolvedValueOnce({ identity: value, dispatchTransitionId: transitionId });
    const issuer = new OrdinaryCommandDispatchClaimRepository(db);
    const claimed = await issuer.claim(value, plan);
    if (claimed.status !== 'FIRST_PHYSICAL_DISPATCH_AUTHORIZED') throw new Error('Missing authentic capability');
    transaction.mockResolvedValue({ identity: JSON.stringify(value), markerId: value.target.markerId,
      tuple: { transitionId, incarnation: value.incarnation, epoch: 1, phase: 'OPEN', protocol: 1, revision: 1 }, binding: null });
    const evaluate = jest.spyOn(redis, 'eval').mockImplementation((script) => {
      if (script === ORDINARY_PHYSICAL_REGISTER) return Promise.resolve(JSON.stringify({ code: 'REGISTERED' }));
      if (script === ORDINARY_PHYSICAL_GENESIS) return Promise.resolve(JSON.stringify({ code: 'INITIALIZED' }));
      if (script === ORDINARY_PHYSICAL_EXECUTE) return Promise.resolve(JSON.stringify({ code: 'COMPLETED', identity: JSON.stringify(value),
        receipt: JSON.stringify({ version: 1, complete: true, identity: JSON.stringify(value) }) }));
      return Promise.reject(new Error('Unexpected mutation'));
    });
    return { service: new OrdinaryCommandPhysicalService(db, redis), issuer, capability: claimed.claim, evaluate, transaction, value };
  }
  it('does not register when the execution authority transaction rejects', async () => {
    const f = await fixture('EXECUTE_ONLY');
    f.transaction.mockRejectedValueOnce(new Error('transaction rejected'));
    const before = f.transaction.mock.calls.length;
    expect(await f.service.execute(f.capability, f.issuer)).toEqual({ code: 'REJECTED' });
    expect(f.transaction.mock.calls.length).toBe(before + 1);
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(await f.service.execute(f.capability, f.issuer)).toEqual({ code: 'REJECTED' });
    expect(f.transaction.mock.calls.length).toBe(before + 1);
  });
  it.each(['W1', 'CANCEL_W1'] as const)('%s rejects command IDs and structural copies before every Redis mutation', async action => {
    const f = await fixture('EXECUTE_ONLY', action);
    for (const forged of [f.value.commandId, {}, { ...f.capability }, structuredClone(f.capability), f.value,
      { commandId: f.value.commandId, purpose: 'EXECUTE', identity: f.value }]) {
      expect(await Reflect.apply(f.service.execute.bind(f.service), f.service, [forged, f.issuer])).toEqual({ code: 'REJECTED' });
      expect(await Reflect.apply(f.service.initialize.bind(f.service), f.service, [forged, f.issuer])).toEqual({ code: 'REJECTED' });
    }
    expect(f.evaluate).not.toHaveBeenCalled();
    expect((await f.service.execute(f.capability, f.issuer)).code).toBe('COMPLETED');
    expect(f.evaluate.mock.calls.map(c => c[0])).toEqual([ORDINARY_PHYSICAL_REGISTER, ORDINARY_PHYSICAL_EXECUTE]);
    f.evaluate.mockClear();
    expect(await f.service.execute(f.capability, f.issuer)).toEqual({ code: 'REJECTED' });
    expect(f.evaluate).not.toHaveBeenCalled();
  });
  it.each(['W1', 'CANCEL_W1'] as const)('%s genesis yields one service/issuer-bound continuation', async action => {
    const f = await fixture('GENESIS_THEN_EXECUTE', action);
    const result = await f.service.initialize(f.capability, f.issuer);
    expect(result.code).toBe('INITIALIZED');
    if (result.code !== 'INITIALIZED') throw new Error('Missing continuation');
    expect(await f.service.initialize(f.capability, f.issuer)).toEqual({ code: 'REJECTED' });
    expect(await f.service.initialize(result.continuation, f.issuer)).toEqual({ code: 'REJECTED' });
    const other = new OrdinaryCommandPhysicalService(db, redis);
    expect(await other.execute(result.continuation, f.issuer)).toEqual({ code: 'REJECTED' });
    expect((await f.service.execute(result.continuation, f.issuer)).code).toBe('COMPLETED');
    f.evaluate.mockClear();
    expect(await f.service.execute(result.continuation, f.issuer)).toEqual({ code: 'REJECTED' });
    expect(f.evaluate).not.toHaveBeenCalled();
  });
  it.each(['REJECTED', 'UNCERTAIN', 'exception', 'invalid', 'other-result'] as const)('%s genesis cannot mint continuation', async outcome => {
    const f = await fixture('GENESIS_THEN_EXECUTE');
    f.evaluate.mockImplementation(script => {
      if (script === ORDINARY_PHYSICAL_REGISTER) return Promise.resolve(JSON.stringify({ code: 'REGISTERED' }));
      if (outcome === 'exception') return Promise.reject(new Error('lost response'));
      if (outcome === 'invalid') return Promise.resolve('{');
      return Promise.resolve(JSON.stringify({ code: outcome === 'other-result' ? 'COMPLETED' : outcome }));
    });
    const result = await f.service.initialize(f.capability, f.issuer);
    expect(result.code).toBe(outcome === 'REJECTED' ? 'REJECTED' : 'UNCERTAIN');
    expect(result).not.toHaveProperty('continuation');
    f.evaluate.mockClear();
    expect(await f.service.initialize(f.capability, f.issuer)).toEqual({ code: 'REJECTED' });
    expect(await f.service.execute(f.capability, f.issuer)).toEqual({ code: 'REJECTED' });
    expect(f.evaluate).not.toHaveBeenCalled();
  });
  it.each(['EXECUTE_ONLY', 'GENESIS_THEN_EXECUTE'] as const)('%s cannot switch purpose', async plan => {
    const f = await fixture(plan);
    const result = plan === 'EXECUTE_ONLY' ? await f.service.initialize(f.capability, f.issuer)
      : await f.service.execute(f.capability, f.issuer);
    expect(result).toEqual({ code: 'REJECTED' });
    expect(f.evaluate).not.toHaveBeenCalled();
  });
  it('wrong issuer and simulated process loss cannot reconstruct admission', async () => {
    const f = await fixture('EXECUTE_ONLY'), fresh = new OrdinaryCommandDispatchClaimRepository(db);
    expect(await f.service.execute(f.capability, fresh)).toEqual({ code: 'REJECTED' });
    expect(await Reflect.apply(f.service.execute.bind(f.service), f.service, [f.value.commandId, fresh])).toEqual({ code: 'REJECTED' });
    expect(f.evaluate).not.toHaveBeenCalled();
    expect((await f.service.execute(f.capability, f.issuer)).code).toBe('COMPLETED');
  });
});
