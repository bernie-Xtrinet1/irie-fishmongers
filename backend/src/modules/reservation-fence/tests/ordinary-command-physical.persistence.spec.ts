import { Redis } from 'ioredis';
import { RedisService } from '../../../common/redis/redis.service';
import { OrdinaryCommandPhysicalService } from '../services/ordinary-command-physical.service';
import { OrdinaryPhysicalGrant } from '../types/ordinary-command-physical.types';
import { claimOrdinaryMutation, acknowledgement, ordinaryFixture, openOrdinarySchema } from './ordinary-provenance-test-helpers';
import { PRODUCT_CONTROL_INSTALL } from '../lua/product-reservation-restriction.lua';
import { ORDINARY_PHYSICAL_REGISTER } from '../lua/ordinary-command-physical.lua';
import { controlBytes, productControlKey } from '../types/product-reservation-restriction.types';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { transitionTuple } from '../repositories/reservation-fence.repository';

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
    await expect(claimOrdinaryMutation(schema.db, issued.command.id, 'EXECUTE_ONLY')).rejects.toThrow();
    const physical = new OrdinaryCommandPhysicalService(schema.db, redis);
    expect(await Reflect.apply(physical.execute.bind(physical), physical, [issued.command.id])).toEqual({ code: 'REJECTED' });
    expect(evalSpy).not.toHaveBeenCalled();
  });
  it('reads committed pending state and releases the marker lock before registration', async () => {
    const f = await ordinaryFixture(schema.db);
    const issued = await f.commands.issue(f.issuance, f.payload);
    await f.commands.promote(f.marker.id);
    const admission = await claimOrdinaryMutation(schema.db, issued.command.id, 'EXECUTE_ONLY');
    const fresh = schema.fresh();
    const observed: string[] = [];
    const failures: unknown[] = [];
    const evalSpy = jest.spyOn(redis, 'eval').mockImplementation(async (script, keys, args) => {
      try {
      if (script === PRODUCT_CONTROL_INSTALL) {
        expect(observed).toEqual([]);
        expect(keys).toEqual([RESERVATION_FENCE_KEY, productControlKey(f.productId)]);
        const bytes = controlBytes({ version: 1, productId: f.productId, state: 'ALLOW', restrictionId: null,
          restrictionRevision: 0, incarnation: f.transition.incarnation, epoch: f.transition.epoch });
        expect(args).toEqual([JSON.stringify(transitionTuple(f.transition)), bytes]);
        await expect(fresh.$transaction(async tx => {
          await tx.$queryRaw`SELECT id FROM cart_reservation_sync_states WHERE id=${f.marker.id} FOR UPDATE NOWAIT`;
        })).rejects.toThrow();
        const lock = await fresh.$transaction(tx => tx.$queryRaw<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(1380339280,1) AS acquired`);
        expect(lock).toEqual([{ acquired: false }]);
        observed.push('initialized-under-lock');
        return JSON.stringify({ code: 'ACCEPTED', value: bytes });
      }
      expect(script).toBe(ORDINARY_PHYSICAL_REGISTER);
      expect(observed).toEqual(['initialized-under-lock']);
      await fresh.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout='500ms'`;
        await tx.$queryRaw`SELECT id FROM cart_reservation_sync_states WHERE id=${f.marker.id} FOR UPDATE NOWAIT`;
        expect(await tx.$queryRaw<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(1380339280,1) AS acquired`).toEqual([{ acquired: true }]);
      });
      const grant = JSON.parse(String(args[0])) as OrdinaryPhysicalGrant;
      expect(JSON.parse(grant.identity)).toMatchObject({ commandId: issued.command.id, replayId: issued.command.replayId,
        ownerId: issued.owner.id, sequence: 1, expectedSequence: 0 });
      observed.push('exact-registration-after-unlock');
      return JSON.stringify({ code: 'REJECTED' });
      } catch (error) { failures.push(error); throw error; }
    });
    try {
      await new OrdinaryCommandPhysicalService(schema.db, redis).execute(admission.capability, admission.issuer);
      expect(failures).toEqual([]); // Service error handling must not swallow test failures.
      expect(observed).toEqual(['initialized-under-lock', 'exact-registration-after-unlock']);
      expect(evalSpy).toHaveBeenCalledTimes(2);
    }
    finally { await fresh.$disconnect(); }
    expect(await schema.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: issued.command.id } }))
      .toMatchObject({ state: 'PENDING', attemptCount: 1, completionReceiptHash: null });
  });
  it('rejects a stale desired generation before Redis registration', async () => {
    const f = await ordinaryFixture(schema.db);
    const issued = await f.commands.issue(f.issuance, f.payload);
    await f.commands.promote(f.marker.id);
    const admission = await claimOrdinaryMutation(schema.db, issued.command.id, 'EXECUTE_ONLY');
    await schema.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 1 } });
    const evalSpy = jest.spyOn(redis, 'eval').mockResolvedValue('{}');
    expect(await new OrdinaryCommandPhysicalService(schema.db, redis).execute(admission.capability, admission.issuer)).toEqual({ code: 'REJECTED' });
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
