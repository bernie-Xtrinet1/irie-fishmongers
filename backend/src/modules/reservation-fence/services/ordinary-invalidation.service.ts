import { RedisService } from '../../../common/redis/redis.service';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { ORDINARY_INVALIDATION_LUA } from '../lua/ordinary-invalidation.lua';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { barrierAcknowledgement, canonicalInvalidationJson, InvalidationRequest, invalidationDigest,
  invalidationRedisKey, invalidationScopeKey } from '../types/ordinary-invalidation.types';

// Callable recovery only. No provider, worker, coordinator or execution retry.
// Redis restore/promotion remains an infrastructure quarantine boundary: an
// application cannot distinguish a silently restored old primary by reading it.
export class OrdinaryInvalidationService {
  constructor(private readonly repository: OrdinaryInvalidationRepository, private readonly redis: RedisService) {}

  async prepare(request: InvalidationRequest) {
    const snapshot = this.repository.request(request);
    try { return await this.repository.prepare(snapshot); }
    catch (error) {
      // Resolve COMMIT response loss by stable identity; never allocate again.
      const retained = await this.repository.read(snapshot.intentId);
      if (retained?.digest === invalidationDigest(snapshot)) return retained;
      throw error;
    }
  }

  async reconcile(intentId: string) {
    const intent = await this.repository.read(intentId);
    if (!intent) throw new Error('UNKNOWN_INVALIDATION');
    if (intent.status !== 'PREPARED') return intent;
    const request = this.repository.request(intent.request);
    const acknowledgement = barrierAcknowledgement(request);
    const bytes = canonicalInvalidationJson(acknowledgement);
    // No PostgreSQL transaction is held during Redis submission or response loss.
    const raw: unknown = await this.redis.eval(ORDINARY_INVALIDATION_LUA,
      [RESERVATION_FENCE_KEY, ...acknowledgement.scopes.map(scope => invalidationRedisKey(scope.scope))], [bytes, 'INSTALL']);
    if (typeof raw !== 'string') throw new Error('BARRIER_UNRESOLVED');
    const reply: unknown = JSON.parse(raw);
    if (!reply || typeof reply !== 'object' || !('code' in reply) || reply.code !== 'CONFIRMED'
      || !('acknowledgement' in reply) || reply.acknowledgement !== bytes) throw new Error('BARRIER_UNRESOLVED');
    try { return await this.repository.confirm(request, acknowledgement); }
    catch (error) {
      const retained = await this.repository.read(intentId);
      if (retained?.acknowledgement === bytes && ['BARRIER_CONFIRMED', 'PUBLISHED'].includes(retained.status)) return retained;
      throw error;
    }
  }

  async reconcileReadiness(intentId: string): Promise<void> {
    const intent = await this.repository.read(intentId);
    if (!intent || intent.status !== 'PUBLISHED') throw new Error('PUBLICATION_REQUIRED');
    const request = this.repository.request(intent.request);
    const acknowledgement = barrierAcknowledgement(request), bytes = canonicalInvalidationJson(acknowledgement);
    const verify = async () => this.repository.locked(request, async tx => {
      for (const scope of request.scopes) {
        const head = await tx.ordinaryInvalidationHead.findUniqueOrThrow({ where: { scope: invalidationScopeKey(scope) } });
        if (head.pendingIntentId || head.allocatedRevision !== scope.revision + 1 || head.publishedRevision !== scope.revision + 1)
          throw new Error('READINESS_SUPERSEDED');
      }
    });
    await verify();
    const raw: unknown = await this.redis.eval(ORDINARY_INVALIDATION_LUA,
      [RESERVATION_FENCE_KEY, ...acknowledgement.scopes.map(scope => invalidationRedisKey(scope.scope))], [bytes, 'READY']);
    if (typeof raw !== 'string') throw new Error('READINESS_UNRESOLVED');
    const reply: unknown = JSON.parse(raw);
    if (!reply || typeof reply !== 'object' || !('code' in reply) || reply.code !== 'CONFIRMED'
      || !('acknowledgement' in reply) || reply.acknowledgement !== bytes) throw new Error('READINESS_UNRESOLVED');
    await this.repository.locked(request, async tx => {
      for (const scope of request.scopes) {
        const changed = await tx.ordinaryInvalidationHead.updateMany({ where: { scope: invalidationScopeKey(scope),
          pendingIntentId: null, allocatedRevision: scope.revision + 1, publishedRevision: scope.revision + 1 }, data: { ready: true } });
        if (changed.count !== 1) throw new Error('READINESS_SUPERSEDED');
      }
    });
  }

  async supersede(intentId: string, replacement: InvalidationRequest) {
    const request = this.repository.request(replacement);
    // A PREPARED predecessor may have reached Redis despite response loss.
    // Reconcile that exact allocation before advancing it; never remove it.
    await this.reconcile(intentId);
    try { return await this.repository.supersede(intentId, request); }
    catch (error) {
      const old = await this.repository.read(intentId), retained = await this.repository.read(request.intentId);
      if (old?.status === 'SUPERSEDED' && old.supersededById === request.intentId
        && retained?.digest === invalidationDigest(request)) return retained;
      throw error;
    }
  }
}
