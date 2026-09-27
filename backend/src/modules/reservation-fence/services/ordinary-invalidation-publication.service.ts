import { Prisma } from '@prisma/client';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { SetReservationEngineModeInput } from '../../reservation-engine-mode/types/reservation-engine-mode.types';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { barrierAcknowledgement, canonicalInvalidationJson, invalidationDigest, invalidationScopeKey } from '../types/ordinary-invalidation.types';

// No Redis dependency. The supplied domain operation uses this exact tx for
// cart, marker, idempotency/compensation/order writes; no business logic copy.
export class OrdinaryInvalidationPublicationService {
  constructor(private readonly repository: OrdinaryInvalidationRepository) {}

  async publishNew(intentId: string, domain: (tx: Prisma.TransactionClient) => Promise<Prisma.InputJsonValue>) {
    return this.publishInternal(intentId, domain, false);
  }

  async publish(intentId: string, domain: (tx: Prisma.TransactionClient) => Promise<Prisma.InputJsonValue>) {
    return this.publishInternal(intentId, domain, true);
  }

  private async publishInternal(intentId: string, domain: (tx: Prisma.TransactionClient) => Promise<Prisma.InputJsonValue>, recover: boolean) {
    const reference = await this.repository.read(intentId);
    if (!reference) throw new Error('UNKNOWN_INVALIDATION');
    const request = this.repository.request(reference.request);
    try {
      return await this.repository.locked(request, async tx => {
        const intent = await tx.ordinaryInvalidationIntent.findUniqueOrThrow({ where: { id: intentId } });
        if (intent.status === 'PUBLISHED') {
          if (!recover) throw new Error('PUBLICATION_ALREADY_COMMITTED');
          return intent;
        }
        const ack = barrierAcknowledgement(request);
        if (intent.status !== 'BARRIER_CONFIRMED' || intent.digest !== invalidationDigest(request)
          || intent.acknowledgement !== canonicalInvalidationJson(ack) || intent.acknowledgementHash !== invalidationDigest(ack))
          throw new Error('EXACT_BARRIER_CONFIRMATION_REQUIRED');
        for (const scope of request.scopes) {
          const head = await tx.ordinaryInvalidationHead.findUniqueOrThrow({ where: { scope: invalidationScopeKey(scope) } });
          if (head.pendingIntentId !== intentId || head.allocatedRevision !== scope.revision + 1)
            throw new Error('PUBLICATION_SUPERSEDED');
        }
        await this.repository.assertState(tx, request, 'before');
        const [identity] = await tx.$queryRaw<{ id: bigint }[]>`SELECT txid_current() AS id`;
        if (!identity) throw new Error('MISSING_TRANSACTION_IDENTITY');
        await tx.ordinaryInvalidationIntent.update({ where: { id: intentId }, data: { publicationTx: identity.id } });
        const resultReference = await domain(tx);
        await this.repository.assertState(tx, request, 'after');
        const result = await tx.ordinaryInvalidationIntent.update({ where: { id: intentId }, data: {
          status: 'PUBLISHED', publishedAt: new Date(), resultReference } });
        for (const scope of request.scopes) await tx.ordinaryInvalidationHead.update({ where: { scope: invalidationScopeKey(scope) },
          data: { publishedRevision: scope.revision + 1, pendingIntentId: null, ready: false } });
        return result;
      });
    } catch (error) {
      if (!recover) throw error;
      // Read the committed result, never invoke domain mutation a second time.
      const retained = await this.repository.read(intentId);
      if (retained?.status === 'PUBLISHED' && retained.digest === reference.digest) return retained;
      throw error;
    }
  }

  async publishMode(intentId: string, modes: ReservationEngineModeService, input: SetReservationEngineModeInput) {
    const intent = await this.repository.read(intentId);
    if (!intent || intent.kind !== 'MODE') throw new Error('MODE_INTENT_REQUIRED');
    return this.publish(intentId, async tx => {
      const result = await modes.restrictInTransaction(tx, input);
      if (!result.ok) throw new Error(`MODE_PUBLICATION_${result.code}`);
      return { modeId: result.id, mode: result.mode };
    });
  }
}
