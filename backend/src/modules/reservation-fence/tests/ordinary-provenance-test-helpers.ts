import { Redis } from 'ioredis';
import { RedisService } from '../../../common/redis/redis.service';
import { OrdinaryCommandPhysicalService } from '../services/ordinary-command-physical.service';
import { OrdinaryCommandClosureService } from '../services/ordinary-command-closure.service';
import { OrdinaryReleaseService } from '../services/ordinary-release.service';
import { OrdinaryCommandDispatchClaimRepository } from '../repositories/ordinary-command-dispatch-claim.repository';
import { ORDINARY_INVALIDATION_LUA, invalidationHistoryKey } from '../lua/ordinary-invalidation.lua';
import { ORDINARY_PHYSICAL_EXECUTE, ORDINARY_PHYSICAL_REGISTER } from '../lua/ordinary-command-physical.lua';
import { canonicalInvalidationJson, invalidationRedisKey } from '../types/ordinary-invalidation.types';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY, resourceGuardKey } from '../lua/reservation-mutation-common.lua';
import { ordinaryPhysicalLedgerKey, OrdinaryPhysicalResult } from '../types/ordinary-command-physical.types';
import { releaseIdentity } from '../types/ordinary-release.types';
import { reservationKey, cartIndexKey, productIndexKey, productTotalKey } from '../../inventory/constants/inventory.constants';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { OrdinaryInvalidationPublicationService } from '../services/ordinary-invalidation-publication.service';
import { InvalidationRequest, barrierAcknowledgement } from '../types/ordinary-invalidation.types';
import { transitionTuple } from '../repositories/reservation-fence.repository';
import { createHash, randomUUID } from 'crypto';
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
export async function openOrdinarySchema(baseline: 45 | 46 | 47 | 48 = 48) {
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
    if (names.length !== 48 || names[45] !== '20260915000000_ordinary_owner_provenance'
      || names[46] !== '20260919000000_ordinary_invalidation_publication'
      || names[47] !== '20260925000000_publication_scoped_ordinary_release') throw new Error('Expected exact 48-migration lineage');
    cpSync(join(source, 'schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(join(source, 'migrations/migration_lock.toml'), join(dir, 'migrations/migration_lock.toml'));
    deploy(baseline);
    await db.$connect();
  } catch (error) { await close(); throw error; }
  return { db, fresh, close, upgrade: () => deploy(baseline === 45 ? 46 : baseline === 46 ? 47 : 48) };
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

// Publication fixture: structural PostgreSQL confirmation only unless the caller
// separately installs and observes these exact barriers in disposable Redis.
export async function ordinaryReleaseFixture(db: PrismaService, acknowledge = true) {
  const f = await ordinaryFixture(db), repo = new OrdinaryInvalidationRepository(db);
  const publication = new OrdinaryInvalidationPublicationService(repo), tuple = transitionTuple(f.transition);
  await db.ordinaryInvalidationHead.createMany({ data: ['GLOBAL', `MARKER:${f.marker.id}`].map(scope => ({ scope,
    incarnation: tuple.incarnation, epoch: tuple.epoch })) });
  const markerScope = { kind: 'MARKER' as const, revision: 0, markerId: f.marker.id, cartId: f.cartId,
    productId: f.productId, customerId: f.customerId,
    before: { generation: 0, mutationVersion: 0, quantity: 2 }, after: { generation: 0, mutationVersion: 0, quantity: 2 },
    cartBefore: null, cartAfter: null, ownersBefore: [], ownersAfter: [] };
  const initial: InvalidationRequest = { version: 1, intentId: randomUUID(), operationId: randomUUID(), kind: 'CART',
    incarnation: tuple.incarnation, epoch: tuple.epoch, scopes: [
      { kind: 'GLOBAL', revision: 0, before: tuple, after: tuple,
        modeBefore: { mode: 'CART_SCOPED', revision: f.transition.modeRevision }, modeAfter: null }, markerScope] };
  await repo.prepare(initial); await repo.confirm(initial, barrierAcknowledgement(initial));
  await publication.publish(initial.intentId, () => Promise.resolve({ bootstrap: true }));
  await db.ordinaryInvalidationHead.updateMany({ data: { ready: true } });
  const issued = await f.commands.issue(f.issuance, f.payload), pending = await f.commands.promote(f.marker.id);
  if (!pending) throw new Error('Missing W1');
  if (acknowledge) await f.commands.acknowledge(f.marker.id, acknowledgement(pending));
  const request: InvalidationRequest = { ...initial, intentId: randomUUID(), operationId: randomUUID(), kind: 'OWNER', scopes: [
    { ...markerScope, revision: 1, after: { generation: 1, mutationVersion: 1, quantity: null },
      ownersBefore: [{ id: issued.owner.id, state: 'ACTIVE' }], ownersAfter: [{ id: issued.owner.id, state: 'RELEASE_PENDING' }] }] };
  const prepare = async () => { await repo.prepare(request); await repo.confirm(request, barrierAcknowledgement(request)); };
  const domain = async (tx: Parameters<Parameters<typeof publication.publish>[1]>[0]) => {
    await tx.cartReservationSyncState.update({ where: { id: f.marker.id },
      data: { generation: 1, expectedMutationVersion: 1, expectedQuantity: null } });
    return { markerId: f.marker.id };
  };
  return { ...f, ...issued, pending, initial, request, repo, publication, prepare, domain };
}

// PostgreSQL closure tests supply an observation at the existing adapter seam.
// They exercise all real evidence/identity/lifecycle checks, not Redis execution.
// The real Redis suites separately establish physical receipt production.
export async function releaseCompletionObservation(db: PrismaService, commandId: string): Promise<OrdinaryPhysicalResult> {
  const command = await db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: commandId } });
  const identity = JSON.stringify(await releaseIdentity(db, command, new OrdinaryReservationOwnerRepository(db)));
  const receipt = JSON.stringify({ version: 1, identity, action: 'RELEASE', complete: true, result: 'RELEASED' });
  return { code: 'COMPLETED', historical: true, identity, receipt,
    completionReceiptHash: createHash('sha256').update(receipt).digest('hex') };
}

