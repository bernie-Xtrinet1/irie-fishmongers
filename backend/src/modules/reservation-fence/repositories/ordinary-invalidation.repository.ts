import { Prisma, OrdinaryCommandBarrierBinding, OrdinaryInvalidationStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ReservationFenceRepository, transitionTuple } from './reservation-fence.repository';
import { BarrierAcknowledgement, barrierAcknowledgement, canonicalInvalidationJson, InvalidationRequest,
  invalidationDigest, invalidationScopeKey, validateInvalidationRequest } from '../types/ordinary-invalidation.types';

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(canonicalInvalidationJson(value)) as Prisma.InputJsonValue;

export async function assertOrdinaryBarrierReadiness(tx: Prisma.TransactionClient, markerId: string): Promise<void> {
  const marker = await tx.ordinaryInvalidationHead.findUnique({ where: { scope: `MARKER:${markerId}` } });
  if (!marker) throw new Error('ORDINARY_MARKER_NOT_ENROLLED');
  if (marker.pendingIntentId !== null) throw new Error('INVALIDATION_PENDING');
  if (!marker.ready) throw new Error('ORDINARY_MARKER_NOT_READY');

  const global = await tx.ordinaryInvalidationHead.findUnique({ where: { scope: 'GLOBAL' } });
  if (!global) throw new Error('GLOBAL_INVALIDATION_NOT_READY');
  if (global.pendingIntentId !== null) throw new Error('INVALIDATION_PENDING');
  if (!global.ready) throw new Error('GLOBAL_INVALIDATION_NOT_READY');
  if (global.incarnation !== marker.incarnation) throw new Error('ORDINARY_INCARNATION_MISMATCH');
  if (global.epoch !== marker.epoch) throw new Error('ORDINARY_EPOCH_MISMATCH');
}

export async function requireOrdinaryCommandBinding(tx: Prisma.TransactionClient, markerId: string,
  commandId: string): Promise<OrdinaryCommandBarrierBinding> {
  await assertOrdinaryBarrierReadiness(tx, markerId);
  const marker = await tx.ordinaryInvalidationHead.findUniqueOrThrow({ where: { scope: `MARKER:${markerId}` } });
  const global = await tx.ordinaryInvalidationHead.findUniqueOrThrow({ where: { scope: 'GLOBAL' } });

  const binding = await tx.ordinaryCommandBarrierBinding.findUnique({ where: { commandId } });
  if (!binding || binding.markerId !== markerId || binding.version !== 1 || binding.incarnation !== global.incarnation
    || binding.epoch !== global.epoch || binding.globalRevision !== global.publishedRevision
    || binding.markerRevision !== marker.publishedRevision) throw new Error('INVALIDATION_BINDING_REJECTED');
  return binding;
}

export async function requireOrdinaryBarrierReadiness(tx: Prisma.TransactionClient, markerId: string,
  commandId?: string): Promise<OrdinaryCommandBarrierBinding | null> {
  const global = await tx.ordinaryInvalidationHead.findUnique({ where: { scope: 'GLOBAL' } });
  if (!global) return null;
  await assertOrdinaryBarrierReadiness(tx, markerId);
  if (!commandId) return null;
  return requireOrdinaryCommandBinding(tx, markerId, commandId);
}

export class OrdinaryInvalidationRepository {
  constructor(readonly prisma: PrismaService) {}

  read(intentId: string) {
    return this.prisma.ordinaryInvalidationIntent.findUnique({ where: { id: intentId }, include: { scopes: { orderBy: { scope: 'asc' } } } });
  }

  discover(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_DISCOVERY_LIMIT');
    return this.prisma.$queryRaw<{ id: string; status: OrdinaryInvalidationStatus }[]>`
      SELECT i.id,i.status FROM ordinary_invalidation_intents i
      WHERE i.status IN ('PREPARED','BARRIER_CONFIRMED') OR (i.status='PUBLISHED' AND EXISTS (
        SELECT 1 FROM ordinary_invalidation_scopes s JOIN ordinary_invalidation_heads h ON h.scope=s.scope
        WHERE s."intentId"=i.id AND NOT h.ready AND h."pendingIntentId" IS NULL
          AND h."publishedRevision"=s.revision AND h."allocatedRevision"=s.revision))
      ORDER BY i.id LIMIT ${limit}`;
  }

