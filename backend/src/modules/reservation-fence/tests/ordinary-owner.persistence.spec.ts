import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Prisma } from '@prisma/client';
import { ordinaryHoldInstanceId } from '../ordinary-hold-instance-id';
import { activeOrdinary, openOrdinarySchema, ordinaryFixture, seedCartAndProductForSchema, transferredOrdinary } from './ordinary-provenance-test-helpers';

describe('ordinary owner inert persistence', () => {
  jest.setTimeout(120000);
  let fixture: Awaited<ReturnType<typeof openOrdinarySchema>>;
  beforeAll(async () => { fixture = await openOrdinarySchema(); });
  afterAll(async () => { if (fixture) await fixture.close(); });

  it('fresh deployment applies all 70 migrations', async () => {
    const rows = await fixture.db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    expect(Number(rows[0]!.count)).toBe(70);
  });

  it('45 -> 46 preserves historical markers and old-code insert defaults with zero counters', async () => {
    const old = await openOrdinarySchema(45);
    try {
      const { setUpCompensationFixture } = await import('../../mirror-compensation/repositories/compensation-repository-test-helpers');
      const compFixture = await setUpCompensationFixture(old.db);
      const ids = await seedCartAndProductForSchema(compFixture);
      const id = randomUUID();
      await old.db.$executeRaw`INSERT INTO cart_reservation_sync_states
        (id,"cartId","productId","expectedMutationVersion","expectedQuantity","updatedAt")
        VALUES (${id},${ids.cartId},${ids.productId},0,2,now())`;
      old.upgrade();
      const expected = { ordinaryProvenanceState: 'HISTORICAL_UNVERIFIED', ordinaryEnqueueSequence: 0,
        ordinaryCommandSequence: 0, ordinaryAcknowledgedSequence: 0 };
      expect(await old.db.cartReservationSyncState.findUniqueOrThrow({ where: { id } })).toMatchObject(expected);
      const next = await seedCartAndProductForSchema(compFixture);
      expect(await old.db.cartReservationSyncState.create({ data: { cartId: next.cartId, productId: next.productId,
        expectedMutationVersion: 0 } })).toMatchObject(expected);
      expect(await old.db.ordinaryReservationOwner.count()).toBe(0);
      expect(await old.db.ordinaryReservationCommand.count()).toBe(0);
      await expect(old.db.cartReservationSyncState.update({ where: { id }, data: { ordinaryProvenanceState: 'NEW' } })).rejects.toThrow();
    } finally { await old.close(); }
  });

  it('computes and reloads the exact approved canonical fixed vector', async () => {
    const f = await ordinaryFixture(fixture.db, '123e4567-e89b-12d3-a456-426614174000');
    const { owner } = await f.commands.issue(f.issuance, f.payload);
    expect(owner.holdInstanceId).toBe('47cfb9c9-18fa-5393-b970-968535e03499');
    expect(await f.owners.loadAuthority(owner.id)).toEqual(owner);
  });

  it('rejects a structurally valid but noncanonical raw row on authority load', async () => {
    const f = await ordinaryFixture(fixture.db);
    const ownerId = randomUUID();
    await f.db.$transaction(async tx => {
      await tx.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { ordinaryEnqueueSequence: 1 } });
      await tx.ordinaryReservationOwner.create({ data: { ...f.issuance, id: ownerId,
        holdInstanceId: ordinaryHoldInstanceId(randomUUID(), 0) } });
      await tx.ordinaryReservationCommand.create({ data: { ...f.payload, markerId: f.marker.id,
        ownerId, effect: 'W1', queueOrdinal: 1 } });
    });
    await expect(f.owners.loadAuthority(ownerId)).rejects.toThrow('ORDINARY_NONCANONICAL_OWNER');
    await expect(f.commands.promote(f.marker.id)).rejects.toThrow('ORDINARY_NONCANONICAL_OWNER');
  });

  it.each(['generation', 'customer', 'cart', 'product', 'transition', 'epoch', 'incarnation'] as const)
  ('rejects invalid %s provenance independently of uniqueness', async kind => {
    const f = await ordinaryFixture(fixture.db);
    const data = { ...f.issuance, holdInstanceId: ordinaryHoldInstanceId(f.marker.id, 0) };
    if (kind === 'generation') data.generation = -1;
    if (kind === 'customer') data.customerId = randomUUID();
    if (kind === 'cart') data.cartId = randomUUID();
    if (kind === 'product') data.productId = randomUUID();
    if (kind === 'transition') data.issuanceTransitionId = randomUUID();
    if (kind === 'epoch') data.reservationExecutionEpoch = 0;
    if (kind === 'incarnation') data.incarnation = randomUUID();
    // Catch the insert itself, before any deferred initial-command check.
    await f.db.$transaction(async tx => {
      await expect(tx.ordinaryReservationOwner.create({ data })).rejects.toThrow();
    });
  });

  it('enforces hold uniqueness across different marker/generation pairs', async () => {
    const a = await activeOrdinary(fixture.db);
    const b = await ordinaryFixture(fixture.db);
    await expect(b.db.ordinaryReservationOwner.create({ data: { ...b.issuance,
      holdInstanceId: a.owner.holdInstanceId } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects duplicate marker/generation independently of hold uniqueness', async () => {
    const f = await ordinaryFixture(fixture.db);
    await f.commands.issue(f.issuance, f.payload);
    await expect(f.db.ordinaryReservationOwner.create({ data: { ...f.issuance,
      holdInstanceId: ordinaryHoldInstanceId(randomUUID(), 0) } })).rejects.toThrow();
  });

  it.each(['markerId', 'generation', 'holdInstanceId', 'customerId', 'cartId', 'productId',
    'incarnation', 'reservationExecutionEpoch', 'issuanceTransitionId', 'createdAt'] as const)
  ('raw SQL cannot rewrite owner %s', async field => {
    const f = await ordinaryFixture(fixture.db);
    const { owner } = await f.commands.issue(f.issuance, f.payload);
    const value = field === 'generation' || field === 'reservationExecutionEpoch' ? '123'
      : field === 'createdAt' ? "now() + interval '1 day'" : "'00000000-0000-5000-8000-000000000001'";
    await expect(f.db.$executeRawUnsafe(`UPDATE ordinary_reservation_owners SET "${field}"=${value} WHERE id=$1::uuid`, owner.id)).rejects.toThrow();
    expect(await f.owners.loadAuthority(owner.id)).toEqual(owner);
  });

  it('requires an issuance command in the owner creation transaction', async () => {
    const f = await ordinaryFixture(fixture.db);
    await expect(f.owners.locked(f.marker.id, context => f.owners.create(context, f.issuance))).rejects.toThrow();
    expect(await f.db.ordinaryReservationOwner.count({ where: { markerId: f.marker.id } })).toBe(0);
  });

  it.each(['ACTIVE', 'CONSUMED', 'SUPERSEDED', 'TRANSFERRED', 'RELEASE_PENDING'] as const)
  ('cannot close or promote ISSUED to %s without durable evidence', async state => {
    const f = await ordinaryFixture(fixture.db);
    const { owner } = await f.commands.issue(f.issuance, f.payload);
    await expect(f.db.ordinaryReservationOwner.update({ where: { id: owner.id }, data: {
      state, closedAt: ['CONSUMED', 'SUPERSEDED'].includes(state) ? new Date() : null,
    } })).rejects.toThrow();
  });

  it('revokes only never-executed issuance and forbids reopening or deletion', async () => {
    const f = await ordinaryFixture(fixture.db);
    const { owner } = await f.commands.issue(f.issuance, f.payload);
    const revoked = await f.owners.revokeNeverExecuted(f.marker.id, owner.id);
    expect(revoked.state).toBe('REVOKED');
    expect(revoked.closedAt).toBeInstanceOf(Date);
    await expect(f.db.ordinaryReservationOwner.update({ where: { id: owner.id }, data: { state: 'ISSUED', closedAt: null } })).rejects.toThrow();
    await expect(f.db.ordinaryReservationOwner.delete({ where: { id: owner.id } })).rejects.toThrow();
  });

  it('will not revoke unresolved dispatched issuance', async () => {
    const f = await ordinaryFixture(fixture.db);
    const { owner } = await f.commands.issue(f.issuance, f.payload);
    await f.commands.promote(f.marker.id);
    await expect(f.owners.revokeNeverExecuted(f.marker.id, owner.id)).rejects.toThrow('ORDINARY_UNRESOLVED_EXECUTION');
  });

  it('parent deletion and key rewrites cannot cascade away authority', async () => {
    const f = await activeOrdinary(fixture.db);
    await expect(f.db.cart.delete({ where: { id: f.cartId } })).rejects.toThrow();
    await expect(f.db.cartReservationSyncState.delete({ where: { id: f.marker.id } })).rejects.toThrow();
    await expect(f.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { id: randomUUID() } })).rejects.toThrow();
    await expect(f.db.reservationFenceTransition.delete({ where: { id: f.transition.id } })).rejects.toThrow();
    expect(await f.owners.loadAuthority(f.owner.id)).toMatchObject({ state: 'ACTIVE' });
  });

  it('transfer linkage is exact, single assignment, and structurally acquired before TRANSFERRED', async () => {
    const f = await transferredOrdinary(fixture.db);
    expect(await f.owners.loadAuthority(f.owner.id)).toMatchObject({ state: 'TRANSFERRED', checkoutManifestId: f.manifest.id });
    await expect(f.db.ordinaryReservationOwner.update({ where: { id: f.owner.id },
      data: { checkoutManifestId: randomUUID() } })).rejects.toThrow();
    await expect(f.db.ordinaryReservationOwner.update({ where: { id: f.owner.id },
      data: { state: 'CONSUMED', closedAt: new Date() } })).rejects.toThrow();
  });

  it('contains no SQL canonical algorithm, physical dependency or counter allocator in triggers', () => {
    const migration = readFileSync(resolve(__dirname, '../../../../prisma/migrations/20260915000000_ordinary_owner_provenance/migration.sql'), 'utf8');
    expect(migration).not.toMatch(/uuid_generate_v5|sha1|FOR UPDATE|UPDATE\s+"?cart_items/i);
    for (const name of ['owner', 'command']) {
      const source = readFileSync(resolve(__dirname, `../repositories/ordinary-reservation-${name}.repository.ts`), 'utf8');
      expect(source).not.toMatch(/ioredis|RedisService|\.eval\(|@Injectable|MAX\s*\(/i);
    }
    expect(Prisma.prismaVersion.client).toBe('6.19.3');
  });
});
