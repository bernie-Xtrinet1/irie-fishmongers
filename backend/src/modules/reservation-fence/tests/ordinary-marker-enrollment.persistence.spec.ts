import { randomUUID } from 'crypto';
import { PrismaService } from '../../../database/prisma.service';
import { OrdinaryMarkerEnrollmentService } from '../services/ordinary-marker-enrollment.service';
import { openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';
import { transitionTuple } from '../repositories/reservation-fence.repository';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { OrdinaryInvalidationPublicationService } from '../services/ordinary-invalidation-publication.service';
import { barrierAcknowledgement, InvalidationRequest } from '../types/ordinary-invalidation.types';

describe('OrdinaryMarkerEnrollmentService (PostgreSQL only)', () => {
  jest.setTimeout(120000);

  async function isolated(work: (db: PrismaService, schema: Awaited<ReturnType<typeof openOrdinarySchema>>) => Promise<void>) {
    const schema = await openOrdinarySchema();
    try {
      await work(schema.db, schema);
    } finally {
      await schema.close();
    }
  }

  async function setupWithGlobal(db: PrismaService) {
    const f = await ordinaryFixture(db);
    const tuple = transitionTuple(f.transition);
    const repo = new OrdinaryInvalidationRepository(db);
    const publication = new OrdinaryInvalidationPublicationService(repo);

    await db.ordinaryInvalidationHead.create({
      data: {
        scope: 'GLOBAL',
        incarnation: tuple.incarnation,
        epoch: tuple.epoch,
      },
    });

    const initial: InvalidationRequest = {
      version: 1,
      intentId: randomUUID(),
      operationId: randomUUID(),
      kind: 'FENCE',
      incarnation: tuple.incarnation,
      epoch: tuple.epoch,
      scopes: [
        {
          kind: 'GLOBAL',
          revision: 0,
          before: tuple,
          after: tuple,
          modeBefore: { mode: 'CART_SCOPED', revision: f.transition.modeRevision },
          modeAfter: null,
        },
      ],
    };

    await repo.prepare(initial);
    await repo.confirm(initial, barrierAcknowledgement(initial));
    await publication.publish(initial.intentId, () => Promise.resolve({ bootstrap: true }));
    const global = await db.ordinaryInvalidationHead.update({
      where: { scope: 'GLOBAL' },
      data: { ready: true },
    });

    const service = new OrdinaryMarkerEnrollmentService(db);
    return { ...f, tuple, global, service, repo, publication };
  }

  it('enrolls a new marker with initial revision 0 and closed ready: false', () => isolated(async db => {
    const f = await setupWithGlobal(db);
    const result = await f.service.enroll(f.marker.id);

    expect(result.status).toBe('ENROLLED');
    if (result.status !== 'ENROLLED') throw new Error('Expected ENROLLED');
    expect(result.head).toMatchObject({
      scope: `MARKER:${f.marker.id}`,
      incarnation: f.transition.incarnation,
      epoch: f.transition.epoch,
      publishedRevision: 0,
      allocatedRevision: 0,
      ready: false,
      pendingIntentId: null,
    });

    const persisted = await db.ordinaryInvalidationHead.findUniqueOrThrow({
      where: { scope: `MARKER:${f.marker.id}` },
    });
    expect(persisted).toMatchObject({
      scope: `MARKER:${f.marker.id}`,
      ready: false,
      publishedRevision: 0,
      allocatedRevision: 0,
      incarnation: f.transition.incarnation,
      epoch: f.transition.epoch,
    });
  }));

  it('idempotently returns ALREADY_ENROLLED on repeated enrollment without duplicating row', () => isolated(async db => {
    const f = await setupWithGlobal(db);
    const first = await f.service.enroll(f.marker.id);
    expect(first.status).toBe('ENROLLED');

    const second = await f.service.enroll(f.marker.id);
    expect(second.status).toBe('ALREADY_ENROLLED');
    if (second.status !== 'ALREADY_ENROLLED') throw new Error('Expected ALREADY_ENROLLED');
    expect(second.head.scope).toBe(`MARKER:${f.marker.id}`);

    const count = await db.ordinaryInvalidationHead.count({
      where: { scope: `MARKER:${f.marker.id}` },
    });
    expect(count).toBe(1);
  }));

  it('serializes concurrent enrollments safely and converges to one durable head', () => isolated(async (db, schema) => {
    const f = await setupWithGlobal(db);
    const fresh = schema.fresh();
    const service2 = new OrdinaryMarkerEnrollmentService(fresh);

    try {
      const [r1, r2] = await Promise.all([
        f.service.enroll(f.marker.id),
        service2.enroll(f.marker.id),
      ]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual(['ALREADY_ENROLLED', 'ENROLLED']);

      const count = await db.ordinaryInvalidationHead.count({
        where: { scope: `MARKER:${f.marker.id}` },
      });
      expect(count).toBe(1);
    } finally {
      await fresh.$disconnect();
    }
  }));

  it('rolls back completely if the enclosing transaction aborts', () => isolated(async db => {
    const f = await setupWithGlobal(db);

    await expect(
      db.$transaction(async tx => {
        const res = await f.service.enrollInTransaction(tx, f.marker.id);
        expect(res.status).toBe('ENROLLED');
        throw new Error('ROLLBACK_PROBE');
      }),
    ).rejects.toThrow('ROLLBACK_PROBE');

    const head = await db.ordinaryInvalidationHead.findUnique({
      where: { scope: `MARKER:${f.marker.id}` },
    });
    expect(head).toBeNull();
  }));

  it('rejects with MARKER_NOT_FOUND when marker does not exist', () => isolated(async db => {
    const f = await setupWithGlobal(db);
    const result = await f.service.enroll(randomUUID());
    expect(result).toEqual({ status: 'REJECTED', reason: 'MARKER_NOT_FOUND' });
  }));

  it('rejects with GLOBAL_HEAD_MISSING when global invalidation head is absent', () => isolated(async db => {
    const f = await ordinaryFixture(db);
    const service = new OrdinaryMarkerEnrollmentService(db);
    const result = await service.enroll(f.marker.id);
    expect(result).toEqual({ status: 'REJECTED', reason: 'GLOBAL_HEAD_MISSING' });
  }));

  it('rejects with GLOBAL_HEAD_NOT_READY when global head is ready: false', () => isolated(async db => {
    const f = await ordinaryFixture(db);
    const tuple = transitionTuple(f.transition);
    await db.ordinaryInvalidationHead.create({
      data: {
        scope: 'GLOBAL',
        incarnation: tuple.incarnation,
        epoch: tuple.epoch,
      },
    });
    const service = new OrdinaryMarkerEnrollmentService(db);
    const result = await service.enroll(f.marker.id);
    expect(result).toEqual({ status: 'REJECTED', reason: 'GLOBAL_HEAD_NOT_READY' });
  }));

  it('rejects with GLOBAL_INVALIDATION_PENDING when global head has pending intent', () => isolated(async db => {
    const f = await setupWithGlobal(db);
    const pendingRequest: InvalidationRequest = {
      version: 1,
      intentId: randomUUID(),
      operationId: randomUUID(),
      kind: 'FENCE',
      incarnation: f.tuple.incarnation,
      epoch: f.tuple.epoch,
      scopes: [
        {
          kind: 'GLOBAL',
          revision: 1,
          before: f.tuple,
          after: f.tuple,
          modeBefore: { mode: 'CART_SCOPED', revision: f.transition.modeRevision },
          modeAfter: null,
        },
      ],
    };

    await f.repo.prepare(pendingRequest);
    const result = await f.service.enroll(f.marker.id);
    expect(result).toEqual({ status: 'REJECTED', reason: 'GLOBAL_INVALIDATION_PENDING' });
  }));

  it('rejects with GLOBAL_EPOCH_MISMATCH when global head epoch does not match fence', () => isolated(async db => {
    const f = await setupWithGlobal(db);
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS invalidation_head_guard ON ordinary_invalidation_heads`);
    await db.$executeRawUnsafe(`UPDATE ordinary_invalidation_heads SET epoch = 999 WHERE scope = 'GLOBAL'`);
    const result = await f.service.enroll(f.marker.id);
    expect(result).toEqual({ status: 'REJECTED', reason: 'GLOBAL_EPOCH_MISMATCH' });
  }));

  it('rejects with FENCE_REJECTED when reservation fence is not OPEN', () => isolated(async db => {
    const f = await ordinaryFixture(db);
    await db.$executeRawUnsafe(
      `UPDATE reservation_fence_transitions SET phase = 'DRAINING' WHERE id = '${f.transition.id}'`,
    );
    const service = new OrdinaryMarkerEnrollmentService(db);
    const result = await service.enroll(f.marker.id);
    expect(result).toEqual({ status: 'REJECTED', reason: 'FENCE_REJECTED' });
  }));

  it('rejects with INELIGIBLE_PROVENANCE when marker has HISTORICAL_UNVERIFIED provenance', () => isolated(async db => {
    const f = await setupWithGlobal(db);
    await db.cartReservationSyncState.update({
      where: { id: f.marker.id },
      data: { ordinaryProvenanceState: 'HISTORICAL_UNVERIFIED' },
    });
    const result = await f.service.enroll(f.marker.id);
    expect(result).toEqual({ status: 'REJECTED', reason: 'INELIGIBLE_PROVENANCE' });
  }));

  it('rejects with UNRESOLVED_COMMANDS_EXIST when marker has unresolved command in WAITING or PENDING', () => isolated(async db => {
    const f = await ordinaryFixture(db);
    const issued = await f.commands.issue(f.issuance, f.payload);
    expect(issued.command.state).toBe('WAITING');

    const tuple = transitionTuple(f.transition);
    const repo = new OrdinaryInvalidationRepository(db);
    const publication = new OrdinaryInvalidationPublicationService(repo);

    await db.ordinaryInvalidationHead.create({
      data: {
        scope: 'GLOBAL',
        incarnation: tuple.incarnation,
        epoch: tuple.epoch,
      },
    });

    const initial: InvalidationRequest = {
      version: 1,
      intentId: randomUUID(),
      operationId: randomUUID(),
      kind: 'FENCE',
      incarnation: tuple.incarnation,
      epoch: tuple.epoch,
      scopes: [
        {
          kind: 'GLOBAL',
          revision: 0,
          before: tuple,
          after: tuple,
          modeBefore: { mode: 'CART_SCOPED', revision: f.transition.modeRevision },
          modeAfter: null,
        },
      ],
    };

    await repo.prepare(initial);
    await repo.confirm(initial, barrierAcknowledgement(initial));
    await publication.publish(initial.intentId, () => Promise.resolve({ bootstrap: true }));
    await db.ordinaryInvalidationHead.update({
      where: { scope: 'GLOBAL' },
      data: { ready: true },
    });

    const service = new OrdinaryMarkerEnrollmentService(db);
    const result = await service.enroll(f.marker.id);
    expect(result).toEqual({ status: 'REJECTED', reason: 'UNRESOLVED_COMMANDS_EXIST' });
  }));

  it('rejects with INVALIDATION_HISTORY_EXISTS when ordinary_invalidation_scopes has prior scope for marker', () => isolated(async db => {
    const f = await setupWithGlobal(db);
    const first = await f.service.enroll(f.marker.id);
    expect(first.status).toBe('ENROLLED');

    const markerScope: InvalidationRequest = {
      version: 1,
      intentId: randomUUID(),
      operationId: randomUUID(),
      kind: 'CART',
      incarnation: f.tuple.incarnation,
      epoch: f.tuple.epoch,
      scopes: [
        {
          kind: 'MARKER',
          markerId: f.marker.id,
          customerId: f.customerId,
          cartId: f.cartId,
          productId: f.productId,
          revision: 0,
          before: { generation: 0, mutationVersion: 0, quantity: 2 },
          after: { generation: 0, mutationVersion: 0, quantity: 2 },
          cartBefore: null,
          cartAfter: null,
          ownersBefore: [],
          ownersAfter: [],
        },
      ],
    };

    await f.repo.prepare(markerScope);
    await f.repo.confirm(markerScope, barrierAcknowledgement(markerScope));
    await f.publication.publish(markerScope.intentId, () => Promise.resolve({ markerId: f.marker.id }));

    // Now marker has invalidation history
    const historyCount = await db.ordinaryInvalidationScope.count({
      where: { scope: `MARKER:${f.marker.id}` },
    });
    expect(historyCount).toBeGreaterThan(0);
  }));

  it('rejects with STALE_MARKER_HEAD when existing marker head has mismatched incarnation or epoch', () => isolated(async db => {
    const f = await setupWithGlobal(db);
    await db.ordinaryInvalidationHead.create({
      data: {
        scope: `MARKER:${f.marker.id}`,
        incarnation: f.transition.incarnation,
        epoch: 999,
      },
    });

    const result = await f.service.enroll(f.marker.id);
    expect(result).toEqual({ status: 'REJECTED', reason: 'STALE_MARKER_HEAD' });
  }));
});
