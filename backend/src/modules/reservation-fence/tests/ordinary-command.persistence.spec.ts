import { randomUUID } from 'crypto';
import { OrdinaryReservationCommandRepository } from '../repositories/ordinary-reservation-command.repository';
import { acknowledgement, activeOrdinary, openOrdinarySchema, ordinaryFixture, ordinaryReleaseFixture, releaseCompletionObservation, transferredOrdinary } from './ordinary-provenance-test-helpers';
import { OrdinaryReleaseService } from '../services/ordinary-release.service';
import { OrdinaryCommandClosureService } from '../services/ordinary-command-closure.service';
import { barrierAcknowledgement, InvalidationRequest } from '../types/ordinary-invalidation.types';

describe('ordinary command durable journal (no physical execution)', () => {
  jest.setTimeout(120000);
  let fixture: Awaited<ReturnType<typeof openOrdinarySchema>>;
  beforeAll(async () => { fixture = await openOrdinarySchema(); });
  afterAll(async () => { if (fixture) await fixture.close(); });

  it('composable promotion preserves allocation and rolls back with its owning transaction', async () => {
    const f = await ordinaryFixture(fixture.db);
    const issued = await f.commands.issue(f.issuance, f.payload);
    await expect(f.owners.locked(f.marker.id, async context => {
      expect(await f.commands.promoteLocked(context, issued.command.id)).toMatchObject({ sequence: 1, expectedSequence: 0 });
      throw new Error('rollback probe');
    })).rejects.toThrow('rollback probe');
    expect(await f.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: issued.command.id } }))
      .toMatchObject({ state: 'WAITING', sequence: null });
    expect(await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } }))
      .toMatchObject({ ordinaryCommandSequence: 0 });
    expect(await f.owners.locked(f.marker.id, context => f.commands.promoteLocked(context, issued.command.id)))
      .toMatchObject({ state: 'PENDING', sequence: 1, expectedSequence: 0 });
  });

  it('targeted composable promotion cannot bypass the queue and retains cancellation gaps', async () => {
    const f = await ordinaryFixture(fixture.db);
    const issued = await f.commands.issue(f.issuance, f.payload);
    const second = await f.commands.enqueue(f.marker.id, { ...f.payload, ownerId: issued.owner.id, effect: 'W1' });
    expect(await f.owners.locked(f.marker.id, context => f.commands.promoteLocked(context, second.id))).toBeNull();
    const first = await f.commands.promote(f.marker.id);
    if (!first) throw new Error('Expected first command');
    const cancel = await f.commands.enqueue(f.marker.id, { ownerId: issued.owner.id, effect: 'CANCEL_W1', reason: 'STALE_W1',
      cancelledCommandId: first.id, intentGeneration: 0, expectedMutationVersion: 0 });
    expect(await f.owners.locked(f.marker.id, context => f.commands.promoteLocked(context, cancel.id)))
      .toMatchObject({ sequence: 2, expectedSequence: 0 });
    await f.commands.acknowledge(f.marker.id, acknowledgement(first));
    expect(await f.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: cancel.id } }))
      .toMatchObject({ state: 'REVOKED', sequence: 2 });
    expect(await f.commands.promote(f.marker.id)).toMatchObject({ id: second.id, sequence: 3, expectedSequence: 1 });
  });

  async function competingCommands() {
    const f = await ordinaryFixture(fixture.db);
    const { owner, command } = await f.commands.issue(f.issuance, f.payload);
    const w1 = await f.commands.promote(f.marker.id);
    await f.commands.enqueue(f.marker.id, { ownerId: owner.id, effect: 'CANCEL_W1', reason: 'STALE_W1',
      cancelledCommandId: command.id, intentGeneration: 0, expectedMutationVersion: 0 });
    const cancel = await f.commands.promote(f.marker.id);
    if (!w1 || !cancel) throw new Error('Missing competing fixture commands');
    expect(w1).toMatchObject({ sequence: 1, expectedSequence: 0 });
    expect(cancel).toMatchObject({ sequence: 2, expectedSequence: 0 });
    return { ...f, owner, w1, cancel };
  }

  async function durableSnapshot(f: Awaited<ReturnType<typeof competingCommands>>) {
    return {
      marker: await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } }),
      owner: await f.db.ordinaryReservationOwner.findUniqueOrThrow({ where: { id: f.owner.id } }),
      commands: await f.db.ordinaryReservationCommand.findMany({ where: { markerId: f.marker.id }, orderBy: { queueOrdinal: 'asc' } }),
    };
  }

  it.each(['execution-first', 'cancellation-first'] as const)('direct SQL dual ACK rejects at commit and rolls back all evidence: %s', async order => {
    const f = await competingCommands();
    const before = await durableSnapshot(f);
    expect(before.commands.map(c => c.state)).toEqual(['REVOCATION_PENDING', 'PENDING']);
    let statementsCompleted = false;
    await expect(f.db.$transaction(async tx => {
      for (const id of order === 'execution-first' ? [f.w1.id, f.cancel.id] : [f.cancel.id, f.w1.id]) {
        await tx.$executeRaw`UPDATE ordinary_reservation_commands SET state='ACKNOWLEDGED',
          "completionReceiptHash"=${'d'.repeat(64)}, "acknowledgedAt"=now() WHERE id=${id}::uuid`;
      }
      await tx.$executeRaw`UPDATE cart_reservation_sync_states SET "ordinaryAcknowledgedSequence"=2 WHERE id=${f.marker.id}`;
      await tx.$executeRaw`UPDATE ordinary_reservation_owners SET state='ACTIVE' WHERE id=${f.owner.id}::uuid`;
      statementsCompleted = true;
    })).rejects.toThrow('ordinary acknowledgement predecessor mismatch');
    expect(statementsCompleted).toBe(true); // Deferred commit validation, not an earlier statement failure.
    expect(await durableSnapshot(f)).toEqual(before);
    expect(before.marker.ordinaryAcknowledgedSequence).toBe(0);
    expect(before.owner.state).toBe('ISSUED');
    expect(before.commands.every(c => c.completionReceiptHash === null && c.acknowledgedAt === null)).toBe(true);
  });

  it.each(['execution', 'cancellation'] as const)('direct SQL legal %s winner preserves gaps and permits a later acknowledged edge', async winner => {
    const f = await competingCommands();
    const cursor = winner === 'execution' ? 1 : 2;
    await f.db.$transaction(async tx => {
      const winningId = winner === 'execution' ? f.w1.id : f.cancel.id;
      await tx.$executeRaw`UPDATE ordinary_reservation_commands SET state='ACKNOWLEDGED',
        "completionReceiptHash"=${'d'.repeat(64)}, "acknowledgedAt"=now() WHERE id=${winningId}::uuid`;
      if (winner === 'execution') {
        await tx.$executeRaw`UPDATE ordinary_reservation_commands SET state='REVOKED' WHERE id=${f.cancel.id}::uuid`;
        await tx.$executeRaw`UPDATE ordinary_reservation_owners SET state='ACTIVE' WHERE id=${f.owner.id}::uuid`;
      } else {
        await tx.$executeRaw`UPDATE ordinary_reservation_commands SET state='CANCELLED' WHERE id=${f.w1.id}::uuid`;
      }
      await tx.$executeRaw`UPDATE cart_reservation_sync_states SET "ordinaryAcknowledgedSequence"=${cursor} WHERE id=${f.marker.id}`;
    });
    const after = await durableSnapshot(f);
    expect(after.commands.map(c => c.state)).toEqual(winner === 'execution'
      ? ['ACKNOWLEDGED', 'REVOKED'] : ['CANCELLED', 'ACKNOWLEDGED']);
    expect(after.commands.map(c => c.sequence)).toEqual([1, 2]);
    expect(after.marker).toMatchObject({ ordinaryCommandSequence: 2, ordinaryAcknowledgedSequence: cursor });
    await f.commands.enqueue(f.marker.id, { ...f.payload, ownerId: f.owner.id, sourceOwnerId: f.owner.id,
      effect: 'W1', w1Transition: 'SAME_GENERATION' });
    const later = await f.commands.promote(f.marker.id);
    expect(later).toMatchObject({ sequence: 3, expectedSequence: cursor });
    await f.commands.acknowledge(f.marker.id, acknowledgement(later!));
    expect((await durableSnapshot(f)).marker.ordinaryAcknowledgedSequence).toBe(3);
  });

  it('direct SQL rejects a missing acknowledged predecessor despite matching final aggregate maxima', async () => {
    const f = await competingCommands();
    await f.commands.acknowledge(f.marker.id, acknowledgement(f.w1));
    const next = await f.commands.enqueue(f.marker.id, { ...f.payload, ownerId: f.owner.id,
      sourceOwnerId: f.owner.id, effect: 'W1', w1Transition: 'SAME_GENERATION' });
    const before = await durableSnapshot(f);
    let statementsCompleted = false;
    await expect(f.db.$transaction(async tx => {
      // Sequence 2 is a revoked cancellation, never an acknowledged barrier.
      await tx.$executeRaw`UPDATE cart_reservation_sync_states
        SET "ordinaryAcknowledgedSequence"=2, "ordinaryCommandSequence"=3 WHERE id=${f.marker.id}`;
      await tx.$executeRaw`UPDATE ordinary_reservation_commands
        SET state='PENDING', sequence=3, "expectedSequence"=2 WHERE id=${next.id}::uuid`;
      await tx.$executeRaw`UPDATE ordinary_reservation_commands SET state='ACKNOWLEDGED',
        "completionReceiptHash"=${'e'.repeat(64)}, "acknowledgedAt"=now() WHERE id=${next.id}::uuid`;
      await tx.$executeRaw`UPDATE cart_reservation_sync_states SET "ordinaryAcknowledgedSequence"=3 WHERE id=${f.marker.id}`;
      statementsCompleted = true;
    })).rejects.toThrow('ordinary acknowledgement predecessor mismatch');
    expect(statementsCompleted).toBe(true);
    expect(await durableSnapshot(f)).toEqual(before);
  });

  it('direct SQL execution winner cannot leave its cancellation pending', async () => {
    const f = await competingCommands();
    const before = await durableSnapshot(f);
    await expect(f.db.$transaction(async tx => {
      await tx.$executeRaw`UPDATE ordinary_reservation_commands SET state='ACKNOWLEDGED',
        "completionReceiptHash"=${'d'.repeat(64)}, "acknowledgedAt"=now() WHERE id=${f.w1.id}::uuid`;
      await tx.$executeRaw`UPDATE cart_reservation_sync_states SET "ordinaryAcknowledgedSequence"=1 WHERE id=${f.marker.id}`;
      await tx.$executeRaw`UPDATE ordinary_reservation_owners SET state='ACTIVE' WHERE id=${f.owner.id}::uuid`;
    })).rejects.toThrow('ordinary competing acknowledgement outcome mismatch');
    expect(await durableSnapshot(f)).toEqual(before);
  });

  it('WAITING has queue order but no execution assignment; promotion binds durable predecessor once', async () => {
    const f = await ordinaryFixture(fixture.db);
    const { command } = await f.commands.issue(f.issuance, f.payload);
    expect(command).toMatchObject({ queueOrdinal: 1, sequence: null, expectedSequence: null, state: 'WAITING' });
    const promoted = await f.commands.promote(f.marker.id);
    expect(promoted).toMatchObject({ id: command.id, sequence: 1, expectedSequence: 0, state: 'PENDING' });
    expect(await f.commands.promote(f.marker.id)).toBeNull();
    await expect(f.db.ordinaryReservationCommand.update({ where: { id: command.id }, data: { sequence: 2 } })).rejects.toThrow();
    await expect(f.db.ordinaryReservationCommand.update({ where: { id: command.id }, data: { expectedSequence: 1 } })).rejects.toThrow();
  });

  it.each(['ownerId', 'sourceOwnerId', 'markerId', 'effect', 'reason', 'w1Transition', 'intentGeneration',
    'expectedMutationVersion', 'authorizedQuantity', 'queueOrdinal', 'replayId', 'dependsOnCommandId',
    'cancelledCommandId', 'checkoutManifestId', 'settlementReceiptHash', 'causeTransitionId'] as const)
  ('raw SQL cannot change WAITING semantic field %s', async field => {
    const f = await ordinaryFixture(fixture.db);
    const { command } = await f.commands.issue(f.issuance, f.payload);
    const values: Record<string, string> = { effect: "'RELEASE'", reason: "'RETIREMENT'", w1Transition: "'SAME_GENERATION'",
      intentGeneration: '9', expectedMutationVersion: '9', authorizedQuantity: '9', queueOrdinal: '9',
      settlementReceiptHash: "'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'" };
    const value = values[field] ?? "'00000000-0000-4000-8000-000000000001'";
    await expect(f.db.$executeRawUnsafe(`UPDATE ordinary_reservation_commands SET "${field}"=${value} WHERE id=$1::uuid`, command.id)).rejects.toThrow();
    expect(await f.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: command.id } })).toEqual(command);
  });

  it('chooses the lowest eligible ordinal and preserves blocked dependencies', async () => {
    const f = await activeOrdinary(fixture.db);
    const first = await f.commands.enqueue(f.marker.id, { ...f.payload, ownerId: f.owner.id, sourceOwnerId: f.owner.id,
      effect: 'W1', w1Transition: 'SAME_GENERATION' });
    const second = await f.commands.enqueue(f.marker.id, { ...f.payload, ownerId: f.owner.id, sourceOwnerId: f.owner.id,
      effect: 'W1', w1Transition: 'SAME_GENERATION', dependsOnCommandId: first.id });
    expect(await f.commands.promote(f.marker.id)).toMatchObject({ id: first.id, sequence: 2, expectedSequence: 1 });
    expect(await f.commands.promote(f.marker.id)).toBeNull();
    const p = await f.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: first.id } });
    await f.commands.acknowledge(f.marker.id, acknowledgement(p));
    expect(await f.commands.promote(f.marker.id)).toMatchObject({ id: second.id, sequence: 3, expectedSequence: 2 });
  });

  it('rolls allocation back with a rejected command', async () => {
    const f = await activeOrdinary(fixture.db);
    const before = await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } });
    await expect(f.commands.enqueue(f.marker.id, { ...f.payload, effect: 'W1', ownerId: f.owner.id,
      sourceOwnerId: f.owner.id, w1Transition: 'SAME_GENERATION', authorizedQuantity: -1 })).rejects.toThrow();
    expect(await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } })).toEqual(before);
  });

  it('cancellation priority applies only to its exact unresolved W1 and closes via acknowledged cancellation', async () => {
    const f = await ordinaryFixture(fixture.db);
    const { owner, command } = await f.commands.issue(f.issuance, f.payload);
    await f.commands.promote(f.marker.id);
    const waiting = await f.commands.enqueue(f.marker.id, { ...f.payload, ownerId: owner.id, sourceOwnerId: owner.id,
      effect: 'W1', w1Transition: 'SAME_GENERATION' });
    const cancel = await f.commands.enqueue(f.marker.id, { ownerId: owner.id, effect: 'CANCEL_W1', reason: 'STALE_W1',
      cancelledCommandId: command.id, intentGeneration: 0, expectedMutationVersion: 0 });
    const p = await f.commands.promote(f.marker.id);
    expect(p).toMatchObject({ id: cancel.id, sequence: 2, expectedSequence: 0 });
    expect(await f.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ state: 'WAITING' });
    expect(await f.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({ state: 'REVOCATION_PENDING' });
    await f.commands.acknowledge(f.marker.id, acknowledgement(p!));
    expect(await f.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({ state: 'CANCELLED' });
  });

  it('execution-winning cancellation race revokes only its linked cancellation and retains sequence gap', async () => {
    const f = await ordinaryFixture(fixture.db);
    const { owner, command } = await f.commands.issue(f.issuance, f.payload);
    const original = await f.commands.promote(f.marker.id);
    const cancel = await f.commands.enqueue(f.marker.id, { ownerId: owner.id, effect: 'CANCEL_W1', reason: 'STALE_W1',
      cancelledCommandId: command.id, intentGeneration: 0, expectedMutationVersion: 0 });
    await f.commands.promote(f.marker.id);
    await f.commands.acknowledge(f.marker.id, acknowledgement(original!));
    expect(await f.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: cancel.id } })).toMatchObject({ state: 'REVOKED', sequence: 2 });
    expect(await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } }))
      .toMatchObject({ ordinaryCommandSequence: 2, ordinaryAcknowledgedSequence: 1 });
    const next = await f.commands.enqueue(f.marker.id, { ...f.payload, ownerId: owner.id, sourceOwnerId: owner.id,
      effect: 'W1', w1Transition: 'SAME_GENERATION' });
    expect(await f.commands.promote(f.marker.id)).toMatchObject({ id: next.id, sequence: 3, expectedSequence: 1 });
  });

  it('pending -> uncertain -> pending -> acknowledged is durable and receipt replay is exact', async () => {
    const f = await ordinaryFixture(fixture.db);
    const { command } = await f.commands.issue(f.issuance, f.payload);
    const p = await f.commands.promote(f.marker.id);
    expect(await f.commands.recordDispatch(f.marker.id, command.id, f.transition.id, true, new Date())).toMatchObject({ state: 'UNCERTAIN', attemptCount: 1 });
    expect(await f.commands.recordDispatch(f.marker.id, command.id, f.transition.id, false, null)).toMatchObject({ state: 'PENDING', attemptCount: 2 });
    const ack = acknowledgement(p!);
    const completed = await f.commands.acknowledge(f.marker.id, ack);
    expect(await f.commands.acknowledge(f.marker.id, ack)).toEqual(completed);
    await expect(f.commands.acknowledge(f.marker.id, { ...ack, completionReceiptHash: 'b'.repeat(64) })).rejects.toThrow('ORDINARY_RECEIPT_REBINDING');
    await expect(f.commands.recordDispatch(f.marker.id, command.id, f.transition.id, false, null)).rejects.toThrow();
  });

  it.each(['sequence', 'expectedSequence', 'replayId', 'hash'] as const)('rejects unsupported acknowledgement %s', async field => {
    const f = await ordinaryFixture(fixture.db);
    await f.commands.issue(f.issuance, f.payload);
    const p = await f.commands.promote(f.marker.id);
    const ack = acknowledgement(p!);
    if (field === 'sequence') ack.sequence++;
    if (field === 'expectedSequence') ack.expectedSequence++;
    if (field === 'replayId') ack.replayId = randomUUID();
    if (field === 'hash') ack.completionReceiptHash = 'invalid';
    await expect(f.commands.acknowledge(f.marker.id, ack)).rejects.toThrow();
    expect(await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } })).toMatchObject({ ordinaryAcknowledgedSequence: 0 });
  });

  it.each(['ordinaryEnqueueSequence', 'ordinaryCommandSequence', 'ordinaryAcknowledgedSequence'] as const)
  ('rejects decrease, reset, unsupported advance and integer overflow of %s', async field => {
    const f = await activeOrdinary(fixture.db);
    for (const value of [-1, 0, 2, 2147483648]) {
      await expect(f.db.$executeRawUnsafe(`UPDATE cart_reservation_sync_states SET "${field}"=$1 WHERE id=$2`, value, f.marker.id)).rejects.toThrow();
    }
  });

  it('one permanent release obligation per exact owner, never retargeted from desired generation', async () => {
    const isolated = await openOrdinarySchema();
    try {
    const f = await ordinaryReleaseFixture(isolated.db);
    const scope = f.request.scopes[0];
    if (!scope || scope.kind !== 'MARKER' || !scope.after) throw new Error('Missing marker scope');
    scope.after.generation = 5;
    scope.after.mutationVersion = 0;
    await f.prepare();
    const payload = { ownerId: f.owner.id, effect: 'RELEASE', reason: 'CART_REMOVAL', intentGeneration: 5, expectedMutationVersion: 0 } as const;
    const published = await new OrdinaryReleaseService(f.db).publish(f.request.intentId, payload, async tx => {
      await tx.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 5, expectedQuantity: null } });
      return {};
    });
    if (published.status !== 'PUBLISHED') throw new Error('Missing publication');
    const c = published.command;
    await expect(f.commands.enqueue(f.marker.id, payload)).rejects.toThrow();
    expect(c.ownerId).toBe(f.owner.id);
    const p = await f.commands.promote(f.marker.id);
    if (!p) throw new Error('Missing release');
    const observation = await releaseCompletionObservation(f.db, p.id);
    expect((await new OrdinaryCommandClosureService(f.db, { observe: () => Promise.resolve(observation) }).close(p.id)).status)
      .toBe('ACKNOWLEDGED');
    expect(await f.owners.loadAuthority(f.owner.id)).toMatchObject({ state: 'CONSUMED', generation: 0 });
    await expect(f.db.ordinaryReservationCommand.update({ where: { id: c.id }, data: { state: 'PENDING' } })).rejects.toThrow();
    await expect(f.db.ordinaryReservationCommand.delete({ where: { id: c.id } })).rejects.toThrow();
    } finally { await isolated.close(); }
  });

  it('bridge is exact to transferred owner and terminal manifest; duplicates and wrong receipts fail', async () => {
    const f = await transferredOrdinary(fixture.db);
    const payload = { ownerId: f.owner.id, effect: 'CHECKOUT_COMPLETE', reason: 'CHECKOUT_SETTLED',
      checkoutManifestId: f.manifest.id, settlementReceiptHash: 'b'.repeat(64), intentGeneration: 0, expectedMutationVersion: 0 } as const;
    await expect(f.commands.enqueue(f.marker.id, { ...payload, settlementReceiptHash: 'c'.repeat(64) })).rejects.toThrow();
    await expect(f.commands.enqueue(f.marker.id, { ...payload, checkoutManifestId: randomUUID() })).rejects.toThrow();
    await f.commands.enqueue(f.marker.id, payload);
    await expect(f.commands.enqueue(f.marker.id, payload)).rejects.toThrow();
    const p = await f.commands.promote(f.marker.id);
    await f.commands.acknowledge(f.marker.id, acknowledgement(p!));
    expect(await f.owners.loadAuthority(f.owner.id)).toMatchObject({ state: 'CONSUMED' });
  });

  it('unlinked owner cannot adopt another historical terminal manifest', async () => {
    const historical = await transferredOrdinary(fixture.db);
    const f = await activeOrdinary(fixture.db);
    await expect(f.commands.enqueue(f.marker.id, { ownerId: f.owner.id, effect: 'CHECKOUT_COMPLETE', reason: 'CHECKOUT_SETTLED',
      checkoutManifestId: historical.manifest.id, settlementReceiptHash: 'b'.repeat(64), intentGeneration: 0, expectedMutationVersion: 0 })).rejects.toThrow();
  });

  it('cross-marker dependencies and cancellation targets are rejected without consuming allocation', async () => {
    const a = await activeOrdinary(fixture.db);
    const b = await activeOrdinary(fixture.db);
    await expect(a.commands.enqueue(a.marker.id, { ...a.payload, ownerId: a.owner.id, effect: 'W1',
      sourceOwnerId: a.owner.id, w1Transition: 'SAME_GENERATION', dependsOnCommandId: b.command.id })).rejects.toThrow();
    await expect(a.commands.enqueue(a.marker.id, { ownerId: a.owner.id, effect: 'CANCEL_W1', reason: 'STALE_W1',
      cancelledCommandId: b.command.id, intentGeneration: 0, expectedMutationVersion: 0 })).rejects.toThrow();
  });

  it('restart reconstructs pending queue and counters from PostgreSQL alone', async () => {
    const f = await ordinaryFixture(fixture.db);
    await f.commands.issue(f.issuance, f.payload);
    await f.commands.promote(f.marker.id);
    const expected = await f.commands.pending(f.marker.id);
    const fresh = fixture.fresh();
    try {
      expect(await new OrdinaryReservationCommandRepository(fresh).pending(f.marker.id)).toEqual(expected);
      expect(await fresh.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } }))
        .toMatchObject({ ordinaryEnqueueSequence: 1, ordinaryCommandSequence: 1, ordinaryAcknowledgedSequence: 0 });
    } finally { await fresh.$disconnect(); }
  });

  it('uncertain acknowledgement and uncertain cancellation preserve the legal state edges', async () => {
    const f = await ordinaryFixture(fixture.db);
    const { owner, command } = await f.commands.issue(f.issuance, f.payload);
    const p = await f.commands.promote(f.marker.id);
    await f.commands.recordDispatch(f.marker.id, command.id, f.transition.id, true, null);
    await f.commands.acknowledge(f.marker.id, acknowledgement(p!));
    const c = await f.commands.enqueue(f.marker.id, { ...f.payload, effect: 'W1', ownerId: owner.id,
      sourceOwnerId: owner.id, w1Transition: 'SAME_GENERATION' });
    await f.commands.promote(f.marker.id);
    await f.commands.recordDispatch(f.marker.id, c.id, f.transition.id, true, null);
    await f.commands.enqueue(f.marker.id, { effect: 'CANCEL_W1', reason: 'STALE_W1', ownerId: owner.id,
      cancelledCommandId: c.id, intentGeneration: 0, expectedMutationVersion: 0 });
    const cancel = await f.commands.promote(f.marker.id);
    expect(await f.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ state: 'REVOCATION_PENDING' });
    await f.commands.acknowledge(f.marker.id, acknowledgement(cancel!));
  });

  it('requires acknowledged evidence fields even through raw SQL and cannot revoke release work', async () => {
    const f = await activeOrdinary(fixture.db);
    await f.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { expectedQuantity: null } });
    const release = await f.commands.enqueue(f.marker.id, { ownerId: f.owner.id, effect: 'RELEASE', reason: 'CART_REMOVAL',
      intentGeneration: 0, expectedMutationVersion: 0 });
    await expect(f.db.ordinaryReservationCommand.update({ where: { id: release.id }, data: { state: 'REVOKED' } })).rejects.toThrow();
    await f.commands.promote(f.marker.id);
    await expect(f.db.$executeRaw`UPDATE ordinary_reservation_commands SET state='ACKNOWLEDGED' WHERE id=${release.id}::uuid`).rejects.toThrow();
    await expect(f.db.ordinaryReservationCommand.update({ where: { id: release.id }, data: { state: 'REVOCATION_PENDING' } })).rejects.toThrow();
  });

  it('AFTER_CONSUMPTION requires exact durable consumed source and does not reuse its lifetime', async () => {
    const isolated = await openOrdinarySchema();
    try {
    const f = await ordinaryReleaseFixture(isolated.db);
    await f.prepare();
    const result = await new OrdinaryReleaseService(f.db).publish(f.request.intentId,
      { ownerId: f.owner.id, reason: 'CART_REMOVAL' }, f.domain);
    if (result.status !== 'PUBLISHED') throw new Error('Missing release publication');
    const release = await f.commands.promote(f.marker.id);
    if (!release) throw new Error('Missing release');
    const observation = await releaseCompletionObservation(f.db, release.id);
    expect((await new OrdinaryCommandClosureService(f.db, { observe: () => Promise.resolve(observation) }).close(release.id)).status)
      .toBe('ACKNOWLEDGED');
    const scope = f.request.scopes[0];
    if (!scope || scope.kind !== 'MARKER' || !scope.after) throw new Error('Missing marker scope');
    const next: InvalidationRequest = { ...f.request, intentId: randomUUID(), operationId: randomUUID(), kind: 'CART', scopes: [{ ...scope,
      revision: 2, before: scope.after, after: { generation: 3, mutationVersion: 1, quantity: 2 },
      ownersBefore: [{ id: f.owner.id, state: 'CONSUMED' }], ownersAfter: [{ id: f.owner.id, state: 'CONSUMED' }] }] };
    await f.repo.prepare(next); await f.repo.confirm(next, barrierAcknowledgement(next));
    await f.publication.publish(next.intentId, async tx => {
      await tx.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 3, expectedQuantity: 2 } });
      return {};
    });
    await f.db.ordinaryInvalidationHead.updateMany({ data: { ready: true } });
    const later = await f.commands.issue({ ...f.issuance, generation: 3 }, { ...f.payload, intentGeneration: 3,
      expectedMutationVersion: 1, w1Transition: 'AFTER_CONSUMPTION', sourceOwnerId: f.owner.id });
    expect(later.owner.holdInstanceId).not.toBe(f.owner.holdInstanceId);
    expect(await f.commands.promote(f.marker.id)).toMatchObject({ id: later.command.id, expectedSequence: 2 });
    } finally { await isolated.close(); }
  });

  it('live predecessor cannot be skipped or relabelled AFTER_CONSUMPTION', async () => {
    const f = await activeOrdinary(fixture.db);
    await f.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 2 } });
    for (const w1Transition of ['IMMEDIATE_PREDECESSOR', 'AFTER_CONSUMPTION'] as const) {
      await expect(f.commands.issue({ ...f.issuance, generation: 2 }, { ...f.payload,
        intentGeneration: 2, sourceOwnerId: f.owner.id, w1Transition })).rejects.toThrow();
    }
    expect(await f.owners.issuedCandidates(f.marker.id)).toHaveLength(1);
  });

  it('release must bind observed absence intent or exact acknowledged retirement, not a caller reason alone', async () => {
    const f = await activeOrdinary(fixture.db);
    const payload = { ownerId: f.owner.id, effect: 'RELEASE', reason: 'CART_REMOVAL',
      intentGeneration: 0, expectedMutationVersion: 0 } as const;
    await expect(f.commands.enqueue(f.marker.id, payload)).rejects.toThrow('ordinary release intent rejected');
    await expect(f.commands.enqueue(f.marker.id, { ...payload, reason: 'RETIREMENT', causeTransitionId: f.transition.id }))
      .rejects.toThrow('ordinary release intent rejected');
    await f.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 1, expectedQuantity: null } });
    await expect(f.commands.enqueue(f.marker.id, payload)).rejects.toThrow('ordinary release intent rejected');
    await expect(f.commands.enqueue(f.marker.id, { ...payload, intentGeneration: 1, expectedMutationVersion: 3 })).rejects.toThrow();
    expect((await f.commands.enqueue(f.marker.id, { ...payload, intentGeneration: 1 })).queueOrdinal).toBe(2);
  });
});