export async function withOrdinaryReleaseRedis(work: (f: Awaited<ReturnType<typeof setupReleaseRedis>>) => Promise<void>, phase: 'OPEN' | 'DRAINING' = 'OPEN') {
  if (process.env.REDIS_URL !== 'redis://127.0.0.1:16479/11') throw new Error('Exact disposable Redis required');
  const client = new Redis(process.env.REDIS_URL, { lazyConnect: true, retryStrategy: null, maxRetriesPerRequest: 0 });
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>> | undefined;
  const keys = new Set<string>(), fields = new Set<string>();
  let control: string | null | undefined, incarnation: string | null | undefined;
  const errors: unknown[] = [];
  try {
    await client.connect();
    for (const [key, value] of [['bind', '127.0.0.1'], ['port', '16479'], ['save', ''], ['appendonly', 'no'], ['daemonize', 'no']])
      expect(await client.config('GET', key!)).toEqual([key, value]);
    expect(await client.info('server')).toContain('redis_mode:standalone');
    const global = invalidationRedisKey('GLOBAL');
    if (await client.exists(global, invalidationHistoryKey(global))) throw new Error('Test requires unused global barrier');
    control = await client.get(RESERVATION_FENCE_KEY);
    incarnation = await client.hget(MUTATION_HISTORY_KEY, 'incarnation');
    schema = await openOrdinarySchema();
    keys.add(global); keys.add(invalidationHistoryKey(global));
    await work(await setupReleaseRedis(schema.db, client, keys, fields, phase));
  } catch (error) { errors.push(error); }
  finally {
    try {
      if (client.status === 'ready') {
        if (keys.size) await client.del(...keys);
        if (fields.size) await client.hdel(MUTATION_HISTORY_KEY, ...fields);
        if (control !== undefined) { if (control === null) await client.del(RESERVATION_FENCE_KEY); else await client.set(RESERVATION_FENCE_KEY, control); }
        if (incarnation !== undefined) { if (incarnation === null) await client.hdel(MUTATION_HISTORY_KEY, 'incarnation'); else await client.hset(MUTATION_HISTORY_KEY, 'incarnation', incarnation); }
      }
    } catch (error) { errors.push(error); }
    try { if (client.status === 'ready') await client.quit(); else client.disconnect(); } catch (error) { errors.push(error); }
    try { if (schema) await schema.close(); } catch (error) { errors.push(error); }
    jest.restoreAllMocks();
  }
  if (errors.length) throw new AggregateError(errors, 'RELEASE fixture failed');
}

