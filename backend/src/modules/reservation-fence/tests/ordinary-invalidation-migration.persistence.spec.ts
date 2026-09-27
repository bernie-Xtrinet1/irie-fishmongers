import { openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';
import { ordinaryHoldInstanceId } from '../ordinary-hold-instance-id';

describe('invalidation migration 47: fresh and actual 46 upgrade', () => {
  jest.setTimeout(120000);
  it('fresh deployment contains 47 migrations and zero production enrollment/bindings', async () => {
    const f = await openOrdinarySchema(47);
    try {
      const [row] = await f.db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
      expect(Number(row!.count)).toBe(47);
      expect(await f.db.ordinaryInvalidationHead.count()).toBe(0);
      expect(await f.db.ordinaryInvalidationIntent.count()).toBe(0);
      expect(await f.db.ordinaryCommandBarrierBinding.count()).toBe(0);
      const functions = await f.db.$queryRaw<{ name: string; config: string[]; definer: boolean; schema: string }[]>`
        SELECT p.proname AS name, p.proconfig AS config, p.prosecdef AS definer, n.nspname AS schema
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=current_schema() AND p.proname LIKE 'ordinary_invalidation_%' ORDER BY p.proname`;
      expect(functions).toHaveLength(11);
      for (const fn of functions) {
        expect(fn.definer).toBe(false);
        expect(fn.config).toEqual([`search_path=pg_catalog, ${fn.schema}, pg_temp`]);
      }
    } finally { await f.close(); }
  });
  it('genuinely unenrolled mode history preserves TRUNCATE compatibility without creating authority', async () => {
    const f = await openOrdinarySchema(47);
    try {
      await ordinaryFixture(f.db);
      expect(await f.db.reservationEngineModeConfig.count()).toBeGreaterThan(0);
      expect(await f.db.ordinaryInvalidationHead.count()).toBe(0);
      await f.db.$executeRaw`TRUNCATE TABLE reservation_engine_mode_configs`;
      expect(await f.db.reservationEngineModeConfig.count()).toBe(0);
      expect(await f.db.ordinaryInvalidationHead.count()).toBe(0);
      expect(await f.db.ordinaryCommandBarrierBinding.count()).toBe(0);
    } finally { await f.close(); }
  });
  it('46 -> 47 retains historical marker state without enrollment or authority backfill', async () => {
    const f = await openOrdinarySchema(46);
    try {
      const seed = await ordinaryFixture(f.db);
      // Execute against the genuine migration-46 schema, without consulting
      // post-47 repositories or adding authority to historical commands.
      const historical = await f.db.$transaction(async tx => {
        await tx.cartReservationSyncState.update({ where: { id: seed.marker.id }, data: { ordinaryEnqueueSequence: 1 } });
        const owner = await tx.ordinaryReservationOwner.create({ data: { ...seed.issuance,
          holdInstanceId: ordinaryHoldInstanceId(seed.marker.id, 0) } });
        return tx.ordinaryReservationCommand.create({ data: { ...seed.payload, markerId: seed.marker.id,
          ownerId: owner.id, effect: 'W1', queueOrdinal: 1 } });
      });
      const before = await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: seed.marker.id } });
      f.upgrade();
      expect(await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: seed.marker.id } })).toEqual(before);
      expect(await f.db.ordinaryInvalidationHead.count()).toBe(0);
      expect(await f.db.ordinaryCommandBarrierBinding.count()).toBe(0);
      expect(await f.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(historical);
      await expect(f.db.ordinaryInvalidationHead.create({ data: { scope: `MARKER:${seed.marker.id}`,
        incarnation: seed.transition.incarnation, epoch: 1 } })).rejects.toThrow();
      const [row] = await f.db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
      expect(Number(row!.count)).toBe(47);
    } finally { await f.close(); }
  });
});
