import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { PrismaService } from '../../../database/prisma.service';
import { openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';
import { transitionTuple, ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { OrdinaryInvalidationService } from '../services/ordinary-invalidation.service';
import { OrdinaryInvalidationPublicationService } from '../services/ordinary-invalidation-publication.service';
import { OrdinaryRecoveryRegistryService } from '../services/ordinary-recovery-registry.service';
import { OrdinaryInvalidationRecoveryService } from '../services/ordinary-invalidation-recovery.service';
import { OrdinaryMarkerBootstrapService } from '../services/ordinary-marker-bootstrap.service';
import { OrdinaryMarkerEnrollmentService } from '../services/ordinary-marker-enrollment.service';
import { RedisService } from '../../../common/redis/redis.service';
import { InvalidationRequest, barrierAcknowledgement, invalidationRedisKey, canonicalInvalidationJson } from '../types/ordinary-invalidation.types';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { ORDINARY_INVALIDATION_LUA, invalidationHistoryKey } from '../lua/ordinary-invalidation.lua';
import { assertDisposableEnvironment, withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { FenceTuple } from '../types/reservation-fence.types';

type FixtureType = Awaited<ReturnType<typeof ordinaryFixture>> & {
  tuple: FenceTuple;
  repo: OrdinaryInvalidationRepository;
  publication: OrdinaryInvalidationPublicationService;
  invalidationService: OrdinaryInvalidationService;
};

describe('Ordinary Invalidation Recovery & Bootstrap: Standalone Redis Integration', () => {
  jest.setTimeout(120000);

  let redisClient: Redis;
  const trackedRedisKeys = new Set<string>();

  beforeAll(async () => {
    assertDisposableEnvironment();
    if (process.env.REDIS_URL !== 'redis://127.0.0.1:16479/11') {
      throw new Error('Exact disposable Redis DB required (127.0.0.1:16479/11)');
    }
    redisClient = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
    await redisClient.connect();
  });

  afterAll(() =>
    withCleanup(async () => {}, [
      async () => {
        if (!redisClient || redisClient.status !== 'ready') return;
        if (trackedRedisKeys.size) await redisClient.del(...trackedRedisKeys);
      },
    ]).finally(async () => {
      if (redisClient?.status === 'ready') await redisClient.quit();
      else redisClient?.disconnect();
    }),
  );

  function makeRedisService(): RedisService {
    return {
      eval: async (script: string, keys: string[], args: (string | number)[]) => {
        return redisClient.eval(script, keys.length, ...keys, ...args);
      },
      getClient: () => redisClient,
    } as unknown as RedisService;
  }

  async function isolatedWithRedis(work: (db: PrismaService, f: FixtureType, redisService: RedisService) => Promise<void>) {
    const schema = await openOrdinarySchema();
    const localKeys = new Set<string>();
    try {
      const f = await ordinaryFixture(schema.db);
      const tuple = transitionTuple(f.transition);
      const repo = new OrdinaryInvalidationRepository(schema.db);
      const publication = new OrdinaryInvalidationPublicationService(repo);
      const redisService = makeRedisService();
      const invalidationService = new OrdinaryInvalidationService(repo, redisService);

      // Set control key in Redis matching the transition tuple
      await redisClient.set(
        RESERVATION_FENCE_KEY,
        JSON.stringify({
          incarnation: tuple.incarnation,
          epoch: tuple.epoch,
          phase: 'OPEN',
          protocol: 1,
          revision: tuple.revision,
          transitionId: randomUUID(),
        }),
      );
      localKeys.add(RESERVATION_FENCE_KEY);
      trackedRedisKeys.add(RESERVATION_FENCE_KEY);

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
      await invalidationService.reconcile(globalReq.intentId);
      await publication.publish(globalReq.intentId, () => Promise.resolve({ bootstrap: true }));
      await invalidationService.reconcileReadiness(globalReq.intentId);

      const globalKey = invalidationRedisKey('GLOBAL');
      localKeys.add(globalKey);
      localKeys.add(invalidationHistoryKey(globalKey));
      trackedRedisKeys.add(globalKey);
      trackedRedisKeys.add(invalidationHistoryKey(globalKey));

      const markerKey = invalidationRedisKey(`MARKER:${f.marker.id}`);
      localKeys.add(markerKey);
      localKeys.add(invalidationHistoryKey(markerKey));
      trackedRedisKeys.add(markerKey);
      trackedRedisKeys.add(invalidationHistoryKey(markerKey));

      await work(schema.db, { ...f, tuple, repo, publication, invalidationService }, redisService);
    } finally {
      if (localKeys.size) await redisClient.del(...localKeys);
      await schema.close();
    }
  }

  it('full live Redis bootstrap: advances from revision 0 to revision 1 READY in Redis and PostgreSQL', () =>
    isolatedWithRedis(async (db, f, _redisService) => {
      const enrollmentService = new OrdinaryMarkerEnrollmentService(db);
      await enrollmentService.enroll(f.marker.id);

      const fenceRepo = new ReservationFenceRepository(db);
      const bootstrapService = new OrdinaryMarkerBootstrapService(
        db,
        f.repo,
        f.invalidationService,
        f.publication,
        fenceRepo,
      );

      const markerKey = invalidationRedisKey(`MARKER:${f.marker.id}`);
      trackedRedisKeys.add(markerKey);
      trackedRedisKeys.add(invalidationHistoryKey(markerKey));

      const result = await bootstrapService.bootstrap(f.marker.id);
      expect(result.status).toBe('READY');
      expect(result.revision).toBe(1);

      // Verify Redis barrier state is READY with no TTL
      expect(await redisClient.pttl(markerKey)).toBe(-1);
      const rawBarrier = await redisClient.get(markerKey);
      expect(rawBarrier).not.toBeNull();
      const barrier = JSON.parse(rawBarrier!) as { state: string; revision: number; scope: string };
      expect(barrier.state).toBe('READY');
      expect(barrier.revision).toBe(1);
      expect(barrier.scope).toBe(`MARKER:${f.marker.id}`);

      // Verify Redis initialized history key is retained
      const rawHistory = await redisClient.get(invalidationHistoryKey(markerKey));
      expect(rawHistory).not.toBeNull();
      const history = JSON.parse(rawHistory!) as { scope: string };
      expect(history.scope).toBe(`MARKER:${f.marker.id}`);

      // Verify PostgreSQL head is ready: true at publishedRevision: 1
      const head = await db.ordinaryInvalidationHead.findUniqueOrThrow({
        where: { scope: `MARKER:${f.marker.id}` },
      });
      expect(head.publishedRevision).toBe(1);
      expect(head.allocatedRevision).toBe(1);
      expect(head.ready).toBe(true);
      expect(head.pendingIntentId).toBeNull();
    }));

  it('response loss recovery: barrier installed in Redis but client crashed before PostgreSQL commit', () =>
    isolatedWithRedis(async (db, f, _redisService) => {
      const enrollmentService = new OrdinaryMarkerEnrollmentService(db);
      await enrollmentService.enroll(f.marker.id);

      const markerKey = invalidationRedisKey(`MARKER:${f.marker.id}`);
      trackedRedisKeys.add(markerKey);
      trackedRedisKeys.add(invalidationHistoryKey(markerKey));

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

      // 1. Prepare intent in PostgreSQL
      await f.repo.prepare(request);

      // 2. Worker installs barrier in Redis directly via Lua
      const ack = barrierAcknowledgement(request);
      const ackJson = canonicalInvalidationJson(ack);
      const redisReply = await redisClient.eval(
        ORDINARY_INVALIDATION_LUA,
        2,
        RESERVATION_FENCE_KEY,
        markerKey,
        ackJson,
        'INSTALL',
      );
      const reply = JSON.parse(String(redisReply)) as { code: string };
      expect(reply.code).toBe('CONFIRMED');

      // 3. Worker crashed before calling repo.confirm() in PostgreSQL!
      // In PostgreSQL, intent is still in state PREPARED
      const intentBefore = await f.repo.read(request.intentId);
      expect(intentBefore?.status).toBe('PREPARED');

      // 4. Recovery coordinator discovers stuck PREPARED intent and recovers it
      const registry = new OrdinaryRecoveryRegistryService();
      const recoveryService = new OrdinaryInvalidationRecoveryService(
        db,
        f.repo,
        f.invalidationService,
        f.publication,
        registry,
      );

      const recoveryRes = await recoveryService.recoverIntent(request.intentId);
      expect(recoveryRes.disposition).toBe('REPLAYED');

      // 5. Redis and PostgreSQL are now synchronized in READY state
      const rawBarrier = await redisClient.get(markerKey);
      expect(rawBarrier).not.toBeNull();
      const barrierObj = JSON.parse(rawBarrier!) as { state: string };
      expect(barrierObj.state).toBe('READY');

      const head = await db.ordinaryInvalidationHead.findUniqueOrThrow({
        where: { scope: `MARKER:${f.marker.id}` },
      });
      expect(head.ready).toBe(true);
      expect(head.publishedRevision).toBe(1);
    }));
});
