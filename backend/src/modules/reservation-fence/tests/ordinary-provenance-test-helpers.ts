import { randomUUID } from 'crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { OrdinaryReservationCommand } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { seedCartAndProduct, setUpCompensationFixture } from '../../mirror-compensation/repositories/compensation-repository-test-helpers';
import { OrdinaryReservationOwnerRepository } from '../repositories/ordinary-reservation-owner.repository';
import { OrdinaryReservationCommandRepository } from '../repositories/ordinary-reservation-command.repository';

// PostgreSQL only. This fixture never constructs a Redis client.
export async function openOrdinarySchema(baseline: 45 | 46 = 46) {
  const url = new URL(process.env.DATABASE_URL!);
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/^\/g1_isolated_[0-9]+$/.test(url.pathname)
    || process.env.NODE_ENV !== 'test') throw new Error('Disposable local test database required');
  const schema = `ordinary_test_${randomUUID().replace(/-/g, '')}`;
  url.searchParams.set('schema', schema);
  const fresh = () => new PrismaService({ datasources: { db: { url: url.toString() } } });
  const db = fresh();
  const dir = mkdtempSync(join(tmpdir(), 'ordinary-migrations-'));
  const source = resolve(__dirname, '../../../../prisma');
  const names = readdirSync(join(source, 'migrations')).filter(n => /^\d/.test(n)).sort();
  const close = async () => {
    const failures: unknown[] = [];
    try { await db.$disconnect(); } catch (error) { failures.push(error); }
    const admin = new PrismaService();
    try {
      if (!/^ordinary_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe schema');
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch (error) { failures.push(error); }
    finally { try { await admin.$disconnect(); } catch (error) { failures.push(error); } }
    try { rmSync(dir, { recursive: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new Error(`Ordinary fixture cleanup failed in ${failures.length} independent steps`);
  };
  const deploy = (count: number) => {
    for (const name of names.slice(0, count)) cpSync(join(source, 'migrations', name), join(dir, 'migrations', name), { recursive: true });
    try {
      execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', join(dir, 'schema.prisma')],
        { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe', timeout: 90000 });
    } catch { throw new Error('Ordinary disposable migration failed (connection details omitted)'); }
  };
  try {
    if (names.length !== 46 || names[45] !== '20260915000000_ordinary_owner_provenance') throw new Error('Expected exact 46-migration lineage');
    cpSync(join(source, 'schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(join(source, 'migrations/migration_lock.toml'), join(dir, 'migrations/migration_lock.toml'));
    deploy(baseline);
    await db.$connect();
  } catch (error) { await close(); throw error; }
  return { db, fresh, close, upgrade: () => deploy(46) };
}

export async function ordinaryFixture(db: PrismaService, markerId = randomUUID()) {
  const seed = await setUpCompensationFixture(db);
  const ids = await seedCartAndProduct(seed);
  const mode = await db.reservationEngineModeConfig.create({ data: { mode: 'CART_SCOPED', updatedById: ids.customerId } });
  const transition = await db.reservationFenceTransition.create({ data: { incarnation: randomUUID(), epoch: 1,
    revision: mode.revision, phase: 'OPEN', protocol: 1, mode: 'CART_SCOPED', modeRevision: mode.revision,
    status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), reason: 'OPEN', actorId: randomUUID() } });
  // Explicit fixture eligibility, never the production marker insertion path.
  const marker = await db.cartReservationSyncState.create({ data: { id: markerId, ...{ cartId: ids.cartId, productId: ids.productId },
    expectedQuantity: 2, expectedMutationVersion: 0, ordinaryProvenanceState: 'NEW' } });
  const owners = new OrdinaryReservationOwnerRepository(db);
  const commands = new OrdinaryReservationCommandRepository(db);
  const issuance = { ...ids, markerId, generation: 0, incarnation: transition.incarnation,
    reservationExecutionEpoch: transition.epoch, issuanceTransitionId: transition.id };
  const payload = { reason: 'CART_INTENT', w1Transition: 'INITIAL', intentGeneration: 0,
    expectedMutationVersion: 0, authorizedQuantity: 2 } as const;
  return { db, ...ids, marker, transition, issuance, payload, owners, commands };
}

export function acknowledgement(command: OrdinaryReservationCommand) {
  if (command.sequence === null || command.expectedSequence === null) throw new Error('Unassigned fixture command');
  return { commandId: command.id, replayId: command.replayId, sequence: command.sequence,
    expectedSequence: command.expectedSequence, completionReceiptHash: 'a'.repeat(64) };
}

export async function activeOrdinary(db: PrismaService) {
  const f = await ordinaryFixture(db);
  const issued = await f.commands.issue(f.issuance, f.payload);
  const pending = await f.commands.promote(f.marker.id);
  if (!pending) throw new Error('Missing pending fixture');
  // Structural persistence evidence ONLY. No claim of physical acquisition.
  await f.commands.acknowledge(f.marker.id, acknowledgement(pending));
  return { ...f, ...issued };
}

export async function transferredOrdinary(db: PrismaService) {
  const f = await activeOrdinary(db);
  const op = await db.checkoutOperation.create({ data: { cartId: f.cartId, customerId: f.customerId,
    operationKey: randomUUID(), retryKeyHash: randomUUID(), selectedPath: 'CART_SCOPED',
    reservationExecutionEpoch: 1, reservationCapabilityState: 'ACTIVE' } });
  const attempt = await db.checkoutAttempt.create({ data: { cartId: f.cartId, customerId: f.customerId,
    idempotencyKey: op.operationKey, selectedPath: 'CART_SCOPED', reservationExecutionEpoch: 1 } });
  const manifest = await db.$transaction(async tx => {
    const row = await tx.checkoutReservationSettlement.create({ data: {
      operationId: op.id, attemptId: attempt.id, incarnation: f.transition.incarnation, reservationExecutionEpoch: 1,
      captureTransitionId: f.transition.id, acquisitionReplayId: randomUUID(), resources: { create: {
        markerId: f.marker.id, generation: 0, productId: f.productId, quantity: 2, holdInstanceId: f.owner.holdInstanceId,
      } },
    } });
    return tx.checkoutReservationSettlement.update({ where: { id: row.id }, data: { sealed: true } });
  });
  await f.owners.markTransferPending(f.marker.id, f.owner.id, manifest.id);
  await db.checkoutReservationSettlement.update({ where: { id: manifest.id }, data: { state: 'ACQUIRED' } });
  await f.owners.markTransferred(f.marker.id, f.owner.id);
  await db.checkoutAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED', failureCode: 'TEST' } });
  await db.checkoutReservationSettlement.update({ where: { id: manifest.id },
    data: { state: 'REVERT_PENDING', effect: 'CHECKOUT_REVERT_DELETE_ONLY', settlementReplayId: randomUUID() } });
  // DB-level fixture for bridge relationship checks, NOT a physical receipt.
  await db.checkoutReservationSettlement.update({ where: { id: manifest.id },
    data: { state: 'SETTLED', completionReceiptHash: 'b'.repeat(64) } });
  return { ...f, manifest };
}
