import { Redis } from 'ioredis';
import { RedisService } from '../../../common/redis/redis.service';
import { OrdinaryCommandPhysicalService } from '../services/ordinary-command-physical.service';
import { OrdinaryPhysicalGrant } from '../types/ordinary-command-physical.types';
import { acknowledgement, ordinaryFixture, openOrdinarySchema } from './ordinary-provenance-test-helpers';

describe('Stage B independently reloads committed authority (no Redis connection)', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>>;
  const client = new Redis('redis://127.0.0.1:16479/11', { lazyConnect: true });
  const redis = new RedisService(client);
  beforeAll(async () => { schema = await openOrdinarySchema(); });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { client.disconnect(); if (schema) await schema.close(); });
  it.each(['WAITING', 'UNCERTAIN', 'ACKNOWLEDGED', 'REVOKED'] as const)('%s cannot authorize first execution', async state => {
    const f = await ordinaryFixture(schema.db);
    const issued = await f.commands.issue(f.issuance, f.payload);
    if (state === 'REVOKED') await f.owners.revokeNeverExecuted(f.marker.id, issued.owner.id);
    if (state === 'UNCERTAIN' || state === 'ACKNOWLEDGED') {
      const p = await f.commands.promote(f.marker.id);
      if (!p) throw new Error('Missing fixture command');
      if (state === 'UNCERTAIN') await f.commands.recordDispatch(f.marker.id, p.id, f.transition.id, true, null);
      else await f.commands.acknowledge(f.marker.id, acknowledgement(p));
    }
    const evalSpy = jest.spyOn(redis, 'eval').mockResolvedValue('{}');
    expect(await new OrdinaryCommandPhysicalService(schema.db, redis).execute(issued.command.id)).toEqual({ code: 'REJECTED' });
    expect(evalSpy).not.toHaveBeenCalled();
  });
  it('reads committed pending state and releases the marker lock before registration', async () => {
    const f = await ordinaryFixture(schema.db);
    const issued = await f.commands.issue(f.issuance, f.payload);
    await f.commands.promote(f.marker.id);
    const fresh = schema.fresh();
    const evalSpy = jest.spyOn(redis, 'eval').mockImplementation(async (_script, _keys, args) => {
      await fresh.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout='500ms'`;
        await tx.$queryRaw`SELECT id FROM cart_reservation_sync_states WHERE id=${f.marker.id} FOR UPDATE NOWAIT`;
      });
      const grant = JSON.parse(String(args[0])) as OrdinaryPhysicalGrant;
      expect(JSON.parse(grant.identity)).toMatchObject({ commandId: issued.command.id, replayId: issued.command.replayId,
        ownerId: issued.owner.id, sequence: 1, expectedSequence: 0 });
      return JSON.stringify({ code: 'REJECTED' });
    });
    try { await new OrdinaryCommandPhysicalService(schema.db, redis).execute(issued.command.id); expect(evalSpy).toHaveBeenCalledTimes(1); }
    finally { await fresh.$disconnect(); }
    expect(await schema.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: issued.command.id } }))
      .toMatchObject({ state: 'PENDING', attemptCount: 0, completionReceiptHash: null });
  });
  it('rejects a stale desired generation before Redis registration', async () => {
    const f = await ordinaryFixture(schema.db);
    const issued = await f.commands.issue(f.issuance, f.payload);
    await f.commands.promote(f.marker.id);
    await schema.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 1 } });
    const evalSpy = jest.spyOn(redis, 'eval').mockResolvedValue('{}');
    expect(await new OrdinaryCommandPhysicalService(schema.db, redis).execute(issued.command.id)).toEqual({ code: 'REJECTED' });
    expect(evalSpy).not.toHaveBeenCalled();
  });
  it('UNCERTAIN observation reloads identity but never registers a grant', async () => {
    const f = await ordinaryFixture(schema.db);
    const issued = await f.commands.issue(f.issuance, f.payload);
    await f.commands.promote(f.marker.id);
    await f.commands.recordDispatch(f.marker.id, issued.command.id, f.transition.id, true, null);
    const evalSpy = jest.spyOn(redis, 'eval').mockResolvedValue(JSON.stringify({ code: 'REJECTED' }));
    await new OrdinaryCommandPhysicalService(schema.db, redis).observe(issued.command.id);
    expect(evalSpy).toHaveBeenCalledTimes(1);
    expect(evalSpy.mock.calls[0]![1]).toHaveLength(3);
  });
});
