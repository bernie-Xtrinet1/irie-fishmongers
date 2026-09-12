import { PrismaService } from '../../../database/prisma.service';
import { withSettlementSchema } from '../../reservation-fence/tests/checkout-settlement-test-helpers';

// Reuse the repository's disposable-schema fixture, including endpoint
// validation and failure-safe cleanup. Retained manifests forbid row deletion.
export async function openAcquisitionSchema() {
  let complete!: () => void;
  const finished = new Promise<void>(resolve => { complete = resolve; });
  let resolveReady!: (db: PrismaService) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<PrismaService>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const lifetime = withSettlementSchema(async (db, upgrade) => {
    upgrade();
    resolveReady(db);
    await finished;
  });
  void lifetime.catch(rejectReady);
  const prisma = await ready;
  try {
    const rows = await prisma.$queryRaw<{ schema: string }[]>`SELECT current_schema() AS schema`;
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('schema', rows[0]!.schema);
    return { prisma, newClient: () => new PrismaService({ datasources: { db: { url: url.toString() } } }),
      close: async () => { complete(); await lifetime; } };
  } catch (error) {
    complete();
    try { await lifetime; } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Acquisition fixture setup and cleanup failed'); }
    throw error;
  }
}
