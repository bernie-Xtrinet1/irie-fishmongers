import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaService } from '../../../database/prisma.service';

describe('G.PR0 additive path migration', () => {
  const prisma = new PrismaService();
  afterAll(async () => {
    await prisma.$disconnect();
  });
  it('preserves existing unknown rows and adds no default/backfill in an isolated rollback-only schema', async () => {
    const schema = `pr0_${randomUUID().replace(/-/g, '')}`;
    const sql = readFileSync(
      resolve(
        __dirname,
        '../../../../prisma/migrations/20260908000000_add_checkout_attempt_selected_path/migration.sql',
      ),
      'utf8',
    );
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
        await tx.$executeRawUnsafe(
          'CREATE TABLE checkout_attempts (id text PRIMARY KEY, status text NOT NULL, "lastHeartbeatAt" timestamp NOT NULL)',
        );
        await tx.$executeRaw`INSERT INTO checkout_attempts VALUES ('old', 'PROCESSING', '2026-01-01')`;
        for (const statement of sql.split(';').filter((part) => part.trim()))
          await tx.$executeRawUnsafe(statement);
        const rows = await tx.$queryRaw<
          { id: string; status: string; selectedPath: string | null }[]
        >`
        SELECT id, status, "selectedPath" FROM checkout_attempts`;
        expect(rows).toEqual([{ id: 'old', status: 'PROCESSING', selectedPath: null }]);
        const columns = await tx.$queryRaw<
          { column_default: string | null; is_nullable: string }[]
        >`
        SELECT column_default, is_nullable FROM information_schema.columns
        WHERE table_schema = ${schema} AND table_name = 'checkout_attempts' AND column_name = 'selectedPath'`;
        expect(columns).toEqual([{ column_default: null, is_nullable: 'YES' }]);
        await tx.$executeRaw`INSERT INTO checkout_attempts VALUES ('new', 'PROCESSING', '2026-01-01', 'CART_SCOPED')`;
        throw new Error('rollback verified migration fixture');
      }),
    ).rejects.toThrow('rollback verified migration fixture');
  });
});