  request(value: unknown): InvalidationRequest {
    validateInvalidationRequest(value);
    return structuredClone(value);
  }

  async locked<T>(request: InvalidationRequest, work: (tx: Prisma.TransactionClient) => Promise<T>, additionalIntentIds: string[] = []): Promise<T> {
    validateInvalidationRequest(request);
    return this.prisma.$transaction(async tx => {
      if (request.kind === 'MODE') {
        // No fence lock and no shared lock before/after this exclusive path.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('reservation_engine_mode_transition'))`;
      } else {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1380339280,1)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('reservation_engine_mode_transition'))`;
      }
      const markers = request.scopes.filter(scope => scope.kind === 'MARKER');
      const carts = [...new Set(markers.map(scope => scope.cartId))].sort();
      const ids = markers.map(scope => scope.markerId).sort();
      if (carts.length) {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM carts WHERE id IN (${Prisma.join(carts)}) ORDER BY id FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT id FROM cart_items WHERE "cartId" IN (${Prisma.join(carts)}) ORDER BY id FOR UPDATE`);
      }
      if (ids.length) {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM cart_reservation_sync_states WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT id FROM ordinary_reservation_owners WHERE "markerId" IN (${Prisma.join(ids)}) ORDER BY generation,id FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT id FROM ordinary_reservation_commands WHERE "markerId" IN (${Prisma.join(ids)}) ORDER BY "queueOrdinal",id FOR UPDATE`);
      }
      const keys = request.scopes.map(invalidationScopeKey);
      await tx.$queryRaw(Prisma.sql`SELECT scope FROM ordinary_invalidation_heads WHERE scope IN (${Prisma.join(keys)}) ORDER BY scope FOR UPDATE`);
      const intentIds = [...new Set([request.intentId, ...additionalIntentIds])].sort();
      await tx.$queryRaw(Prisma.sql`SELECT id FROM ordinary_invalidation_intents WHERE id::text IN (${Prisma.join(intentIds)}) ORDER BY id FOR UPDATE`);
      return work(tx);
    }, { timeout: 5000 });
  }

  async assertState(tx: Prisma.TransactionClient, request: InvalidationRequest, side: 'before' | 'after'): Promise<void> {
    for (const scope of request.scopes) {
      if (scope.kind === 'MARKER') {
        const marker = await tx.cartReservationSyncState.findUniqueOrThrow({ where: { id: scope.markerId } });
        const cart = await tx.cart.findUniqueOrThrow({ where: { id: scope.cartId } });
        const item = await tx.cartItem.findUnique({ where: { cartId_productId: { cartId: scope.cartId, productId: scope.productId } } });
        const owners = await tx.ordinaryReservationOwner.findMany({ where: { markerId: scope.markerId }, orderBy: { id: 'asc' }, select: { id: true, state: true } });
        const actual = { generation: marker.generation, mutationVersion: marker.expectedMutationVersion, quantity: marker.expectedQuantity };
        const actualCart = item ? { id: item.id, mutationVersion: item.mutationVersion, quantity: item.quantity } : null;
        if (cart.customerId !== scope.customerId || marker.cartId !== scope.cartId || marker.productId !== scope.productId
          || canonicalInvalidationJson(actual) !== canonicalInvalidationJson(scope[side])
          || canonicalInvalidationJson(actualCart) !== canonicalInvalidationJson(side === 'before' ? scope.cartBefore : scope.cartAfter)
          || canonicalInvalidationJson(owners) !== canonicalInvalidationJson(side === 'before' ? scope.ownersBefore : scope.ownersAfter))
          throw new Error('INVALIDATION_DOMAIN_PRECONDITION');
        if (side === 'before' && canonicalInvalidationJson(scope.ownersBefore) !== canonicalInvalidationJson(scope.ownersAfter)) {
          // Do not invalidate lifecycle prerequisites of an unclosed winner.
          const unresolved = await tx.ordinaryReservationCommand.count({ where: { markerId: scope.markerId,
            state: { in: ['PENDING', 'UNCERTAIN', 'REVOCATION_PENDING'] } } });
          if (unresolved) throw new Error('HISTORICAL_CLOSURE_REQUIRED');
        }
      } else {
        const fences = new ReservationFenceRepository(this.prisma);
        const fence = await fences.latest(tx), mode = await fences.mode(tx);
        if (!fence || canonicalInvalidationJson(transitionTuple(fence)) !== canonicalInvalidationJson(scope[side]))
          throw new Error('INVALIDATION_FENCE_PRECONDITION');
        if (side === 'before' || scope.modeAfter === null) {
          if (mode.mode !== scope.modeBefore.mode || mode.modeRevision !== scope.modeBefore.revision)
            throw new Error('INVALIDATION_MODE_PRECONDITION');
        } else if (mode.mode !== scope.modeAfter || mode.modeRevision === null || mode.modeRevision <= (scope.modeBefore.revision ?? 0))
          throw new Error('INVALIDATION_MODE_PUBLICATION');
      }
    }
  }

  async prepare(input: InvalidationRequest) {
    const request = this.request(input), digest = invalidationDigest(request);
    return this.locked(request, async tx => {
      const existing = await tx.ordinaryInvalidationIntent.findFirst({ where: { OR: [{ id: request.intentId }, { operationId: request.operationId }] } });
      if (existing) {
        if (existing.id !== request.intentId || existing.digest !== digest || canonicalInvalidationJson(existing.request) !== canonicalInvalidationJson(request))
          throw new Error('INVALIDATION_IDENTITY_CONFLICT');
        return existing;
      }
      await this.assertState(tx, request, 'before');
      for (const scope of request.scopes) {
        const head = await tx.ordinaryInvalidationHead.findUniqueOrThrow({ where: { scope: invalidationScopeKey(scope) } });
        if (head.pendingIntentId || head.publishedRevision !== scope.revision || head.allocatedRevision !== scope.revision
          || head.incarnation !== request.incarnation || head.epoch !== request.epoch) throw new Error('INVALIDATION_SCOPE_CONFLICT');
      }
      const intent = await tx.ordinaryInvalidationIntent.create({ data: { id: request.intentId, operationId: request.operationId,
        kind: request.kind, request: json(request), digest } });
      for (const scope of request.scopes) {
        const key = invalidationScopeKey(scope);
        await tx.ordinaryInvalidationScope.create({ data: { intentId: intent.id, scope: key,
          previousRevision: scope.revision, revision: scope.revision + 1, snapshot: json(scope) } });
        await tx.ordinaryInvalidationHead.update({ where: { scope: key }, data: {
          pendingIntentId: intent.id, allocatedRevision: scope.revision + 1, ready: false } });
      }
      return intent;
    });
  }

  async confirm(request: InvalidationRequest, acknowledgement: BarrierAcknowledgement) {
    if (canonicalInvalidationJson(acknowledgement) !== canonicalInvalidationJson(barrierAcknowledgement(request)))
      throw new Error('INVALID_BARRIER_ACKNOWLEDGEMENT');
    return this.locked(request, async tx => {
      const intent = await tx.ordinaryInvalidationIntent.findUniqueOrThrow({ where: { id: request.intentId } });
      if (intent.digest !== invalidationDigest(request)) throw new Error('INVALIDATION_IDENTITY_CONFLICT');
      if (intent.status === 'BARRIER_CONFIRMED' || intent.status === 'PUBLISHED') return intent;
      if (intent.status !== 'PREPARED') throw new Error('INVALIDATION_SUPERSEDED');
      return tx.ordinaryInvalidationIntent.update({ where: { id: intent.id }, data: { status: 'BARRIER_CONFIRMED',
        acknowledgement: canonicalInvalidationJson(acknowledgement), acknowledgementHash: invalidationDigest(acknowledgement) } });
    });
  }

  // The old barrier must already be confirmed. Replacement allocates the next
  // rejection revision, never rolls back an allocation or publishes stale state.
  async supersede(intentId: string, input: InvalidationRequest) {
    const request = this.request(input), digest = invalidationDigest(request);
    if (intentId === request.intentId) throw new Error('INVALID_REPLACEMENT_IDENTITY');
    return this.locked(request, async tx => {
      const old = await tx.ordinaryInvalidationIntent.findUniqueOrThrow({ where: { id: intentId }, include: { scopes: true } });
      const prior = this.request(old.request);
      if (prior.kind !== request.kind || prior.incarnation !== request.incarnation || prior.epoch !== request.epoch
        || old.scopes.length !== request.scopes.length
        || old.scopes.some(scope => !request.scopes.some(next => invalidationScopeKey(next) === scope.scope && next.revision === scope.revision)))
        throw new Error('REPLACEMENT_SCOPE_MISMATCH');
      const existing = await tx.ordinaryInvalidationIntent.findUnique({ where: { id: request.intentId } });
      if (old.status === 'SUPERSEDED' && old.supersededById === request.intentId && existing?.digest === digest) return existing;
      if (old.status !== 'BARRIER_CONFIRMED' || existing) throw new Error('CONFIRMED_REPLACEMENT_REQUIRED');
      await this.assertState(tx, request, 'before');
      for (const scope of request.scopes) {
        const head = await tx.ordinaryInvalidationHead.findUniqueOrThrow({ where: { scope: invalidationScopeKey(scope) } });
        if (head.pendingIntentId !== intentId || head.allocatedRevision !== scope.revision || head.ready
          || head.incarnation !== request.incarnation || head.epoch !== request.epoch) throw new Error('REPLACEMENT_SCOPE_CONFLICT');
      }
      const replacement = await tx.ordinaryInvalidationIntent.create({ data: { id: request.intentId,
        operationId: request.operationId, kind: request.kind, request: json(request), digest } });
      for (const scope of request.scopes) await tx.ordinaryInvalidationScope.create({ data: {
        intentId: replacement.id, scope: invalidationScopeKey(scope), previousRevision: scope.revision,
        revision: scope.revision + 1, snapshot: json(scope) } });
      await tx.ordinaryInvalidationIntent.update({ where: { id: intentId }, data: { status: 'SUPERSEDED', supersededById: replacement.id } });
      for (const scope of request.scopes) await tx.ordinaryInvalidationHead.update({ where: { scope: invalidationScopeKey(scope) },
        data: { pendingIntentId: replacement.id, allocatedRevision: scope.revision + 1, ready: false } });
      return replacement;
    }, [intentId]);
  }
}

// Separate cleanup predicate. Ordinary readiness above is deliberately unchanged.
export async function requireReleasePublication(tx: Prisma.TransactionClient, commandId: string, current = true) {
  if (current) await tx.$queryRaw`SELECT ordinary_release_dispatchable(${commandId}::uuid)`;
  else await tx.$queryRaw`SELECT ordinary_release_binding(${commandId}::uuid,false)`;
  const binding = await tx.ordinaryCommandBarrierBinding.findUniqueOrThrow({ where: { commandId } });
  const confirmations: string[] = [];
  for (const [scope, revision] of [['GLOBAL', binding.globalRevision], [`MARKER:${binding.markerId}`, binding.markerRevision]] as const) {
    const row = await tx.ordinaryInvalidationScope.findUniqueOrThrow({ where: { scope_revision: { scope, revision } }, include: { intent: true } });
    const request = row.intent.request;
    validateInvalidationRequest(request);
    const expected = canonicalInvalidationJson(barrierAcknowledgement(request));
    if (row.intent.status !== 'PUBLISHED' || row.intent.acknowledgement !== expected
      || row.intent.acknowledgementHash !== invalidationDigest(barrierAcknowledgement(request)))
      throw new Error('RELEASE_CONFIRMATION_REJECTED');
    confirmations.push(expected);
  }
  return { binding, publication: { global: confirmations[0]!, marker: confirmations[1]! } };
}
