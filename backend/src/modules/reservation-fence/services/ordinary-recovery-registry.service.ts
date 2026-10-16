import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InvalidationRequest } from '../types/ordinary-invalidation.types';
import { InvalidationRecoveryHandler } from '../types/ordinary-invalidation-recovery.types';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';

@Injectable()
export class OrdinaryRecoveryRegistryService {
  private readonly handlers = new Map<string, InvalidationRecoveryHandler>();

  constructor(
    @Optional() private readonly modeService?: ReservationEngineModeService,
  ) {
    this.registerDefaultHandlers();
  }

  private registerDefaultHandlers(): void {
    // 1. Bootstrap Handler for initial marker publication (rev 0 -> rev 1)
    this.registerHandler({
      kind: 'CART',
      subtype: 'BOOTSTRAP',
      validateRequest(request: InvalidationRequest): boolean {
        if (request.kind !== 'CART' || request.scopes.length !== 1) return false;
        const scope = request.scopes[0];
        return (
          scope !== undefined &&
          scope.kind === 'MARKER' &&
          scope.revision === 0 &&
          scope.before.generation === scope.after.generation &&
          scope.before.mutationVersion === scope.after.mutationVersion &&
          scope.before.quantity === scope.after.quantity
        );
      },
      assertPreconditions(_tx: Prisma.TransactionClient, _request: InvalidationRequest): Promise<void> {
        // Domain preconditions are verified by assertState in publication
        return Promise.resolve();
      },
      execute(_tx: Prisma.TransactionClient, request: InvalidationRequest): Promise<Prisma.InputJsonValue> {
        const markerId = request.scopes[0] && request.scopes[0].kind === 'MARKER' ? request.scopes[0].markerId : 'unknown';
        return Promise.resolve({ bootstrap: true, markerId });
      },
    });

    // 2. Mode Recovery Handler (if mode service is available)
    if (this.modeService) {
      const modes = this.modeService;
      this.registerHandler({
        kind: 'MODE',
        validateRequest(request: InvalidationRequest): boolean {
          if (request.kind !== 'MODE' || request.scopes.length !== 1) return false;
          const scope = request.scopes[0];
          return scope !== undefined && scope.kind === 'GLOBAL' && scope.modeAfter === 'DRAINING';
        },
        assertPreconditions(_tx: Prisma.TransactionClient, _request: InvalidationRequest): Promise<void> {
          // Preconditions verified by assertState
          return Promise.resolve();
        },
        async execute(tx: Prisma.TransactionClient, _request: InvalidationRequest): Promise<Prisma.InputJsonValue> {
          const result = await modes.restrictInTransaction(tx, { targetMode: 'DRAINING', updatedById: 'RECOVERY_COORDINATOR' });
          if (!result.ok) throw new Error(`MODE_PUBLICATION_${result.code}`);
          return { modeId: result.id, mode: result.mode };
        },
      });
    }
  }

  registerHandler(handler: InvalidationRecoveryHandler): void {
    const key = this.handlerKey(handler.kind, handler.subtype);
    this.handlers.set(key, handler);
  }

  getHandler(kind: InvalidationRecoveryHandler['kind'], subtype?: string): InvalidationRecoveryHandler | undefined {
    // Exact match (kind + subtype) first
    if (subtype) {
      const exact = this.handlers.get(this.handlerKey(kind, subtype));
      if (exact) return exact;
    }
    // Fall back to kind-only default handler
    return this.handlers.get(this.handlerKey(kind));
  }

  findHandlerForRequest(request: InvalidationRequest): InvalidationRecoveryHandler | undefined {
    // Check if it's bootstrap
    if (request.kind === 'CART' && request.scopes.length === 1 && request.scopes[0]?.kind === 'MARKER' && request.scopes[0].revision === 0) {
      const bootstrapHandler = this.getHandler('CART', 'BOOTSTRAP');
      if (bootstrapHandler && bootstrapHandler.validateRequest(request)) return bootstrapHandler;
    }

    const handler = this.getHandler(request.kind);
    if (handler && handler.validateRequest(request)) return handler;
    return undefined;
  }

  private handlerKey(kind: string, subtype?: string): string {
    return subtype ? `${kind}:${subtype}` : kind;
  }
}
