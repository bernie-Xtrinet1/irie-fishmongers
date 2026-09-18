import { createHash, randomUUID } from 'crypto';
import { OrdinaryCommandClosureService } from '../services/ordinary-command-closure.service';
import { OrdinaryPhysicalIdentity, OrdinaryPhysicalResult } from '../types/ordinary-command-physical.types';
import { ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';

describe('closure durable transaction and evidence validation (synthetic observation, no Redis)', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>>;
  beforeAll(async () => { schema = await openOrdinarySchema(); });
  afterAll(async () => { if (schema) await schema.close(); });
  afterEach(() => jest.restoreAllMocks());

  async function fixture() {
    const f = await ordinaryFixture(schema.db);
    const issued = await f.commands.issue(f.issuance, f.payload);
    const command = await f.commands.promote(f.marker.id);
    if (!command) throw new Error('Unassigned fixture');
    const identity: OrdinaryPhysicalIdentity = { version: 1, commandId: command.id, replayId: command.replayId,
      action: 'W1', sequence: command.sequence!, expectedSequence: command.expectedSequence!, mutationVersion: 0,
      incarnation: issued.owner.incarnation, epoch: 1, ownerId: issued.owner.id, sourceOwnerId: null,
      target: { customerId: f.customerId, cartId: f.cartId, productId: f.productId, markerId: f.marker.id,
        generation: 0, holdInstanceId: issued.owner.holdInstanceId }, source: null, transition: 'INITIAL', quantity: 2, parent: null };
    const entry: Record<string, unknown> = { version: 1, status: 'ACTIVE', cartId: f.cartId, customerId: f.customerId,
      markerId: f.marker.id, generation: 0, holdInstanceId: issued.owner.holdInstanceId, reservationExecutionEpoch: 1,
      quantity: 2, reservationMutationId: command.replayId, createdAt: 1, lastRenewedAt: 2, expiresAt: 3, absoluteExpiresAt: 4 };
    const result = (): OrdinaryPhysicalResult => {
      const rawIdentity = JSON.stringify(identity);
      const receipt = JSON.stringify({ version: 1, identity: rawIdentity, action: 'W1', complete: true, result: entry });
      return { code: 'COMPLETED', historical: true, identity: rawIdentity, receipt,
        completionReceiptHash: createHash('sha256').update(receipt).digest('hex') };
    };
    const observe = jest.fn<Promise<OrdinaryPhysicalResult>, [string]>().mockImplementation(() => Promise.resolve(result()));
    const service = new OrdinaryCommandClosureService(schema.db, { observe });
    const snapshot = async () => ({
      marker: await schema.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } }),
      commands: await schema.db.ordinaryReservationCommand.findMany({ where: { markerId: f.marker.id }, orderBy: { queueOrdinal: 'asc' } }),
      owners: await schema.db.ordinaryReservationOwner.findMany({ where: { markerId: f.marker.id }, orderBy: { generation: 'asc' } }),
    });
    return { ...f, ...issued, command, identity, entry, result, observe, service, snapshot };
  }

  it('ACK is atomic and duplicate/concurrent closure preserves one hash and owner activation', async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 6 }, () => f.service.close(f.command.id)));
    expect(results.every(r => r.status === 'ACKNOWLEDGED')).toBe(true);
    expect(results.every(r => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true);
    const before = await f.snapshot();
    expect(before.marker.ordinaryAcknowledgedSequence).toBe(1);
    expect(before.owners[0]?.state).toBe('ACTIVE');
    expect(await f.service.close(f.command.id)).toEqual(results[0]);
    expect(await f.snapshot()).toEqual(before);
  });

  it.each(['commandId', 'replayId', 'ownerId', 'incarnation', 'epoch', 'sequence', 'expectedSequence', 'mutationVersion',
    'quantity', 'generation', 'holdInstanceId', 'customerId', 'cartId', 'productId', 'markerId', 'sourceOwnerId', 'transition',
    'result-quantity', 'result-replay', 'result-owner', 'result-time', 'hash', 'bytes'] as const)(
    'rejects altered %s without durable writes', async fault => {
      const f = await fixture();
      if (['commandId', 'replayId', 'ownerId', 'incarnation'].includes(fault)) Object.assign(f.identity, { [fault]: randomUUID() });
      if (['epoch', 'sequence', 'expectedSequence', 'mutationVersion', 'quantity'].includes(fault)) Object.assign(f.identity, { [fault]: 42 });
      if (['holdInstanceId', 'customerId', 'cartId', 'productId', 'markerId'].includes(fault)) Object.assign(f.identity.target, { [fault]: randomUUID() });
      if (fault === 'generation') f.identity.target.generation = 2;
      if (fault === 'sourceOwnerId') f.identity.sourceOwnerId = randomUUID();
      if (fault === 'transition') f.identity.transition = 'SAME_GENERATION';
      if (fault === 'result-quantity') f.entry.quantity = 99;
      if (fault === 'result-replay') f.entry.reservationMutationId = randomUUID();
      if (fault === 'result-owner') f.entry.checkoutOperationId = randomUUID();
      if (fault === 'result-time') f.entry.expiresAt = 0;
      if (fault === 'hash' || fault === 'bytes') {
        const value = f.result();
        if (value.code !== 'COMPLETED') throw new Error('Missing fixture proof');
        if (fault === 'hash') value.completionReceiptHash = 'b'.repeat(64); else value.receipt += ' ';
        f.observe.mockResolvedValue(value);
      }
      const before = await f.snapshot();
      expect(await f.service.close(f.command.id)).toEqual({ status: 'UNRESOLVED' });
      expect(await f.snapshot()).toEqual(before);
    });

  it('observation outside the closure transaction and restrictive current state permit historical ACK', async () => {
    const f = await fixture();
    await schema.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 1 } });
    const mode = await schema.db.reservationEngineModeConfig.create({ data: { mode: 'DRAINING', updatedById: f.customerId } });
    await schema.db.reservationFenceTransition.create({ data: { incarnation: f.transition.incarnation, epoch: 1,
      revision: mode.revision, phase: 'FROZEN', protocol: 1, mode: 'DRAINING', modeRevision: mode.revision,
      status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), reason: 'RESTRICT', actorId: randomUUID() } });
    const fresh = schema.fresh();
    f.observe.mockImplementation(async () => {
      await fresh.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM cart_reservation_sync_states WHERE id=${f.marker.id} FOR UPDATE NOWAIT`;
      });
      return f.result();
    });
    try { expect((await f.service.close(f.command.id)).status).toBe('ACKNOWLEDGED'); }
    finally { await fresh.$disconnect(); }
  });

  it('missing/transport evidence records uncertainty once, never attempts execution or rearms', async () => {
    const f = await fixture();
    f.observe.mockRejectedValueOnce(new Error('transport')).mockResolvedValue({ code: 'REJECTED' });
    expect(await f.service.close(f.command.id)).toEqual({ status: 'UNRESOLVED' });
    const before = await f.snapshot();
    expect(before.commands[0]).toMatchObject({ state: 'UNCERTAIN', attemptCount: 0, lastDispatchTransitionId: null });
    expect(await f.service.close(f.command.id)).toEqual({ status: 'UNRESOLVED' });
    expect(await f.snapshot()).toEqual(before);
    f.observe.mockImplementation(() => Promise.resolve(f.result()));
    expect((await f.service.close(f.command.id)).status).toBe('ACKNOWLEDGED');
    f.observe.mockResolvedValue({ code: 'REJECTED' });
    const durable = await f.snapshot();
    expect((await f.service.close(f.command.id)).status).toBe('ACKNOWLEDGED');
    expect(await f.snapshot()).toEqual(durable);
  });

  it('ambiguous PostgreSQL commit reloads the exact durable outcome without a second observation', async () => {
    const f = await fixture();
    const original = ReservationFenceRepository.prototype.locked.bind(new ReservationFenceRepository(schema.db));
    jest.spyOn(ReservationFenceRepository.prototype, 'locked').mockImplementationOnce(async function (work) {
      await original(work);
      throw new Error('commit response lost');
    });
    expect((await f.service.close(f.command.id)).status).toBe('ACKNOWLEDGED');
    expect(f.observe).toHaveBeenCalledTimes(1);
    expect((await f.snapshot()).commands[0]?.state).toBe('ACKNOWLEDGED');
  });

  it('terminal ACK cannot be rebound to different valid receipt bytes', async () => {
    const f = await fixture();
    expect((await f.service.close(f.command.id)).status).toBe('ACKNOWLEDGED');
    const before = await f.snapshot();
    f.entry.createdAt = 0;
    expect(await f.service.close(f.command.id)).toEqual({ status: 'UNRESOLVED' });
    expect(await f.snapshot()).toEqual(before);
  });

  it('an unresolved predecessor prevents its WAITING dependent from being acknowledged or promoted', async () => {
    const f = await fixture();
    const dependent = await f.commands.enqueue(f.marker.id, { ...f.payload, ownerId: f.owner.id, sourceOwnerId: f.owner.id,
      effect: 'W1', w1Transition: 'SAME_GENERATION', dependsOnCommandId: f.command.id });
    // A fabricated later receipt cannot supply the missing durable sequence or
    // resolve the predecessor. No journal or physical authority is allocated.
    f.identity.commandId = dependent.id; f.identity.replayId = dependent.replayId;
    f.identity.sequence = 2; f.identity.expectedSequence = 1; f.identity.transition = 'SAME_GENERATION';
    f.identity.sourceOwnerId = f.owner.id; f.identity.source = { ...f.identity.target };
    f.entry.reservationMutationId = dependent.replayId;
    const before = await f.snapshot();
    expect(await f.service.close(dependent.id)).toEqual({ status: 'UNRESOLVED' });
    expect(await f.snapshot()).toEqual(before);
  });

  it('discovery is bounded/keyset ordered and excludes WAITING and terminal work', async () => {
    const f = await fixture();
    await f.commands.enqueue(f.marker.id, { ...f.payload, ownerId: f.owner.id, effect: 'W1' });
    await expect(async () => f.commands.discoverClosure({ limit: 101 })).rejects.toThrow();
    const all: Array<{ markerId: string; sequence: number | null; id: string }> = [];
    let cursor: { markerId: string; sequence: number; id: string } | undefined;
    for (;;) {
      const page = await f.commands.discoverClosure({ limit: 2, cursor });
      expect(page.length).toBeLessThanOrEqual(2);
      expect(page.every(c => ['PENDING', 'UNCERTAIN', 'REVOCATION_PENDING'].includes(c.state))).toBe(true);
      all.push(...page);
      const last = page[page.length - 1];
      if (page.length < 2 || !last || last.sequence === null) break;
      cursor = { markerId: last.markerId, sequence: last.sequence, id: last.id };
    }
    expect(new Set(all.map(c => c.id)).size).toBe(all.length);
    expect(all.some(c => c.id === f.command.id)).toBe(true);
    const sorted = [...all].sort((a, b) => a.markerId.localeCompare(b.markerId) || a.sequence! - b.sequence! || a.id.localeCompare(b.id));
    expect(all.map(c => c.id)).toEqual(sorted.map(c => c.id));
  });
});
