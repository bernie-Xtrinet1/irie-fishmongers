import { randomUUID } from 'crypto';
import { PrismaService } from '../../../database/prisma.service';
import { openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';
import { transitionTuple } from '../repositories/reservation-fence.repository';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { OrdinaryInvalidationService } from '../services/ordinary-invalidation.service';
import { OrdinaryInvalidationPublicationService } from '../services/ordinary-invalidation-publication.service';
import { OrdinaryRecoveryRegistryService } from '../services/ordinary-recovery-registry.service';
import { OrdinaryInvalidationRecoveryService } from '../services/ordinary-invalidation-recovery.service';
import { RedisService } from '../../../common/redis/redis.service';
import { InvalidationRequest, barrierAcknowledgement } from '../types/ordinary-invalidation.types';
import { FenceTuple } from '../types/reservation-fence.types';

type FixtureType = Awaited<ReturnType<typeof ordinaryFixture>> & {
  tuple: FenceTuple;
  repo: OrdinaryInvalidationRepository;
  publication: OrdinaryInvalidationPublicationService;
};

describe('OrdinaryInvalidationRecoveryService: Persistence & Fencing', () => {
  jest.setTimeout(120000);

  async function isolated(work: (db: PrismaService, f: FixtureType) => Promise<void>) {
    const schema = await openOrdinarySchema();
    try {
      const f = await ordinaryFixture(schema.db);
      const tuple = transitionTuple(f.transition);
      const repo = new OrdinaryInvalidationRepository(schema.db);
      const publication = new OrdinaryInvalidationPublicationService(repo);

      // Create and bootstrap GLOBAL head
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

  it('same-intent idempotent reconciliation advances PREPARED intent to BARRIER_CONFIRMED', () =>
    isolated(async (db, f) => {
      // Create a marker head at revision 0
      await db.ordinaryInvalidationHead.create({
        data: {
          scope: `MARKER:${f.marker.id}`,
          incarnation: f.tuple.incarnation,
          epoch: f.tuple.epoch,
          publishedRevision: 0,
          allocatedRevision: 0,
          ready: false,
        },
      });

      const redis = mockRedis();
      const repo = new OrdinaryInvalidationRepository(db);
      const invalidationService = new OrdinaryInvalidationService(repo, redis);
      const publicationService = new OrdinaryInvalidationPublicationService(repo);
      const registry = new OrdinaryRecoveryRegistryService();
      const recoveryService = new OrdinaryInvalidationRecoveryService(
        db,
        repo,
        invalidationService,
        publicationService,
        registry,
      );

      const request: InvalidationRequest = {
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

      // Intent prepared in PostgreSQL, but worker crashes before confirmation
      await repo.prepare(request);
      const preparedIntent = await repo.read(request.intentId);
      expect(preparedIntent?.status).toBe('PREPARED');

      // Recovery runs: reconciles barrier and replays registered bootstrap handler
      const res = await recoveryService.recoverIntent(request.intentId);
      expect(res.disposition).toBe('REPLAYED');

      const intentAfter = await repo.read(request.intentId);
      expect(intentAfter?.status).toBe('PUBLISHED');

      const head = await db.ordinaryInvalidationHead.findUniqueOrThrow({
        where: { scope: `MARKER:${f.marker.id}` },
      });
      expect(head.publishedRevision).toBe(1);
      expect(head.ready).toBe(true);
    }));

  it('unsupported recovery operation is left in BLOCKED_MANUAL_REVIEW fail-closed', () =>
    isolated(async (db, f) => {
      await db.ordinaryInvalidationHead.create({
        data: {
          scope: `MARKER:${f.marker.id}`,
          incarnation: f.tuple.incarnation,
          epoch: f.tuple.epoch,
          publishedRevision: 0,
          allocatedRevision: 0,
          ready: false,
        },
      });

      const redis = mockRedis();
      const repo = new OrdinaryInvalidationRepository(db);
      const invalidationService = new OrdinaryInvalidationService(repo, redis);
      const publicationService = new OrdinaryInvalidationPublicationService(repo);
      // Registry without handlers for custom kinds
      const registry = new OrdinaryRecoveryRegistryService();
      const recoveryService = new OrdinaryInvalidationRecoveryService(
        db,
        repo,
        invalidationService,
        publicationService,
        registry,
      );

      // Construct an OWNER intent where no recovery handler is registered
      const request: InvalidationRequest = {
        version: 1,
        intentId: randomUUID(),
        operationId: randomUUID(),
        kind: 'OWNER',
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

      await repo.prepare(request);
      // Advance to BARRIER_CONFIRMED
      await repo.confirm(request, barrierAcknowledgement(request));

      // Attempt recovery
      const res = await recoveryService.recoverIntent(request.intentId);
      expect(res.disposition).toBe('BLOCKED_MANUAL_REVIEW');
      expect(res.reason).toContain('UNSUPPORTED_RECOVERY_OPERATION:OWNER');

      // Intent MUST remain in BARRIER_CONFIRMED, never fabricated or corrupted
      const current = await repo.read(request.intentId);
      expect(current?.status).toBe('BARRIER_CONFIRMED');

      // Head remains fail-closed (ready: false)
      const head = await db.ordinaryInvalidationHead.findUniqueOrThrow({
        where: { scope: `MARKER:${f.marker.id}` },
      });
      expect(head.ready).toBe(false);
    }));

  it('crash after commit: recoverIntent on PUBLISHED intent reconciles readiness or returns ALREADY_PUBLISHED', () =>
    isolated(async (db, f) => {
      await db.ordinaryInvalidationHead.create({
        data: {
          scope: `MARKER:${f.marker.id}`,
          incarnation: f.tuple.incarnation,
          epoch: f.tuple.epoch,
          publishedRevision: 0,
          allocatedRevision: 0,
          ready: false,
        },
      });

      const redis = mockRedis();
      const repo = new OrdinaryInvalidationRepository(db);
      const invalidationService = new OrdinaryInvalidationService(repo, redis);
      const publicationService = new OrdinaryInvalidationPublicationService(repo);
      const registry = new OrdinaryRecoveryRegistryService();
      const recoveryService = new OrdinaryInvalidationRecoveryService(
        db,
        repo,
        invalidationService,
        publicationService,
        registry,
      );

      const request: InvalidationRequest = {
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

      await repo.prepare(request);
      await repo.confirm(request, barrierAcknowledgement(request));
      // Publication commits in DB, but client disconnected before readiness reconciliation
      await publicationService.publish(request.intentId, () => Promise.resolve({ bootstrap: true }));

      // Head is publishedRevision: 1, but ready: false
      const headBefore = await db.ordinaryInvalidationHead.findUniqueOrThrow({
        where: { scope: `MARKER:${f.marker.id}` },
      });
      expect(headBefore.publishedRevision).toBe(1);
      expect(headBefore.ready).toBe(false);

      // Recovery detects PUBLISHED intent with unready head and reconciles readiness
      const res = await recoveryService.recoverIntent(request.intentId);
      expect(res.disposition).toBe('READY_RECONCILED');

      const headAfter = await db.ordinaryInvalidationHead.findUniqueOrThrow({
        where: { scope: `MARKER:${f.marker.id}` },
      });
      expect(headAfter.ready).toBe(true);

      // Subsequent recovery returns ALREADY_PUBLISHED idempotently
      const resDuplicate = await recoveryService.recoverIntent(request.intentId);
      expect(resDuplicate.disposition).toBe('ALREADY_PUBLISHED');
    }));

  it('precondition assertion failure halts publication with BLOCKED_MANUAL_REVIEW', () =>
    isolated(async (db, f) => {
      await db.ordinaryInvalidationHead.create({
        data: {
          scope: `MARKER:${f.marker.id}`,
          incarnation: f.tuple.incarnation,
          epoch: f.tuple.epoch,
          publishedRevision: 0,
          allocatedRevision: 0,
          ready: false,
        },
      });

      const redis = mockRedis();
      const repo = new OrdinaryInvalidationRepository(db);
      const invalidationService = new OrdinaryInvalidationService(repo, redis);
      const publicationService = new OrdinaryInvalidationPublicationService(repo);
      const registry = new OrdinaryRecoveryRegistryService();

      // Register a handler whose assertPreconditions fails
      registry.registerHandler({
        kind: 'CART',
        subtype: 'BOOTSTRAP',
        validateRequest: () => true,
        assertPreconditions: () => {
          return Promise.reject(new Error('CORRUPTED_PRECONDITION'));
        },
        execute: () => Promise.resolve({}),
      });

      const recoveryService = new OrdinaryInvalidationRecoveryService(
        db,
        repo,
        invalidationService,
        publicationService,
        registry,
      );

      const request: InvalidationRequest = {
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

      await repo.prepare(request);
      await repo.confirm(request, barrierAcknowledgement(request));

      const res = await recoveryService.recoverIntent(request.intentId);
      expect(res.disposition).toBe('BLOCKED_MANUAL_REVIEW');
      expect(res.reason).toBe('REPLAY_PUBLICATION_FAILED');
      expect(res.error).toContain('CORRUPTED_PRECONDITION');
    }));

  it('supersession rejects when original intent is not BARRIER_CONFIRMED', () =>
    isolated(async (db, f) => {
      await db.ordinaryInvalidationHead.create({
        data: {
          scope: `MARKER:${f.marker.id}`,
          incarnation: f.tuple.incarnation,
          epoch: f.tuple.epoch,
          publishedRevision: 0,
          allocatedRevision: 0,
          ready: false,
        },
      });

      const repo = new OrdinaryInvalidationRepository(db);

      const oldRequest: InvalidationRequest = {
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

      // Only PREPARED (not confirmed)
      await repo.prepare(oldRequest);

      const replacement: InvalidationRequest = {
        ...oldRequest,
        intentId: randomUUID(),
        operationId: randomUUID(),
        scopes: [
          {
            ...oldRequest.scopes[0]!,
            revision: 1,
          },
        ],
      };

      // Calling supersede directly on repository when status is PREPARED rejects
      await expect(repo.supersede(oldRequest.intentId, replacement)).rejects.toThrow();
    }));
});
