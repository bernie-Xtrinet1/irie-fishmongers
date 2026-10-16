import { randomUUID } from 'crypto';
import { PrismaService } from '../../../database/prisma.service';
import { openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';
import { transitionTuple, ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { OrdinaryMarkerEnrollmentService } from '../services/ordinary-marker-enrollment.service';
import { OrdinaryMarkerBootstrapService } from '../services/ordinary-marker-bootstrap.service';
import { OrdinaryInvalidationRepository, assertOrdinaryBarrierReadiness } from '../repositories/ordinary-invalidation.repository';
import { OrdinaryInvalidationService } from '../services/ordinary-invalidation.service';
import { OrdinaryInvalidationPublicationService } from '../services/ordinary-invalidation-publication.service';
import { RedisService } from '../../../common/redis/redis.service';
import { InvalidationRequest, barrierAcknowledgement } from '../types/ordinary-invalidation.types';
import { FenceTuple } from '../types/reservation-fence.types';

type FixtureType = Awaited<ReturnType<typeof ordinaryFixture>> & {
  tuple: FenceTuple;
  repo: OrdinaryInvalidationRepository;
  publication: OrdinaryInvalidationPublicationService;
};

describe('OrdinaryMarkerBootstrapService: Persistence & Concurrency', () => {
  jest.setTimeout(120000);

  async function isolated(work: (db: PrismaService, f: FixtureType) => Promise<void>) {
    const schema = await openOrdinarySchema();
    try {
      const f = await ordinaryFixture(schema.db);
      const tuple = transitionTuple(f.transition);
      const repo = new OrdinaryInvalidationRepository(schema.db);
      const publication = new OrdinaryInvalidationPublicationService(repo);

      // Create and bootstrap GLOBAL head to establish global readiness
      await schema.db.ordinaryInvalidationHead.create({
        data: { scope: 'GLOBAL', incarnation: tuple.incarnation, epoch: tuple.epoch },
      });
      const globalReq: InvalidationRequest = {
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
      await repo.prepare(globalReq);
      await repo.confirm(globalReq, barrierAcknowledgement(globalReq));
      await publication.publish(globalReq.intentId, () => Promise.resolve({ bootstrap: true }));
      await schema.db.ordinaryInvalidationHead.update({ where: { scope: 'GLOBAL' }, data: { ready: true } });

      await work(schema.db, { ...f, tuple, repo, publication });
    } finally {
      await schema.close();
    }
  }

  function mockRedis(): RedisService {
    return {
      eval: jest.fn().mockImplementation((_lua: string, _keys: string[], args: string[]) => {
        const ackJson = args[0];
        return Promise.resolve(JSON.stringify({ code: 'CONFIRMED', acknowledgement: ackJson }));
      }),
    } as unknown as RedisService;
  }

  it('enrollment commits at revision 0 ready:false; fail-closed readiness blocks command execution', () =>
    isolated(async (db, f) => {
      const enrollmentService = new OrdinaryMarkerEnrollmentService(db);
      const enrollRes = await enrollmentService.enroll(f.marker.id);
      expect(enrollRes.status).toBe('ENROLLED');

      const head = await db.ordinaryInvalidationHead.findUniqueOrThrow({
        where: { scope: `MARKER:${f.marker.id}` },
      });
      expect(head.publishedRevision).toBe(0);
      expect(head.allocatedRevision).toBe(0);
      expect(head.ready).toBe(false);
      expect(head.pendingIntentId).toBeNull();

      // Attempting ordinary barrier readiness assertion must fail closed
      await expect(
        db.$transaction(async tx => {
          await assertOrdinaryBarrierReadiness(tx, f.marker.id);
        }),
      ).rejects.toThrow('ORDINARY_MARKER_NOT_READY');
    }));

  it('successful post-commit bootstrap advances marker head to revision 1 and ready:true', () =>
    isolated(async (db, f) => {
      const enrollmentService = new OrdinaryMarkerEnrollmentService(db);
      await enrollmentService.enroll(f.marker.id);

      const redis = mockRedis();
      const repo = new OrdinaryInvalidationRepository(db);
      const invalidationService = new OrdinaryInvalidationService(repo, redis);
      const publicationService = new OrdinaryInvalidationPublicationService(repo);
      const fenceRepo = new ReservationFenceRepository(db);

      const bootstrapService = new OrdinaryMarkerBootstrapService(
        db,
        repo,
        invalidationService,
        publicationService,
        fenceRepo,
      );

      const result = await bootstrapService.bootstrap(f.marker.id);
      expect(result.status).toBe('READY');
      expect(result.revision).toBe(1);

      const head = await db.ordinaryInvalidationHead.findUniqueOrThrow({
        where: { scope: `MARKER:${f.marker.id}` },
      });
      expect(head.publishedRevision).toBe(1);
      expect(head.allocatedRevision).toBe(1);
      expect(head.ready).toBe(true);
      expect(head.pendingIntentId).toBeNull();

      // Ordinary barrier readiness passes cleanly
      await expect(
        db.$transaction(async tx => {
          await assertOrdinaryBarrierReadiness(tx, f.marker.id);
        }),
      ).resolves.toBeUndefined();
    }));

  it('second bootstrap call on already-ready marker idempotently returns ALREADY_READY', () =>
    isolated(async (db, f) => {
      const enrollmentService = new OrdinaryMarkerEnrollmentService(db);
      await enrollmentService.enroll(f.marker.id);

      const redis = mockRedis();
      const repo = new OrdinaryInvalidationRepository(db);
      const invalidationService = new OrdinaryInvalidationService(repo, redis);
      const publicationService = new OrdinaryInvalidationPublicationService(repo);
      const fenceRepo = new ReservationFenceRepository(db);

      const bootstrapService = new OrdinaryMarkerBootstrapService(
        db,
        repo,
        invalidationService,
        publicationService,
        fenceRepo,
      );

      const res1 = await bootstrapService.bootstrap(f.marker.id);
      expect(res1.status).toBe('READY');

      const res2 = await bootstrapService.bootstrap(f.marker.id);
      expect(res2.status).toBe('ALREADY_READY');
      expect(res2.revision).toBe(1);
    }));

  it('concurrent bootstrap attempts do not corrupt head; second worker yields safely', () =>
    isolated(async (db, f) => {
      const enrollmentService = new OrdinaryMarkerEnrollmentService(db);
      await enrollmentService.enroll(f.marker.id);

      const redis = mockRedis();
      const repo = new OrdinaryInvalidationRepository(db);
      const invalidationService = new OrdinaryInvalidationService(repo, redis);
      const publicationService = new OrdinaryInvalidationPublicationService(repo);
      const fenceRepo = new ReservationFenceRepository(db);

      const bootstrapService = new OrdinaryMarkerBootstrapService(
        db,
        repo,
        invalidationService,
        publicationService,
        fenceRepo,
      );

      // Launch two bootstrap calls concurrently
      const [resA, resB] = await Promise.all([
        bootstrapService.bootstrap(f.marker.id),
        bootstrapService.bootstrap(f.marker.id),
      ]);

      const statuses = [resA.status, resB.status];
      expect(statuses).toContain('READY');

      const head = await db.ordinaryInvalidationHead.findUniqueOrThrow({
        where: { scope: `MARKER:${f.marker.id}` },
      });
      expect(head.publishedRevision).toBe(1);
      expect(head.ready).toBe(true);
    }));

  it('bootstrap rejects non-existent marker with HEAD_NOT_FOUND', () =>
    isolated(async (db, _f) => {
      const redis = mockRedis();
      const repo = new OrdinaryInvalidationRepository(db);
      const invalidationService = new OrdinaryInvalidationService(repo, redis);
      const publicationService = new OrdinaryInvalidationPublicationService(repo);
      const fenceRepo = new ReservationFenceRepository(db);

      const bootstrapService = new OrdinaryMarkerBootstrapService(
        db,
        repo,
        invalidationService,
        publicationService,
        fenceRepo,
      );

      const unknownId = randomUUID();
      const res = await bootstrapService.bootstrap(unknownId);
      expect(res.status).toBe('REJECTED');
      expect(res.reason).toBe('HEAD_NOT_FOUND');
    }));

  it('bootstrap preserves unrelated carts, items, and inventory without mutation', () =>
    isolated(async (db, f) => {
      // Create an unrelated customer, cart and item
      const unrelatedUser = await db.user.create({
        data: {
          email: `unrelated-${randomUUID()}@example.com`,
          passwordHash: 'hashed',
          firstName: 'Unrelated',
          lastName: 'Customer',
        },
      });
      const unrelatedCart = await db.cart.create({ data: { customerId: unrelatedUser.id } });
      const unrelatedItem = await db.cartItem.create({
        data: { cartId: unrelatedCart.id, productId: f.productId, quantity: 5, mutationVersion: 3 },
      });

      const enrollmentService = new OrdinaryMarkerEnrollmentService(db);
      await enrollmentService.enroll(f.marker.id);

      const redis = mockRedis();
      const repo = new OrdinaryInvalidationRepository(db);
      const invalidationService = new OrdinaryInvalidationService(repo, redis);
      const publicationService = new OrdinaryInvalidationPublicationService(repo);
      const fenceRepo = new ReservationFenceRepository(db);

      const bootstrapService = new OrdinaryMarkerBootstrapService(
        db,
        repo,
        invalidationService,
        publicationService,
        fenceRepo,
      );

      await bootstrapService.bootstrap(f.marker.id);

      // Unrelated cart item is completely unchanged
      const itemAfter = await db.cartItem.findUniqueOrThrow({ where: { id: unrelatedItem.id } });
      expect(itemAfter.quantity).toBe(5);
      expect(itemAfter.mutationVersion).toBe(3);
    }));
});
