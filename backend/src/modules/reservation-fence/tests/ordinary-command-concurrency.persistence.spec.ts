import { acknowledgement, activeOrdinary, openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';

describe('ordinary journal real PostgreSQL concurrency', () => {
  jest.setTimeout(120000);
  let fixture: Awaited<ReturnType<typeof openOrdinarySchema>>;
  beforeAll(async () => { fixture = await openOrdinarySchema(); });
  afterAll(async () => { if (fixture) await fixture.close(); });

  it('concurrent enqueue serializes marker counter allocation without duplicate ordinals', async () => {
    const f = await activeOrdinary(fixture.db);
    const rows = await Promise.all(Array.from({ length: 8 }, () => f.commands.enqueue(f.marker.id, {
      ...f.payload, ownerId: f.owner.id, sourceOwnerId: f.owner.id, effect: 'W1', w1Transition: 'SAME_GENERATION',
    })));
    expect(rows.map(c => c.queueOrdinal).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } }))
      .toMatchObject({ ordinaryEnqueueSequence: 9, ordinaryCommandSequence: 1, ordinaryAcknowledgedSequence: 1 });
  });

  it('concurrent promotion grants one normal dispatcher, not one per worker', async () => {
    const f = await ordinaryFixture(fixture.db);
    await f.commands.issue(f.issuance, f.payload);
    const rows = await Promise.all(Array.from({ length: 8 }, () => f.commands.promote(f.marker.id)));
    expect(rows.filter(Boolean)).toHaveLength(1);
    expect(await f.db.ordinaryReservationCommand.count({ where: { markerId: f.marker.id, state: 'PENDING' } })).toBe(1);
  });

  it('a failed transaction cannot consume an enqueue allocation observed by another worker', async () => {
    const f = await activeOrdinary(fixture.db);
    const settled = await Promise.allSettled([
      f.commands.enqueue(f.marker.id, { ...f.payload, ownerId: f.owner.id, sourceOwnerId: f.owner.id,
        effect: 'W1', w1Transition: 'SAME_GENERATION', authorizedQuantity: -2 }),
      f.commands.enqueue(f.marker.id, { ...f.payload, ownerId: f.owner.id, sourceOwnerId: f.owner.id,
        effect: 'W1', w1Transition: 'SAME_GENERATION' }),
    ]);
    expect(settled[0].status).toBe('rejected');
    expect(settled[1]).toMatchObject({ status: 'fulfilled', value: { queueOrdinal: 2 } });
  });

  it('duplicate acknowledgements serialize and preserve one receipt/cursor', async () => {
    const f = await ordinaryFixture(fixture.db);
    await f.commands.issue(f.issuance, f.payload);
    const p = await f.commands.promote(f.marker.id);
    const results = await Promise.all(Array.from({ length: 6 }, () => f.commands.acknowledge(f.marker.id, acknowledgement(p!))));
    expect(results.every(c => c.state === 'ACKNOWLEDGED' && c.completionReceiptHash === results[0]!.completionReceiptHash)).toBe(true);
    expect(await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } })).toMatchObject({ ordinaryAcknowledgedSequence: 1 });
  });

  it('cancellation versus execution acknowledgement resolves exactly one durable outcome without deadlock', async () => {
    const f = await ordinaryFixture(fixture.db);
    const { owner, command } = await f.commands.issue(f.issuance, f.payload);
    const original = await f.commands.promote(f.marker.id);
    const cancel = await f.commands.enqueue(f.marker.id, { ownerId: owner.id, effect: 'CANCEL_W1', reason: 'STALE_W1',
      cancelledCommandId: command.id, intentGeneration: 0, expectedMutationVersion: 0 });
    const cancellation = await f.commands.promote(f.marker.id);
    const outcomes = await Promise.allSettled([
      f.commands.acknowledge(f.marker.id, acknowledgement(original!)),
      f.commands.acknowledge(f.marker.id, acknowledgement(cancellation!)),
    ]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await f.db.ordinaryReservationCommand.findMany({ where: { id: { in: [command.id, cancel.id] } } });
    expect(rows.filter(r => r.state === 'ACKNOWLEDGED')).toHaveLength(1);
    expect(rows.some(r => r.state === 'CANCELLED' || r.state === 'REVOKED')).toBe(true);
    for (const outcome of outcomes) if (outcome.status === 'rejected') {
      expect(String(outcome.reason)).toContain('ORDINARY_ACKNOWLEDGEMENT_REJECTED');
      expect(String(outcome.reason)).not.toMatch(/deadlock|40P01/i);
    }
  });

  it('several issued candidates remain exact; simultaneous releases do not guess the live desired generation', async () => {
    const f = await activeOrdinary(fixture.db);
    await f.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 1 } });
    const next = await f.commands.issue({ ...f.issuance, generation: 1 },
      { ...f.payload, intentGeneration: 1, sourceOwnerId: f.owner.id, w1Transition: 'IMMEDIATE_PREDECESSOR' });
    await f.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 2, expectedQuantity: null } });
    const results = await Promise.all([f.owner.id, next.owner.id].map(ownerId => f.commands.enqueue(f.marker.id, {
      ownerId, effect: 'RELEASE', reason: 'CART_REMOVAL', intentGeneration: 2, expectedMutationVersion: 0,
    })));
    expect(new Set(results.map(c => c.ownerId))).toEqual(new Set([f.owner.id, next.owner.id]));
    expect((await f.owners.issuedCandidates(f.marker.id)).map(o => o.generation)).toEqual([0, 1]);
  });

  it('immediate predecessor acknowledgement atomically supersedes only the exact source owner', async () => {
    const f = await activeOrdinary(fixture.db);
    await f.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 1 } });
    const next = await f.commands.issue({ ...f.issuance, generation: 1 },
      { ...f.payload, intentGeneration: 1, sourceOwnerId: f.owner.id, w1Transition: 'IMMEDIATE_PREDECESSOR' });
    const p = await f.commands.promote(f.marker.id);
    await f.commands.acknowledge(f.marker.id, acknowledgement(p!));
    expect(await f.owners.loadAuthority(f.owner.id)).toMatchObject({ state: 'SUPERSEDED' });
    expect(await f.owners.loadAuthority(next.owner.id)).toMatchObject({ state: 'ACTIVE', generation: 1 });
  });

  it('parent deletion racing issuance cannot remove provenance or deadlock exercised paths', async () => {
    const f = await ordinaryFixture(fixture.db);
    const results = await Promise.allSettled([
      f.commands.issue(f.issuance, f.payload),
      f.db.cart.delete({ where: { id: f.cartId } }),
    ]);
    expect(results[1].status).toBe('rejected');
    for (const result of results) if (result.status === 'rejected') expect(String(result.reason)).not.toMatch(/deadlock|40P01/i);
    if (results[0].status === 'rejected') {
      expect(String(results[0].reason)).toMatch(/55P03|could not obtain lock/i);
      expect(await f.db.ordinaryReservationOwner.count({ where: { markerId: f.marker.id } })).toBe(0);
      // Explicit caller retry after the parent transaction ended, same authority.
      await f.commands.issue(f.issuance, f.payload);
    }
    expect(await f.db.ordinaryReservationOwner.count({ where: { markerId: f.marker.id } })).toBe(1);
  });

  it('held FK parent fails closed immediately instead of waiting backward from the marker', async () => {
    const f = await ordinaryFixture(fixture.db);
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>(resolve => { ready = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const parent = f.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM carts WHERE id=${f.cartId} FOR UPDATE`;
      ready();
      await released;
    }, { timeout: 10000 });
    try {
      await held;
      await expect(f.commands.issue(f.issuance, f.payload)).rejects.toThrow(/55P03|could not obtain lock/i);
      expect(await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } }))
        .toMatchObject({ ordinaryEnqueueSequence: 0, ordinaryCommandSequence: 0, ordinaryAcknowledgedSequence: 0 });
      expect(await f.db.ordinaryReservationOwner.count({ where: { markerId: f.marker.id } })).toBe(0);
    } finally { release(); await parent; }
    expect((await f.commands.issue(f.issuance, f.payload)).command.queueOrdinal).toBe(1);
  });
});
