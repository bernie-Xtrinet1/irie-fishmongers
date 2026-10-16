import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../database/prisma.service';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { OrdinaryInvalidationService } from './ordinary-invalidation.service';
import { OrdinaryInvalidationPublicationService } from './ordinary-invalidation-publication.service';
import { InvalidationRequest } from '../types/ordinary-invalidation.types';
import { BootstrapResult } from '../types/ordinary-invalidation-recovery.types';

@Injectable()
export class OrdinaryMarkerBootstrapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: OrdinaryInvalidationRepository,
    private readonly invalidationService: OrdinaryInvalidationService,
    private readonly publicationService: OrdinaryInvalidationPublicationService,
    private readonly fences: ReservationFenceRepository,
  ) {}

  async bootstrap(markerId: string): Promise<BootstrapResult> {
    const scopeKey = `MARKER:${markerId}`;
    const head = await this.prisma.ordinaryInvalidationHead.findUnique({
      where: { scope: scopeKey },
    });

    if (!head) {
      return { scope: scopeKey, markerId, status: 'REJECTED', reason: 'HEAD_NOT_FOUND' };
    }
    if (head.ready) {
      return { scope: head.scope, markerId, status: 'ALREADY_READY', revision: head.publishedRevision };
    }
    if (head.pendingIntentId !== null) {
      return { scope: head.scope, markerId, status: 'IN_PROGRESS', reason: 'PENDING_INTENT_EXISTS' };
    }
    if (head.publishedRevision > 0 && !head.ready) {
      const scopeRow = await this.prisma.ordinaryInvalidationScope.findUnique({
        where: { scope_revision: { scope: head.scope, revision: head.publishedRevision } },
      });
      if (scopeRow) {
        await this.invalidationService.reconcileReadiness(scopeRow.intentId);
        const refreshed = await this.prisma.ordinaryInvalidationHead.findUnique({ where: { scope: head.scope } });
        if (refreshed?.ready) {
          return { scope: head.scope, markerId, status: 'READY', revision: refreshed.publishedRevision };
        }
      }
      return { scope: head.scope, markerId, status: 'IN_PROGRESS', reason: 'READINESS_PENDING' };
    }

    const marker = await this.prisma.cartReservationSyncState.findUnique({ where: { id: markerId } });
    if (!marker) {
      return { scope: head.scope, markerId, status: 'REJECTED', reason: 'MARKER_NOT_FOUND' };
    }
    const cart = await this.prisma.cart.findUnique({ where: { id: marker.cartId } });
    if (!cart) {
      return { scope: head.scope, markerId, status: 'REJECTED', reason: 'CART_NOT_FOUND' };
    }

    const fence = await this.fences.latest(this.prisma);
    if (!fence || fence.status !== 'ACKNOWLEDGED' || fence.phase !== 'OPEN' || fence.incarnation !== head.incarnation || fence.epoch !== head.epoch) {
      return { scope: head.scope, markerId, status: 'REJECTED', reason: 'FENCE_NOT_READY' };
    }

    const item = await this.prisma.cartItem.findUnique({
      where: { cartId_productId: { cartId: marker.cartId, productId: marker.productId } },
    });

    const request: InvalidationRequest = {
      version: 1,
      intentId: randomUUID(),
      operationId: randomUUID(),
      kind: 'CART',
      incarnation: fence.incarnation,
      epoch: fence.epoch,
      scopes: [
        {
          kind: 'MARKER',
          markerId,
          customerId: cart.customerId,
          cartId: marker.cartId,
          productId: marker.productId,
          revision: 0,
          before: {
            generation: marker.generation,
            mutationVersion: marker.expectedMutationVersion,
            quantity: marker.expectedQuantity,
          },
          after: {
            generation: marker.generation,
            mutationVersion: marker.expectedMutationVersion,
            quantity: marker.expectedQuantity,
          },
          cartBefore: item ? { id: item.id, mutationVersion: item.mutationVersion, quantity: item.quantity } : null,
          cartAfter: item ? { id: item.id, mutationVersion: item.mutationVersion, quantity: item.quantity } : null,
          ownersBefore: [],
          ownersAfter: [],
        },
      ],
    };

    try {
      await this.invalidationService.prepare(request);
      await this.invalidationService.reconcile(request.intentId);
      await this.publicationService.publish(request.intentId, () => Promise.resolve({ bootstrap: true, markerId }));
      await this.invalidationService.reconcileReadiness(request.intentId);

      const finalized = await this.prisma.ordinaryInvalidationHead.findUnique({ where: { scope: head.scope } });
      if (finalized?.ready) {
        return { scope: head.scope, markerId, status: 'READY', revision: finalized.publishedRevision };
      }
      return { scope: head.scope, markerId, status: 'IN_PROGRESS', reason: 'READINESS_INCOMPLETE' };
    } catch (error) {
      if (error instanceof Error && error.message.includes('INVALIDATION_SCOPE_CONFLICT')) {
        return { scope: head.scope, markerId, status: 'IN_PROGRESS', reason: 'CONCURRENT_WORKER_ACTIVE' };
      }
      return {
        scope: head.scope,
        markerId,
        status: 'FAILED',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
