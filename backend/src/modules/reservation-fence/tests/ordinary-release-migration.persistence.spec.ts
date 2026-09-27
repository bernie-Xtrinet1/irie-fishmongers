import { ordinaryHoldInstanceId } from '../ordinary-hold-instance-id';
import { openOrdinarySchema, ordinaryFixture, ordinaryReleaseFixture } from './ordinary-provenance-test-helpers';

describe('migration 48 publication RELEASE', () => {
  jest.setTimeout(120000);
  it.each([47, 48] as const)('deploys %s and preserves historical state through actual 47 -> 48', async baseline => {
    const schema = await openOrdinarySchema(baseline);
    try {
      const f = await ordinaryFixture(schema.db);
      await f.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { ordinaryProvenanceState: 'HISTORICAL_UNVERIFIED' } });
      if (baseline === 47) schema.upgrade();
      const [row] = await f.db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
      expect(Number(row!.count)).toBe(48);
      expect((await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } })).ordinaryProvenanceState)
        .toBe('HISTORICAL_UNVERIFIED');
      expect(await f.db.ordinaryInvalidationHead.count()).toBe(0);
      const functions = await f.db.$queryRaw<{ name: string; invoker: boolean; settings: string[] }[]>`
        SELECT proname AS name, NOT prosecdef AS invoker, proconfig AS settings FROM pg_proc
        WHERE pronamespace=current_schema()::regnamespace AND proname LIKE 'ordinary_release_%'`;
      expect(functions).toHaveLength(6);
      const markerVector = '123e4567-e89b-12d3-a456-426614174000';
      const [vector] = await f.db.$queryRaw<{ id: string }[]>`SELECT ordinary_release_hold_identity(${markerVector},0)::text AS id`;
      expect(vector!.id).toBe('47cfb9c9-18fa-5393-b970-968535e03499');
      for (const invalid of [markerVector.toUpperCase(), `${markerVector}\n`]) {
        await expect(f.db.$queryRaw`SELECT ordinary_release_hold_identity(${invalid},0)`).rejects.toThrow('invalid ordinary hold identity');
      }
      for (const generation of [0, 1, 17, 2147483647]) {
        const [identity] = await f.db.$queryRaw<{ id: string }[]>`SELECT ordinary_release_hold_identity(${f.marker.id},${generation}::integer)::text AS id`;
        expect(identity!.id).toBe(ordinaryHoldInstanceId(f.marker.id, generation));
      }
      for (const fn of functions) {
        expect(fn.invoker).toBe(true);
        expect(fn.settings[0]).toMatch(/^search_path=pg_catalog, ordinary_test_[a-f0-9]+, pg_temp$/);
      }
    } finally { await schema.close(); }
  });
  it('TRUNCATE and CASCADE cannot erase enrolled authority, including under temp shadowing', async () => {
    const schema = await openOrdinarySchema();
    try {
      const f = await ordinaryReleaseFixture(schema.db);
      for (const target of ['ordinary_invalidation_heads', 'ordinary_reservation_commands', 'carts']) {
        await expect(f.db.$transaction(async tx => {
          await tx.$executeRaw`CREATE TEMP TABLE ordinary_invalidation_heads (scope text)`;
          const [row] = await tx.$queryRaw<{ schema: string }[]>`SELECT current_schema() AS schema`;
          if (!row || !/^ordinary_test_[a-f0-9]+$/.test(row.schema)) throw new Error('Unsafe schema');
          // Both identifiers are fixture-validated/fixed literals; no user SQL.
          await tx.$executeRawUnsafe(`TRUNCATE TABLE "${row.schema}"."${target}" CASCADE`);
        })).rejects.toThrow('enrolled protocol cannot be truncated');
      }
      expect(await f.db.ordinaryInvalidationHead.count()).toBe(2);
    } finally { await schema.close(); }
  });
});
