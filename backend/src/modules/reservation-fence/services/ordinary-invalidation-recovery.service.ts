import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { OrdinaryInvalidationService } from './ordinary-invalidation.service';
import { OrdinaryInvalidationPublicationService } from './ordinary-invalidation-publication.service';
import { OrdinaryRecoveryRegistryService } from './ordinary-recovery-registry.service';
import { RecoveryResult } from '../types/ordinary-invalidation-recovery.types';
import { InvalidationRequest } from '../types/ordinary-invalidation.types';

@Injectable()
export class OrdinaryInvalidationRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: OrdinaryInvalidationRepository,
    private readonly invalidationService: OrdinaryInvalidationService,
    private readonly publicationService: OrdinaryInvalidationPublicationService,
    private readonly registry: OrdinaryRecoveryRegistryService,
  ) {}

  async recoverIntent(intentId: string): Promise<RecoveryResult> {
    const intent = await this.repository.read(intentId);
    if (!intent) {
      return { intentId, disposition: 'BLOCKED_MANUAL_REVIEW', reason: 'UNKNOWN_INVALIDATION' };
    }

    if (intent.status === 'SUPERSEDED') {
      return { intentId, disposition: 'SUPERSEDED', reason: 'ALREADY_SUPERSEDED' };
    }

    if (intent.status === 'PUBLISHED') {
      let needsReadiness = false;
      for (const scope of intent.scopes) {
        const head = await this.prisma.ordinaryInvalidationHead.findUnique({ where: { scope: scope.scope } });
        if (head && !head.ready) {
          needsReadiness = true;
          break;
        }
      }
      if (needsReadiness) {
        try {
          await this.invalidationService.reconcileReadiness(intentId);
          return { intentId, disposition: 'READY_RECONCILED' };
        } catch (readinessErr) {
          return {
            intentId,
            disposition: 'BLOCKED_MANUAL_REVIEW',
            reason: 'READINESS_RECONCILE_FAILED',
            error: readinessErr instanceof Error ? readinessErr.message : String(readinessErr),
          };
        }
      }
      return { intentId, disposition: 'ALREADY_PUBLISHED' };
    }

    // If PREPARED, attempt same-intent idempotent reconciliation to advance to BARRIER_CONFIRMED
    if (intent.status === 'PREPARED') {
      try {
        await this.invalidationService.reconcile(intentId);
      } catch (reconcileErr) {
        return {
          intentId,
          disposition: 'BLOCKED_MANUAL_REVIEW',
          reason: 'SAME_INTENT_RECONCILE_FAILED',
          error: reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr),
        };
      }
    }

    // Re-read intent after reconcile
    const current = await this.repository.read(intentId);
    if (!current || current.status !== 'BARRIER_CONFIRMED') {
      return {
        intentId,
        disposition: 'BLOCKED_MANUAL_REVIEW',
        reason: current ? `UNEXPECTED_STATUS:${current.status}` : 'INTENT_DISAPPEARED',
      };
    }

    // We are now in BARRIER_CONFIRMED. Check for a registered deterministic recovery handler.
    const request = this.repository.request(current.request);
    const handler = this.registry.findHandlerForRequest(request);

    if (!handler) {
      // Unsupported operation: do not invent snapshots or auto-supersede. Fail closed.
      return {
        intentId,
        disposition: 'BLOCKED_MANUAL_REVIEW',
        reason: `UNSUPPORTED_RECOVERY_OPERATION:${request.kind}`,
      };
    }

    try {
      await this.publicationService.publish(intentId, async tx => {
        await handler.assertPreconditions(tx, request);
        return handler.execute(tx, request);
      });

      await this.invalidationService.reconcileReadiness(intentId);

      return {
        intentId,
        disposition: 'REPLAYED',
        publishedRevision: request.scopes[0]?.revision !== undefined ? request.scopes[0].revision + 1 : undefined,
      };
    } catch (pubErr) {
      return {
        intentId,
        disposition: 'BLOCKED_MANUAL_REVIEW',
        reason: 'REPLAY_PUBLICATION_FAILED',
        error: pubErr instanceof Error ? pubErr.message : String(pubErr),
      };
    }
  }

  async supersedeIntent(intentId: string, replacement: InvalidationRequest): Promise<RecoveryResult> {
    try {
      await this.invalidationService.supersede(intentId, replacement);
      return { intentId, disposition: 'SUPERSEDED' };
    } catch (err) {
      return {
        intentId,
        disposition: 'BLOCKED_MANUAL_REVIEW',
        reason: 'SUPERSEDE_FAILED',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
