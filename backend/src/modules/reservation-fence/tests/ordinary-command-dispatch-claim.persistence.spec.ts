import { randomUUID } from 'crypto';
import { OrdinaryCommandDispatchClaimRepository } from '../repositories/ordinary-command-dispatch-claim.repository';
import { ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { OrdinaryDispatchIdentity } from '../types/ordinary-command-dispatch-claim.types';
import { acknowledgement, openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';

describe('first-dispatch claim real PostgreSQL', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>>;
  beforeAll(async () => { schema = await openOrdinarySchema(); });
  afterAll(async () => { if (schema) await schema.close(); });
  afterEach(() => jest.restoreAllMocks());

  async function fixture() {
    const f = await ordinaryFixture(schema.db);
    const issued = await f.commands.issue(f.issuance, f.payload);
    const command = await f.commands.promote(f.marker.id);
    if (!command) throw new Error('Missing fixture command');
    const identity: OrdinaryDispatchIdentity = { version: 1, commandId: command.id, replayId: command.replayId,
      action: 'W1', sequence: command.sequence!, expectedSequence: command.expectedSequence!, mutationVersion: 0,
      incarnation: issued.owner.incarnation, epoch: 1, ownerId: issued.owner.id, sourceOwnerId: null,
      target: { customerId: f.customerId, cartId: f.cartId, productId: f.productId, markerId: f.marker.id,
        generation: 0, holdInstanceId: issued.owner.holdInstanceId }, source: null, transition: 'INITIAL', quantity: 2, parent: null };
    const repo = new OrdinaryCommandDispatchClaimRepository(schema.db);
    const snapshot = () => schema.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: command.id } });
    return { ...f, ...issued, command, identity, repo, snapshot };
  }

  it('concurrent independent connections grant exactly once; token is local, non-reconstructable and single-use', async () => {
    const f = await fixture();
    const clients = Array.from({ length: 4 }, () => schema.fresh());
    try {
      const repos = clients.map(db => new OrdinaryCommandDispatchClaimRepository(db));
      const results = await Promise.all(repos.map(repo => repo.claim(f.identity)));
      expect(results.filter(r => r.status === 'FIRST_PHYSICAL_DISPATCH_AUTHORIZED')).toHaveLength(1);
      expect(await f.snapshot()).toMatchObject({ state: 'PENDING', attemptCount: 1, lastDispatchTransitionId: f.transition.id, nextAttemptAt: null });
      const index = results.findIndex(r => r.status === 'FIRST_PHYSICAL_DISPATCH_AUTHORIZED');
      const result = results[index];
      const winner = repos[index];
      if (!result || !winner || result.status !== 'FIRST_PHYSICAL_DISPATCH_AUTHORIZED') throw new Error('Missing grant');
      expect(f.repo.consume(result.claim)).toBeNull();
      expect(winner.consume(structuredClone(result.claim))).toBeNull();
      expect(winner.consume(result.claim)).toEqual(f.identity);
      expect(winner.consume(result.claim)).toBeNull();
      const before = await f.snapshot();
      expect(await f.repo.claim(f.identity)).toEqual({ status: 'NOT_AUTHORIZED' });
      expect(await f.snapshot()).toEqual(before);
    } finally { await Promise.all(clients.map(db => db.$disconnect())); }
  });

  it.each(['rollback', 'commit-response-loss'] as const)('%s leaks no authorization', async fault => {
    const f = await fixture();
    const original = ReservationFenceRepository.prototype.locked.bind(new ReservationFenceRepository(schema.db));
    jest.spyOn(ReservationFenceRepository.prototype, 'locked').mockImplementation(async function (work) {
      if (fault === 'rollback') return original(async tx => { await work(tx); throw new Error('rollback'); });
      await original(work);
      throw new Error('commit response lost');
    });
    expect(await f.repo.claim(f.identity)).toEqual({ status: 'NOT_AUTHORIZED' });
    jest.restoreAllMocks();
    expect((await f.snapshot()).attemptCount).toBe(fault === 'rollback' ? 0 : 1);
    expect((await f.repo.claim(f.identity)).status).toBe(fault === 'rollback' ? 'FIRST_PHYSICAL_DISPATCH_AUTHORIZED' : 'NOT_AUTHORIZED');
  });

  it.each(['commandId', 'replayId', 'ownerId', 'incarnation', 'epoch', 'sequence', 'expectedSequence', 'quantity',
    'customerId', 'cartId', 'productId', 'markerId', 'generation', 'holdInstanceId'] as const)('rejects wrong %s without writes', async key => {
    const f = await fixture(), input = structuredClone(f.identity);
    if (['customerId', 'cartId', 'productId', 'markerId', 'generation', 'holdInstanceId'].includes(key))
      Object.assign(input.target, { [key]: key === 'generation' ? 9 : randomUUID() });
    else Object.assign(input, { [key]: ['epoch', 'sequence', 'expectedSequence', 'quantity'].includes(key) ? 9 : randomUUID() });
    const before = await f.snapshot();
    expect(await f.repo.claim(input)).toEqual({ status: 'NOT_AUTHORIZED' });
    expect(await f.snapshot()).toEqual(before);
  });

  it.each(['uncertain', 'scheduled', 'stale-generation', 'mode-revision', 'frozen', 'incarnation', 'epoch'] as const)(
    'rejects %s without claim writes', async fault => {
      const f = await fixture();
      if (fault === 'uncertain') await schema.db.ordinaryReservationCommand.update({ where: { id: f.command.id }, data: { state: 'UNCERTAIN' } });
      if (fault === 'scheduled') await schema.db.ordinaryReservationCommand.update({ where: { id: f.command.id }, data: { nextAttemptAt: new Date(0) } });
      if (fault === 'stale-generation') await schema.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 1 } });
      if (fault === 'mode-revision') await schema.db.reservationEngineModeConfig.create({ data: { mode: 'CART_SCOPED', updatedById: f.customerId } });
      if (['frozen', 'incarnation', 'epoch'].includes(fault)) {
        const mode = await schema.db.reservationEngineModeConfig.create({ data: { mode: 'CART_SCOPED', updatedById: f.customerId } });
        await schema.db.reservationFenceTransition.create({ data: { revision: mode.revision,
          mode: 'CART_SCOPED', modeRevision: mode.revision, protocol: 1, status: 'ACKNOWLEDGED',
          acknowledgedAt: new Date(), actorId: randomUUID(), reason: 'OPEN',
          phase: fault === 'frozen' ? 'FROZEN' : 'OPEN', incarnation: fault === 'incarnation' ? randomUUID() : f.transition.incarnation,
          epoch: fault === 'epoch' ? 2 : 1 } });
      }
      const before = await f.snapshot();
      expect(await f.repo.claim(f.identity)).toEqual({ status: 'NOT_AUTHORIZED' });
      expect(await f.snapshot()).toEqual(before);
    });

  it.each(['claim-first', 'promotion-first'] as const)('cancellation %s preserves exclusive parent authority', async order => {
    const f = await fixture();
    await f.commands.enqueue(f.marker.id, { ownerId: f.owner.id, effect: 'CANCEL_W1', reason: 'STALE_W1',
      cancelledCommandId: f.command.id, intentGeneration: 0, expectedMutationVersion: 0 });
    if (order === 'claim-first') expect((await f.repo.claim(f.identity)).status).toBe('FIRST_PHYSICAL_DISPATCH_AUTHORIZED');
    const cancel = await f.commands.promote(f.marker.id);
    if (!cancel) throw new Error('Missing cancellation');
    expect(await f.repo.claim(f.identity)).toEqual({ status: 'NOT_AUTHORIZED' });
    const identity: OrdinaryDispatchIdentity = { ...f.identity, commandId: cancel.id, replayId: cancel.replayId, action: 'CANCEL_W1',
      sequence: cancel.sequence!, expectedSequence: cancel.expectedSequence!, transition: null, quantity: null, parent: JSON.stringify(f.identity) };
    expect((await f.repo.claim(identity)).status).toBe('FIRST_PHYSICAL_DISPATCH_AUTHORIZED');
    expect(await f.repo.claim(identity)).toEqual({ status: 'NOT_AUTHORIZED' });
    expect((await f.snapshot()).attemptCount).toBe(order === 'claim-first' ? 1 : 0);
  });

  it('WAITING unresolved work cannot claim or promote itself', async () => {
    const f = await fixture();
    const waiting = await f.commands.enqueue(f.marker.id, { ...f.payload, effect: 'W1', ownerId: f.owner.id, dependsOnCommandId: f.command.id });
    expect(await f.commands.promote(f.marker.id)).toBeNull();
    expect(await f.repo.claim({ ...f.identity, commandId: waiting.id, replayId: waiting.replayId })).toEqual({ status: 'NOT_AUTHORIZED' });
    expect(await schema.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ state: 'WAITING', attemptCount: 0 });
  });

  it('concurrent parent claim and cancellation promotion never grant a second parent dispatch', async () => {
    const f = await fixture();
    await f.commands.enqueue(f.marker.id, { ownerId: f.owner.id, effect: 'CANCEL_W1', reason: 'STALE_W1',
      cancelledCommandId: f.command.id, intentGeneration: 0, expectedMutationVersion: 0 });
    const [claim, cancellation] = await Promise.all([f.repo.claim(f.identity), f.commands.promote(f.marker.id)]);
    expect(cancellation?.effect).toBe('CANCEL_W1');
    expect(await f.snapshot()).toMatchObject({ state: 'REVOCATION_PENDING',
      attemptCount: claim.status === 'FIRST_PHYSICAL_DISPATCH_AUTHORIZED' ? 1 : 0 });
    expect(await f.repo.claim(f.identity)).toEqual({ status: 'NOT_AUTHORIZED' });
  });

  it('legal losing cancellation sequence gaps remain claimable', async () => {
    const f = await fixture();
    await f.commands.enqueue(f.marker.id, { ownerId: f.owner.id, effect: 'CANCEL_W1', reason: 'STALE_W1',
      cancelledCommandId: f.command.id, intentGeneration: 0, expectedMutationVersion: 0 });
    await f.commands.promote(f.marker.id);
    // Structural DB fixture evidence, not physical execution or closure.
    await f.commands.acknowledge(f.marker.id, acknowledgement(f.command));
    await f.commands.enqueue(f.marker.id, { ...f.payload, effect: 'W1', ownerId: f.owner.id, sourceOwnerId: f.owner.id, w1Transition: 'SAME_GENERATION' });
    const next = await f.commands.promote(f.marker.id);
    if (!next) throw new Error('Missing next command');
    expect(next).toMatchObject({ sequence: 3, expectedSequence: 1 });
    expect((await f.repo.claim({ ...f.identity, commandId: next.id, replayId: next.replayId, sequence: 3, expectedSequence: 1,
      sourceOwnerId: f.owner.id, source: f.identity.target, transition: 'SAME_GENERATION' })).status).toBe('FIRST_PHYSICAL_DISPATCH_AUTHORIZED');
  });
});
