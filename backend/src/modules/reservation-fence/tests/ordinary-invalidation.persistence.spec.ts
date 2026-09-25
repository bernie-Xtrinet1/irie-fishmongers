import { randomUUID } from 'crypto';
import { openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { barrierAcknowledgement, InvalidationRequest } from '../types/ordinary-invalidation.types';
import { transitionTuple } from '../repositories/reservation-fence.repository';

describe('durable invalidation intent/confirmation boundaries', () => {
  jest.setTimeout(120000);
  async function fixture(work: (f: Awaited<ReturnType<typeof ordinaryFixture>>, repo: OrdinaryInvalidationRepository,
    request: InvalidationRequest) => Promise<void>) {
    const schema = await openOrdinarySchema();
    try {
      const f = await ordinaryFixture(schema.db);
      await f.db.ordinaryInvalidationHead.createMany({ data: ['GLOBAL', `MARKER:${f.marker.id}`].map(scope => ({
        scope, incarnation: f.transition.incarnation, epoch: 1 })) });
      const item = await f.db.cartItem.findUnique({ where: { cartId_productId: { cartId: f.cartId, productId: f.productId } } });
      const cart = item ? { id: item.id, mutationVersion: item.mutationVersion, quantity: item.quantity } : null;
      const request: InvalidationRequest = { version: 1, intentId: randomUUID(), operationId: randomUUID(), kind: 'CART',
        incarnation: f.transition.incarnation, epoch: 1, scopes: [{ kind: 'MARKER', markerId: f.marker.id,
          cartId: f.cartId, customerId: f.customerId, productId: f.productId, revision: 0,
          before: { generation: 0, mutationVersion: 0, quantity: 2 },
          after: { generation: 1, mutationVersion: 1, quantity: 3 }, cartBefore: cart, cartAfter: cart,
          ownersBefore: [], ownersAfter: [] }] };
      await work(f, new OrdinaryInvalidationRepository(f.db), request);
    } finally { await schema.close(); }
  }
  it('PREPARED leaves business state unchanged, retains one obligation and rejects bypass', () => fixture(async (f, repo, request) => {
    const before = await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } });
    const first = await repo.prepare(request);
    expect(first.status).toBe('PREPARED');
    expect(await repo.prepare(request)).toEqual(first);
    expect(await repo.discover(10)).toEqual([{ id: request.intentId, status: 'PREPARED' }]);
    expect(await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } })).toEqual(before);
    await expect(f.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 1 } })).rejects.toThrow();
    await expect(f.commands.issue(f.issuance, f.payload)).rejects.toThrow();
    await expect(f.db.ordinaryInvalidationIntent.delete({ where: { id: request.intentId } })).rejects.toThrow();
    expect(await f.db.ordinaryReservationCommand.count()).toBe(0);
  }));
  it('conflicting request identity and overlapping same-scope allocation cannot replace the winner', () => fixture(async (f, repo, request) => {
    const other = { ...request, intentId: randomUUID(), operationId: randomUUID() };
    const results = await Promise.allSettled([repo.prepare(request), repo.prepare(other)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await f.db.ordinaryInvalidationIntent.count()).toBe(1);
    expect(await f.db.ordinaryInvalidationScope.count()).toBe(1);
  }));
  it('overlapping global/marker sets serialize without a partial allocation or a lock upgrade', () => fixture(async (f, repo, request) => {
    const tuple = transitionTuple(f.transition);
    const overlapping: InvalidationRequest = { ...request, intentId: randomUUID(), operationId: randomUUID(), scopes: [
      { kind: 'GLOBAL', revision: 0, before: tuple, after: tuple,
        modeBefore: { mode: 'CART_SCOPED', revision: f.transition.modeRevision }, modeAfter: null }, ...request.scopes,
    ] };
    const results = await Promise.allSettled([repo.prepare(request), repo.prepare(overlapping)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const intents = await f.db.ordinaryInvalidationIntent.findMany();
    expect(intents).toHaveLength(1);
    const global = await f.db.ordinaryInvalidationHead.findUniqueOrThrow({ where: { scope: 'GLOBAL' } });
    expect(global.allocatedRevision).toBe(intents[0]!.id === overlapping.intentId ? 1 : 0);
    expect(await f.db.ordinaryInvalidationScope.count()).toBe(intents[0]!.id === overlapping.intentId ? 2 : 1);
  }));
  it('confirmation binds complete acknowledgement and cannot publish or regress by status alone', () => fixture(async (f, repo, request) => {
    await repo.prepare(request);
    const ack = barrierAcknowledgement(request);
    await expect(repo.confirm(request, { ...ack, digest: '0'.repeat(64) })).rejects.toThrow();
    expect((await repo.confirm(request, ack)).status).toBe('BARRIER_CONFIRMED');
    await expect(f.db.ordinaryInvalidationIntent.update({ where: { id: request.intentId }, data: { status: 'PUBLISHED' } })).rejects.toThrow();
    await expect(f.db.ordinaryInvalidationIntent.update({ where: { id: request.intentId }, data: { status: 'PREPARED' } })).rejects.toThrow();
    await expect(f.db.ordinaryInvalidationScope.update({ where: { intentId_scope: { intentId: request.intentId, scope: `MARKER:${f.marker.id}` } },
      data: { revision: 2 } })).rejects.toThrow();
    await expect(f.db.ordinaryInvalidationHead.update({ where: { scope: `MARKER:${f.marker.id}` }, data: { ready: true } })).rejects.toThrow();
  }));
  it('supersession retains the confirmed predecessor and allocates exactly one higher rejection revision', () => fixture(async (f, repo, request) => {
    await repo.prepare(request);
    const replacement: InvalidationRequest = { ...request, intentId: randomUUID(), operationId: randomUUID(),
      scopes: request.scopes.map(scope => ({ ...scope, revision: 1 })) };
    await expect(repo.supersede(request.intentId, replacement)).rejects.toThrow('CONFIRMED_REPLACEMENT_REQUIRED');
    await repo.confirm(request, barrierAcknowledgement(request));
    await expect(repo.supersede(request.intentId, { ...replacement, scopes: replacement.scopes.map(scope => ({ ...scope, revision: 0 })) }))
      .rejects.toThrow('REPLACEMENT_SCOPE_MISMATCH');
    const result = await repo.supersede(request.intentId, replacement);
    expect(result.status).toBe('PREPARED');
    expect(await repo.supersede(request.intentId, replacement)).toEqual(result);
    expect(await repo.read(request.intentId)).toMatchObject({ status: 'SUPERSEDED', supersededById: result.id });
    expect(await f.db.ordinaryInvalidationHead.findUniqueOrThrow({ where: { scope: `MARKER:${f.marker.id}` } }))
      .toMatchObject({ allocatedRevision: 2, publishedRevision: 0, ready: false, pendingIntentId: result.id });
    await expect(repo.confirm(request, barrierAcknowledgement(request))).rejects.toThrow('INVALIDATION_SUPERSEDED');
  }));
});
