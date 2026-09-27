import { randomUUID } from 'crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';
import { PrismaService } from '../../../database/prisma.service';
import { assertDisposableEnvironment, withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';

// Test reset mechanism: a uniquely named disposable schema, never shared tables.
// Entire schema is removed after disconnect, including retained evidence rows.
export async function withSettlementSchema(work: (db: PrismaService, upgrade: (target?: 47 | 48) => void) => Promise<void>, baseline: 43 | 44 = 43) {
  assertDisposableEnvironment();
  const schema = `settlement_test_${randomUUID().replace(/-/g, '')}`;
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('schema', schema);
  const db = new PrismaService({ datasources: { db: { url: url.toString() } } });
  const admin = new PrismaService();
  const dir = mkdtempSync(join(tmpdir(), 'settlement-migrations-'));
  const source = resolve(__dirname, '../../../../prisma');
  const migrations = readdirSync(join(source, 'migrations')).filter(x => /^\d/.test(x)).sort();
  if (migrations.length !== 48) throw new Error('Expected 48 migrations including inactive publication release');
  cpSync(join(source, 'schema.prisma'), join(dir, 'schema.prisma'));
  for (const name of migrations.slice(0, baseline)) cpSync(join(source, 'migrations', name), join(dir, 'migrations', name), { recursive: true });
  cpSync(join(source, 'migrations/migration_lock.toml'), join(dir, 'migrations/migration_lock.toml'));
  const deploy = () => {
    try {
      execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', join(dir, 'schema.prisma')],
        { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe', timeout: 60000 });
    } catch { throw new Error('Disposable settlement migration failed (credentials omitted)'); }
  };
  return withCleanup(async () => {
    deploy();
    await work(db, (target = 48) => {
      for (const name of migrations.slice(baseline, target))
        cpSync(join(source, 'migrations', name), join(dir, 'migrations', name), { recursive: true });
      deploy();
    });
  }, [async () => {
    await db.$disconnect();
    if (!/^settlement_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe fixture schema');
    try { await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.$disconnect(); }
  }, () => { rmSync(dir, { recursive: true }); return Promise.resolve(); }]);
}

export function settlementMigrationSource() {
  return readFileSync(resolve(__dirname, '../../../../prisma/migrations/20260912000000_checkout_settlement_manifest/migration.sql'), 'utf8');
}
