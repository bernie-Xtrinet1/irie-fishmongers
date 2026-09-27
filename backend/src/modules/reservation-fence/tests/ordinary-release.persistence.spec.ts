import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { randomUUID } from 'crypto';
import { acknowledgement, openOrdinarySchema, ordinaryReleaseFixture, releaseCompletionObservation } from './ordinary-provenance-test-helpers';
import { OrdinaryCommandClosureService } from '../services/ordinary-command-closure.service';
import { OrdinaryPhysicalResult } from '../types/ordinary-command-physical.types';
import { OrdinaryReleaseService } from '../services/ordinary-release.service';
import { OrdinaryCommandDispatchClaimRepository } from '../repositories/ordinary-command-dispatch-claim.repository';

describe('publication RELEASE persistence', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>>;
  beforeEach(async () => { schema = await openOrdinarySchema(); });
  afterEach(async () => { jest.restoreAllMocks(); if (schema) await schema.close(); });
  it('rejects generic and forged RELEASE completion; verified closure is atomic and historical', async () => {
    const f = await ordinaryReleaseFixture(schema.db); await f.prepare();
    const issuer = new OrdinaryReleaseService(f.db);
    const published = await issuer.publish(f.request.intentId, { ownerId: f.owner.id, reason: 'CART_REMOVAL' }, f.domain);
    if (published.status !== 'PUBLISHED') throw new Error('Publication failed');
    const claims = new OrdinaryCommandDispatchClaimRepository(f.db);
    expect((await claims.claimRelease(published.admission, issuer)).status).toBe('FIRST_PHYSICAL_DISPATCH_AUTHORIZED');
    const command = await f.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: published.command.id } });
    const snapshot = async () => ({
      command: await f.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: command.id } }),
      owner: await f.owners.loadAuthority(f.owner.id),
      marker: await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } }),
    });
    const before = await snapshot();
    await expect(f.commands.acknowledge(f.marker.id, acknowledgement(command))).rejects.toThrow('RELEASE_VERIFIED_COMPLETION_REQUIRED');
    await expect(f.owners.locked(f.marker.id, context => f.commands.acknowledgeLocked(context, acknowledgement(command))))
      .rejects.toThrow('RELEASE_VERIFIED_COMPLETION_REQUIRED');
    await expect(f.owners.locked(f.marker.id, context => f.commands.acknowledgeVerifiedReleaseLocked(context, acknowledgement(command))))
      .rejects.toThrow('RELEASE_VERIFIED_COMPLETION_REQUIRED');
    expect(await snapshot()).toEqual(before);
    expect(before.owner.state).toBe('RELEASE_PENDING');
    expect(before.command.completionReceiptHash).toBeNull();
    const proof = await releaseCompletionObservation(f.db, command.id);
    if (proof.code !== 'COMPLETED') throw new Error('Missing test observation');
    const observe = jest.fn<Promise<OrdinaryPhysicalResult>, [string]>().mockResolvedValue({ ...proof, completionReceiptHash: 'f'.repeat(64) });
    const closure = new OrdinaryCommandClosureService(f.db, { observe });
    expect(await closure.close(command.id)).toEqual({ status: 'UNRESOLVED' });
    expect(await snapshot()).toEqual(before);
    observe.mockResolvedValue(proof);
    const completed = await closure.close(command.id);
    expect(completed).toMatchObject({ status: 'ACKNOWLEDGED', completionReceiptHash: proof.completionReceiptHash });
    const after = await snapshot();
    expect(after.owner.state).toBe('CONSUMED');
    expect(after.marker.ordinaryAcknowledgedSequence).toBe(command.sequence);
    expect(await closure.close(command.id)).toEqual(completed);
    observe.mockResolvedValue({ code: 'REJECTED' });
    expect(await new OrdinaryCommandClosureService(f.db, { observe }).close(command.id)).toEqual(completed);
    expect(await snapshot()).toEqual(after);
    await expect(f.commands.acknowledge(f.marker.id, acknowledgement(command))).rejects.toThrow('RELEASE_VERIFIED_COMPLETION_REQUIRED');
  });
  it('atomically publishes resulting binding and claims only genuine admission once', async () => {
    const f = await ordinaryReleaseFixture(schema.db); await f.prepare();
    const issuer = new OrdinaryReleaseService(f.db), input = { ownerId: f.owner.id, reason: 'CART_REMOVAL' as const };
    const result = await issuer.publish(f.request.intentId, input, f.domain);
    expect(result.status).toBe('PUBLISHED'); if (result.status !== 'PUBLISHED') throw new Error('Publication failed');
    expect(result.command).toMatchObject({ state: 'WAITING', sequence: null, attemptCount: 0 });
    expect(await f.db.ordinaryCommandBarrierBinding.findUniqueOrThrow({ where: { commandId: result.command.id } }))
      .toMatchObject({ markerRevision: 2, globalRevision: 1 });
    expect(await f.owners.loadAuthority(f.owner.id)).toMatchObject({ state: 'RELEASE_PENDING' });
    expect(await issuer.publish(f.request.intentId, input, f.domain)).toEqual({ status: 'UNRESOLVED' });
    const claims = new OrdinaryCommandDispatchClaimRepository(f.db);
    expect(await claims.claimRelease(result.admission, new OrdinaryReleaseService(f.db))).toEqual({ status: 'NOT_AUTHORIZED' });
    expect((await claims.claimRelease(result.admission, issuer)).status).toBe('FIRST_PHYSICAL_DISPATCH_AUTHORIZED');
    expect(await claims.claimRelease(result.admission, issuer)).toEqual({ status: 'NOT_AUTHORIZED' });
    await expect(f.db.ordinaryCommandBarrierBinding.update({ where: { commandId: result.command.id }, data: { markerRevision: 1 } }))
      .rejects.toThrow();
  });
  it.each(['rollback', 'commit-response-loss'] as const)('%s cannot mint or reconstruct admission', async fault => {
    const f = await ordinaryReleaseFixture(schema.db); await f.prepare();
    const original = OrdinaryInvalidationRepository.prototype.locked.bind(f.repo);
    jest.spyOn(OrdinaryInvalidationRepository.prototype, 'locked').mockImplementationOnce(async (request, work) => {
      if (fault === 'rollback') return original(request, async tx => { await work(tx); throw new Error('rollback after insertion'); });
      await original(request, work);
      throw new Error('commit response lost');
    });
    const issuer = new OrdinaryReleaseService(f.db), input = { ownerId: f.owner.id, reason: 'CART_REMOVAL' as const };
    expect(await issuer.publish(f.request.intentId, input, f.domain)).toEqual({ status: 'UNRESOLVED' });
    expect(await f.db.ordinaryReservationCommand.count({ where: { markerId: f.marker.id, effect: 'RELEASE' } }))
      .toBe(fault === 'rollback' ? 0 : 1);
    if (fault === 'commit-response-loss') expect(await new OrdinaryReleaseService(f.db).publish(f.request.intentId, input, f.domain))
      .toEqual({ status: 'UNRESOLVED' });
  });
  it('unresolved W1 cannot be published as an ACTIVE release owner', async () => {
    const f = await ordinaryReleaseFixture(schema.db, false);
    await expect(f.prepare()).rejects.toThrow();
    expect(await f.db.ordinaryReservationCommand.count({ where: { effect: 'RELEASE' } })).toBe(0);
  });
  it('normal insertion remains blocked by PREPARED and raw RELEASE has no publication context', async () => {
    const f = await ordinaryReleaseFixture(schema.db); await f.prepare();
    await expect(f.commands.enqueue(f.marker.id, { ownerId: f.owner.id, effect: 'RELEASE', reason: 'CART_REMOVAL',
      intentGeneration: 1, expectedMutationVersion: 1 })).rejects.toThrow();
    await expect(f.commands.insertPublicationRelease(f.db, f.request.intentId, { ownerId: f.owner.id, reason: 'CART_REMOVAL' }))
      .rejects.toThrow();
    expect(await f.db.ordinaryReservationCommand.count({ where: { effect: 'RELEASE', markerId: f.marker.id } })).toBe(0);
  });
  it.each(['wrong owner', 'wrong intent', 'domain failure', 'post-insertion failure'])('rolls back %s without an obligation or owner transition', async fault => {
    const f = await ordinaryReleaseFixture(schema.db); await f.prepare();
    const issuer = new OrdinaryReleaseService(f.db);
    const result = await issuer.publish(fault === 'wrong intent' ? randomUUID() : f.request.intentId,
      { ownerId: fault === 'wrong owner' ? randomUUID() : f.owner.id, reason: 'CART_REMOVAL' }, async tx => {
        if (fault === 'domain failure') throw new Error('injected');
        const result = await f.domain(tx);
        // Deferred publication after-state must reject this unexpected extra owner change.
        if (fault === 'post-insertion failure') await tx.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 2 } });
        return result;
      });
    expect(result).toEqual({ status: 'UNRESOLVED' });
    expect(await f.owners.loadAuthority(f.owner.id)).toMatchObject({ state: 'ACTIVE' });
    expect(await f.db.ordinaryReservationCommand.count({ where: { effect: 'RELEASE', markerId: f.marker.id } })).toBe(0);
  });
});
