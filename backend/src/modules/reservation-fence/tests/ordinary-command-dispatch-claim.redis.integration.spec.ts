import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { OrdinaryCommandDispatchClaimRepository } from '../repositories/ordinary-command-dispatch-claim.repository';
import { OrdinaryDispatchIdentity } from '../types/ordinary-command-dispatch-claim.types';
import { ordinaryFixture, openOrdinarySchema } from './ordinary-provenance-test-helpers';

// No initialization, execution, closure, SET, DEL, scan or flush. The Redis
// endpoint is only inspected. Missing/corrupt evidence is deliberately not an
// input to the PG claim primitive and cannot reopen consumed authorization.
describe('claim consumption across restart with disposable Redis observation only', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>>;
  let client: Redis;
  beforeAll(async () => {
    if (process.env.REDIS_URL !== 'redis://127.0.0.1:16479/11') throw new Error('Exact disposable Redis endpoint required');
    client = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await client.connect();
    expect(await client.config('GET', 'port')).toEqual(['port', '16479']);
    const binding = await client.config('GET', 'bind');
    expect(binding).toEqual(['bind', '127.0.0.1']);
    expect(await client.config('GET', 'save')).toEqual(['save', '']);
    expect(await client.config('GET', 'appendonly')).toEqual(['appendonly', 'no']);
    expect(await client.info('cluster')).toContain('cluster_enabled:0');
    schema = await openOrdinarySchema();
  });
  afterAll(async () => {
    const outcomes = await Promise.allSettled([
      (async () => { if (schema) await schema.close(); })(),
      (async () => { if (client?.status === 'ready') await client.quit(); else client?.disconnect(); })(),
    ]);
    if (outcomes.some(result => result.status === 'rejected')) throw new Error('Claim fixture cleanup failed');
  });
  it.each(['missing', 'corrupt'] as const)('%s evidence cannot authorize restart submission', async kind => {
    const f = await ordinaryFixture(schema.db);
    const issued = await f.commands.issue(f.issuance, f.payload);
    const command = await f.commands.promote(f.marker.id);
    if (!command) throw new Error('Missing fixture command');
    const identity: OrdinaryDispatchIdentity = { version: 1, commandId: command.id, replayId: command.replayId,
      action: 'W1', sequence: command.sequence!, expectedSequence: command.expectedSequence!, mutationVersion: 0,
      incarnation: issued.owner.incarnation, epoch: 1, ownerId: issued.owner.id, sourceOwnerId: null,
      target: { customerId: f.customerId, cartId: f.cartId, productId: f.productId, markerId: f.marker.id,
        generation: 0, holdInstanceId: issued.owner.holdInstanceId }, source: null, transition: 'INITIAL', quantity: 2, parent: null };
    const before = await client.info('commandstats');
    const first = new OrdinaryCommandDispatchClaimRepository(schema.db);
    const grant = await first.claim(identity, 'EXECUTE_ONLY');
    expect(grant.status).toBe('FIRST_PHYSICAL_DISPATCH_AUTHORIZED');
    // Process loss: discard first repository/grant. No physical API is invoked.
    const fresh = schema.fresh();
    try {
      const restarted = new OrdinaryCommandDispatchClaimRepository(fresh);
      expect(await client.get(`claim-observation-only:${randomUUID()}`)).toBeNull();
      const observation = kind === 'missing' ? null : '{invalid-json';
      expect(observation === null || !observation.endsWith('}')).toBe(true);
      if (grant.status === 'FIRST_PHYSICAL_DISPATCH_AUTHORIZED') expect(restarted.consumeMutation(grant.claim, 'EXECUTE')).toBeNull();
      expect(await restarted.claim(identity, 'EXECUTE_ONLY')).toEqual({ status: 'NOT_AUTHORIZED' });
      expect(await fresh.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: command.id } }))
        .toMatchObject({ attemptCount: 1, replayId: command.replayId, state: 'PENDING' });
      expect(await fresh.ordinaryReservationCommand.count({ where: { markerId: f.marker.id } })).toBe(1);
      const writes = (stats: string) => stats.split('\n').filter(line => /^cmdstat_(?:eval|evalsha|set|hset|del|hdel|sadd|srem|flushdb|flushall):/.test(line));
      expect(writes(await client.info('commandstats'))).toEqual(writes(before));
    } finally { await fresh.$disconnect(); }
  });
});