async function setupReleaseRedis(db: PrismaService, client: Redis, keys: Set<string>, fields: Set<string>, phase: 'OPEN' | 'DRAINING') {
  const f = await ordinaryReleaseFixture(db, false), redis = new RedisService(client);
  let tuple = transitionTuple(f.transition);
  await client.set(RESERVATION_FENCE_KEY, JSON.stringify(tuple));
  await client.hset(MUTATION_HISTORY_KEY, 'incarnation', tuple.incarnation);
  const markerBarrier = invalidationRedisKey(`MARKER:${f.marker.id}`);
  const entry = reservationKey(f.cartId, f.productId), guard = resourceGuardKey(f.marker.id), ledger = ordinaryPhysicalLedgerKey(f.marker.id);
  const pin = `reservation:fence:checkout-pin:${f.marker.id}`;
  const cartIndex = cartIndexKey(f.cartId), productIndex = productIndexKey(f.productId), total = productTotalKey(f.productId);
  [markerBarrier,invalidationHistoryKey(markerBarrier),entry,guard,ledger,pin,cartIndex,productIndex,total].forEach(k => keys.add(k));
  fields.add(guard); fields.add(ledger);
  const evaluate = RedisService.prototype.eval.bind(redis);
  let drainingOrdinaryChecked = false;
  jest.spyOn(redis, 'eval').mockImplementation(async (script, ks, args) => {
    if (ks[3]?.startsWith('reservation:fence:ordinary-command-grant:')) keys.add(ks[3]);
    if (phase === 'DRAINING' && script === ORDINARY_PHYSICAL_EXECUTE && !drainingOrdinaryChecked) {
      drainingOrdinaryChecked = true;
      expect((await db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: f.pending.id } })).state).toBe('PENDING');
      const snapshot = async () => ({ entry: await client.get(entry), guard: await client.get(guard), total: await client.get(total),
        cart: await client.smembers(cartIndex), product: await client.smembers(productIndex), ledger: await client.hgetall(ledger),
        guardHistory: await client.hget(MUTATION_HISTORY_KEY, guard) });
      const openControl = await client.get(RESERVATION_FENCE_KEY), openBarrier = await client.get(markerBarrier);
      if (!openControl || !openBarrier) throw new Error('Missing OPEN positive-control state');
      const grant = JSON.parse(String(args[0])) as import('../types/ordinary-command-physical.types').OrdinaryPhysicalGrant;
      const barrier: unknown = JSON.parse(openBarrier);
      if (!barrier || typeof barrier !== 'object' || Array.isArray(barrier)) throw new Error('Malformed OPEN barrier');
      const closed = { ...barrier, state: 'CLOSED' };
      await client.set(markerBarrier, JSON.stringify(closed));
      await client.set(RESERVATION_FENCE_KEY, JSON.stringify({ ...tuple, phase: 'DRAINING' }));
      const before = await snapshot();
      const drainingGrant = { ...grant, grantId: randomUUID(), tuple: { ...grant.tuple, phase: 'DRAINING' } };
      const drainingKeys = [...ks.slice(0, 3), `reservation:fence:ordinary-command-grant:${drainingGrant.grantId}`];
      keys.add(drainingKeys[3]!);
      expect(JSON.parse(String(await evaluate(ORDINARY_PHYSICAL_REGISTER, drainingKeys, [JSON.stringify(drainingGrant)]))))
        .toEqual({ code: 'REJECTED' });
      expect(JSON.parse(String(await evaluate(script, ks, args)))).toEqual({ code: 'REJECTED' });
      expect(await snapshot()).toEqual(before);
      await client.set(RESERVATION_FENCE_KEY, openControl);
      await client.set(markerBarrier, openBarrier);
      // The exact same loaded W1 succeeds under OPEN/READY, before durable ACK.
      const positive = await evaluate(script, ks, args);
      expect(JSON.parse(String(positive))).toMatchObject({ code: 'COMPLETED' });
      return positive;
    }
    return evaluate(script, ks, args);
  });
  const install = async (request: InvalidationRequest, command: 'INSTALL' | 'READY') => {
    const ack = barrierAcknowledgement(request);
    const raw = await redis.eval(ORDINARY_INVALIDATION_LUA, [RESERVATION_FENCE_KEY, ...ack.scopes.map(s => invalidationRedisKey(s.scope))],
      [canonicalInvalidationJson(ack), command]);
    const reply: unknown = JSON.parse(String(raw));
    expect(reply).toMatchObject({ code: 'CONFIRMED' });
  };
  await install(f.initial, 'INSTALL'); await install(f.initial, 'READY');
  const physical = new OrdinaryCommandPhysicalService(db, redis), closure = new OrdinaryCommandClosureService(db, physical);
  expect((await physical.initialize(f.pending.id)).code).toBe('INITIALIZED');
  expect((await physical.execute(f.pending.id)).code).toBe('COMPLETED');
  expect((await closure.close(f.pending.id)).status).toBe('ACKNOWLEDGED');
  if (phase === 'DRAINING') {
    const after = { ...tuple, phase: 'DRAINING' as const, revision: tuple.revision + 1, transitionId: randomUUID() };
    const restriction: InvalidationRequest = { version: 1, kind: 'FENCE', intentId: randomUUID(), operationId: randomUUID(),
      incarnation: tuple.incarnation, epoch: tuple.epoch, scopes: [{ kind: 'GLOBAL', revision: 1, before: tuple, after,
        modeBefore: { mode: 'CART_SCOPED', revision: f.transition.modeRevision }, modeAfter: null }] };
    await f.repo.prepare(restriction); await install(restriction, 'INSTALL');
    await f.repo.confirm(restriction, barrierAcknowledgement(restriction));
    await f.publication.publish(restriction.intentId, async tx => {
      await tx.reservationFenceTransition.create({ data: { id: after.transitionId, incarnation: after.incarnation, epoch: after.epoch,
        revision: after.revision, phase: 'DRAINING', protocol: 1, mode: 'CART_SCOPED', modeRevision: f.transition.modeRevision,
        status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), reason: 'DRAINING', actorId: randomUUID() } });
      return { restriction: true };
    });
    tuple = after;
    await client.set(RESERVATION_FENCE_KEY, JSON.stringify(tuple));
  }
  await f.prepare(); await install(f.request, 'INSTALL');
  const issuer = new OrdinaryReleaseService(db);
  const published = await issuer.publish(f.request.intentId, { ownerId: f.owner.id, reason: 'CART_REMOVAL' }, f.domain);
  if (published.status !== 'PUBLISHED') throw new Error('Release publication failed');
  const claims = new OrdinaryCommandDispatchClaimRepository(db);
  const claimed = await claims.claimRelease(published.admission, issuer);
  if (claimed.status !== 'FIRST_PHYSICAL_DISPATCH_AUTHORIZED') throw new Error('Release claim failed');
  const snapshot = async () => ({ entry: await client.get(entry), guard: await client.get(guard), pin: await client.get(pin),
    total: await client.get(total), cart: (await client.smembers(cartIndex)).sort(), product: (await client.smembers(productIndex)).sort(),
    ledger: await client.hgetall(ledger), barrier: await client.get(markerBarrier) });
  return { ...f, client, redis, physical, closure, issuer, claims, claim: claimed.claim, release: published.command,
    entry, guard, ledger, pin, cartIndex, productIndex, total, markerBarrier, tuple, install, snapshot, drainingOrdinaryChecked };
}
