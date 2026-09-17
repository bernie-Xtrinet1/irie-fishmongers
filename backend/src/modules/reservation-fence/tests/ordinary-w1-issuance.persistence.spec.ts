import { randomUUID } from 'crypto';
import { OrdinaryW1Intent, OrdinaryW1IssuanceService } from '../services/ordinary-w1-issuance.service';
import { OrdinaryReservationCommandRepository } from '../repositories/ordinary-reservation-command.repository';
import { acknowledgement, openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';

describe('durable W1 Stage A (PostgreSQL only)', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>>;
  beforeAll(async () => { schema = await openOrdinarySchema(); });
  afterAll(async () => { if (schema) await schema.close(); });
  async function setup() {
    const f = await ordinaryFixture(schema.db);
    const service = new OrdinaryW1IssuanceService(schema.db);
    const intent: OrdinaryW1Intent = { markerId: f.marker.id, cartId: f.cartId, customerId: f.customerId,
      productId: f.productId, generation: 0, mutationVersion: 0, quantity: 2 };
    return { ...f, service, intent };
  }
  async function snapshot(f: Awaited<ReturnType<typeof setup>>) {
    return { marker: await schema.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } }),
      owners: await schema.db.ordinaryReservationOwner.findMany({ where: { markerId: f.marker.id } }),
      commands: await schema.db.ordinaryReservationCommand.findMany({ where: { markerId: f.marker.id }, orderBy: { queueOrdinal: 'asc' } }) };
  }
  async function active(f: Awaited<ReturnType<typeof setup>>) {
    const result = await f.service.issue(f.intent);
    if (result.status !== 'PENDING') throw new Error('Expected pending authority');
    await f.commands.acknowledge(f.marker.id, acknowledgement(result.command));
    return result.command;
  }

  it('commits initial owner, command and counters before returning; exact retries allocate nothing', async () => {
    const f = await setup();
    const result = await f.service.issue(f.intent);
    expect(result.status).toBe('PENDING');
    const before = await snapshot(f);
    expect(before.owners).toHaveLength(1);
    expect(before.commands).toHaveLength(1);
    expect(before.commands[0]).toMatchObject({ sequence: 1, expectedSequence: 0, queueOrdinal: 1 });
    expect(before.marker).toMatchObject({ ordinaryProvenanceState: 'TRACKED', ordinaryCommandSequence: 1, ordinaryEnqueueSequence: 1 });
    expect(await f.service.issue(f.intent)).toEqual(result);
    expect(await snapshot(f)).toEqual(before);
  });

  it('concurrent same-intent calls and a fresh client converge to one authority', async () => {
    const f = await setup();
    const results = await Promise.all([f.service.issue(f.intent), f.service.issue(f.intent), f.service.issue(f.intent)]);
    expect(results[0].status).toBe('PENDING');
    expect(results).toEqual([results[0], results[0], results[0]]);
    const fresh = schema.fresh();
    try { expect(await new OrdinaryW1IssuanceService(fresh).issue(f.intent)).toEqual(results[0]); }
    finally { await fresh.$disconnect(); }
    expect((await snapshot(f)).commands).toHaveLength(1);
  });

  it.each(['generation', 'mutationVersion', 'quantity', 'customerId', 'cartId', 'productId'] as const)(
    'rejects stale or contradictory %s without writes', async field => {
      const f = await setup();
      const before = await snapshot(f);
      const invalid = { ...f.intent, [field]: typeof f.intent[field] === 'number' ? 3 : randomUUID() };
      expect((await f.service.issue(invalid)).status).toBe('DENIED');
      expect(await snapshot(f)).toEqual(before);
    });

  it('rejects historical default markers without promotion', async () => {
    const f = await setup();
    await schema.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { ordinaryProvenanceState: 'HISTORICAL_UNVERIFIED' } });
    const before = await snapshot(f);
    expect((await f.service.issue(f.intent)).status).toBe('DENIED');
    expect(await snapshot(f)).toEqual(before);
  });

  it('reuses UNCERTAIN without dispatch or new allocation', async () => {
    const f = await setup();
    const result = await f.service.issue(f.intent);
    if (result.status !== 'PENDING') throw new Error('Expected pending');
    await f.commands.recordDispatch(f.marker.id, result.command.id, f.transition.id, true, null);
    const before = await snapshot(f);
    expect((await f.service.issue(f.intent)).status).toBe('UNCERTAIN');
    expect(await snapshot(f)).toEqual(before);
  });

  it('ACK replay is historical and never asserts liveness or renews', async () => {
    const f = await setup();
    const command = await active(f);
    const before = await snapshot(f);
    const result = await f.service.issue(f.intent);
    expect(result).toMatchObject({ status: 'ACKNOWLEDGED', historical: true, command: { id: command.id } });
    expect(result).not.toHaveProperty('active');
    expect(await snapshot(f)).toEqual(before);
  });

  it('captures exact N to N+1 and the acknowledged predecessor', async () => {
    const f = await setup();
    const previous = await active(f);
    await schema.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: {
      generation: 1, expectedMutationVersion: 1, expectedQuantity: 3 } });
    const intent = { ...f.intent, generation: 1, mutationVersion: 1, quantity: 3 };
    const result = await f.service.issue(intent);
    expect(result).toMatchObject({ status: 'PENDING', command: { sourceOwnerId: previous.ownerId,
      w1Transition: 'IMMEDIATE_PREDECESSOR', sequence: 2, expectedSequence: 1, authorizedQuantity: 3 } });
    expect(await f.service.issue(intent)).toEqual(result);
  });

  it.each([1, 2])('rejects unresolved predecessor or skipped generation %s', async generation => {
    const f = await setup();
    if (generation === 1) await f.service.issue(f.intent); else await active(f);
    await schema.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation, expectedMutationVersion: 1 } });
    const before = await snapshot(f);
    expect((await f.service.issue({ ...f.intent, generation, mutationVersion: 1 })).status).toBe('DENIED');
    expect(await snapshot(f)).toEqual(before);
  });

  it('fails closed on multiple durable claims of the same intent', async () => {
    const f = await setup();
    const first = await f.commands.issue(f.issuance, f.payload);
    await f.commands.enqueue(f.marker.id, { ...f.payload, ownerId: first.owner.id, effect: 'W1' });
    const before = await snapshot(f);
    expect((await f.service.issue(f.intent)).status).toBe('DENIED');
    expect(await snapshot(f)).toEqual(before);
  });

  it('does not revive a revoked exact command', async () => {
    const f = await setup();
    const first = await f.commands.issue(f.issuance, f.payload);
    await f.owners.revokeNeverExecuted(f.marker.id, first.owner.id);
    const before = await snapshot(f);
    expect((await f.service.issue(f.intent)).status).toBe('DENIED');
    expect(await snapshot(f)).toEqual(before);
  });

  it('rejects contradictory quantity at the same generation/version instead of allocating a new intent', async () => {
    const f = await setup();
    await f.service.issue(f.intent);
    await schema.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { expectedQuantity: 3 } });
    const before = await snapshot(f);
    expect((await f.service.issue({ ...f.intent, quantity: 3 })).status).toBe('DENIED');
    expect(await snapshot(f)).toEqual(before);
  });

  it('rolls back owner, command, provenance and counters if promotion fails after insertion', async () => {
    const f = await setup();
    const before = await snapshot(f);
    const promotion = jest.spyOn(OrdinaryReservationCommandRepository.prototype, 'promoteLocked')
      .mockRejectedValueOnce(new Error('failure after insert'));
    try { expect((await f.service.issue(f.intent)).status).toBe('DENIED'); }
    finally { promotion.mockRestore(); }
    expect(await snapshot(f)).toEqual(before);
  });

  it('reuses WAITING behind an earlier command, then promotes using the same durable identity', async () => {
    const f = await setup();
    const first = await active(f);
    const earlier = await f.commands.enqueue(f.marker.id, { ...f.payload, ownerId: first.ownerId, sourceOwnerId: first.ownerId,
      effect: 'W1', w1Transition: 'SAME_GENERATION' });
    await schema.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { expectedMutationVersion: 1 } });
    const intent = { ...f.intent, mutationVersion: 1 };
    const waiting = await f.service.issue(intent);
    expect(waiting).toMatchObject({ status: 'WAITING', command: { sequence: null } });
    const before = await snapshot(f);
    expect(await f.service.issue(intent)).toEqual(waiting);
    expect(await snapshot(f)).toEqual(before);
    const promoted = await f.commands.promote(f.marker.id);
    if (!promoted || promoted.id !== earlier.id) throw new Error('Queue ordering failed');
    await f.commands.acknowledge(f.marker.id, acknowledgement(promoted));
    const pending = await f.service.issue(intent);
    expect(pending).toMatchObject({ status: 'PENDING', command: { sequence: 3, expectedSequence: 2 } });
    if (waiting.status === 'DENIED' || pending.status === 'DENIED') throw new Error('Missing durable identity');
    expect(pending.command.id).toBe(waiting.command.id);
  });

  it.each(['DRAINING', 'FROZEN', 'RETIRED', 'UNACKNOWLEDGED', 'MODE_MISMATCH', 'INCARNATION', 'EPOCH'] as const)(
    'rejects %s without replacing existing authority', async kind => {
      const f = await setup();
      await f.service.issue(f.intent);
      const phase = kind === 'DRAINING' || kind === 'FROZEN' || kind === 'RETIRED' ? kind : 'OPEN';
      const mode = await schema.db.reservationEngineModeConfig.create({ data: { mode: 'CART_SCOPED', updatedById: f.customerId } });
      await schema.db.reservationFenceTransition.create({ data: { incarnation: kind === 'INCARNATION' ? randomUUID() : f.transition.incarnation,
        epoch: kind === 'EPOCH' ? 2 : 1, revision: mode.revision, phase, protocol: 1,
        mode: 'CART_SCOPED', modeRevision: kind === 'MODE_MISMATCH' ? mode.revision + 1 : mode.revision,
        status: kind === 'UNACKNOWLEDGED' ? 'PREPARED' : 'ACKNOWLEDGED',
        acknowledgedAt: kind === 'UNACKNOWLEDGED' ? null : new Date(), reason: 'RESTRICT', actorId: randomUUID() } });
      const before = await snapshot(f);
      expect((await f.service.issue(f.intent)).status).toBe('DENIED');
      expect(await snapshot(f)).toEqual(before);
    });

  it('does not bypass cancellation or reissue the losing terminal intent', async () => {
    const f = await setup();
    const first = await f.service.issue(f.intent);
    if (first.status !== 'PENDING') throw new Error('Expected pending');
    await f.commands.enqueue(f.marker.id, { ownerId: first.command.ownerId, effect: 'CANCEL_W1', reason: 'STALE_W1',
      cancelledCommandId: first.command.id, intentGeneration: 0, expectedMutationVersion: 0 });
    const cancel = await f.commands.promote(f.marker.id);
    if (!cancel) throw new Error('Expected cancellation');
    expect((await f.service.issue(f.intent)).status).toBe('DENIED');
    await f.commands.acknowledge(f.marker.id, acknowledgement(cancel));
    const before = await snapshot(f);
    expect((await f.service.issue(f.intent)).status).toBe('DENIED');
    expect(await snapshot(f)).toEqual(before);
  });
});
