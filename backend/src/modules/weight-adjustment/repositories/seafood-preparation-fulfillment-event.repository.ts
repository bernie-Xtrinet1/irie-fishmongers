import { Injectable } from '@nestjs/common';
import { Prisma, SeafoodPreparationFulfillmentEvent } from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../database/prisma.service';
import { AppendPreparationEventInput } from './types/weight-adjustment-repository.types';
import { computeCanonicalPayloadHash } from './utils/canonical-hash.util';
import {
  AdjustmentNotFoundError,
  IdempotencyPayloadConflictError,
  ImmutableAuditMutationError,
  StaleRevisionConflictError,
} from './errors/weight-adjustment-repository.errors';

@Injectable()
export class SeafoodPreparationFulfillmentEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends an immutable butchery preparation and usable parts fulfillment event.
   * - Enforces canonical payload hashing and idempotent replay detection.
   * - Atomically advances parent activePreparationRevision via atomic compare-and-swap.
   * - Fences revisions: rejects stale revisions; never silently re-sequences.
   * - Recovers from concurrent idempotency P2002 collisions cleanly.
   * - Strictly append-only: no update or delete operations are permitted.
   */
  async appendPreparationEvent(
    input: AppendPreparationEventInput,
    tx?: Prisma.TransactionClient,
  ): Promise<{ event: SeafoodPreparationFulfillmentEvent; isReplay: boolean }> {
    // 1. Compute canonical payload hash
    const payloadForHashing = {
      weightAdjustmentId: input.weightAdjustmentId,
      expectedRevision: input.expectedRevision,
      preparedNetWeight: input.preparedNetWeight !== undefined && input.preparedNetWeight !== null
        ? new Decimal(input.preparedNetWeight).toFixed(3)
        : null,
      partsOutcome: input.partsOutcome,
      partsDisposalReason: input.partsDisposalReason ?? null,
      preparedPhotoUrl: input.preparedPhotoUrl ?? null,
      operatorUserId: input.operatorUserId,
      correctionReason: input.correctionReason ?? null,
    };
    const payloadHash = computeCanonicalPayloadHash(payloadForHashing);

    // 2. Preliminary check on existing idempotency key
    const client = tx ?? this.prisma;
    const existing = await client.seafoodPreparationFulfillmentEvent.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });

    if (existing) {
      if (existing.payloadHash === payloadHash) {
        return { event: existing, isReplay: true };
      }
      throw new IdempotencyPayloadConflictError(
        input.idempotencyKey,
        existing.payloadHash,
        payloadHash,
      );
    }

    // 3. Execution logic encapsulated for atomic interactive transaction
    const executeInTransaction = async (txClient: Prisma.TransactionClient) => {
      // Fencing check: Query parent adjustment
      const adjustment = await txClient.seafoodOrderWeightAdjustment.findUnique({
        where: { id: input.weightAdjustmentId },
        select: { activePreparationRevision: true },
      });

      if (!adjustment) {
        throw new AdjustmentNotFoundError(input.weightAdjustmentId);
      }

      const currentRevision = adjustment.activePreparationRevision ?? 0;
      if (input.expectedRevision !== currentRevision + 1) {
        throw new StaleRevisionConflictError(
          input.weightAdjustmentId,
          input.expectedRevision,
          currentRevision,
        );
      }

      const netWeightDecimal = input.preparedNetWeight !== undefined && input.preparedNetWeight !== null
        ? new Prisma.Decimal(new Decimal(input.preparedNetWeight).toFixed(3))
        : null;

      // Insert immutable event
      const event = await txClient.seafoodPreparationFulfillmentEvent.create({
        data: {
          weightAdjustmentId: input.weightAdjustmentId,
          revision: input.expectedRevision,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          preparedNetWeight: netWeightDecimal,
          partsOutcome: input.partsOutcome,
          partsDisposalReason: input.partsDisposalReason,
          preparedPhotoUrl: input.preparedPhotoUrl,
          operatorUserId: input.operatorUserId,
          correctionReason: input.correctionReason,
        },
      });

      // Atomic compare-and-swap: update parent only if activePreparationRevision has not drifted
      const updateResult = await txClient.seafoodOrderWeightAdjustment.updateMany({
        where: {
          id: input.weightAdjustmentId,
          activePreparationRevision: adjustment.activePreparationRevision,
        },
        data: {
          activePreparationRevision: input.expectedRevision,
          preparedNetWeight: netWeightDecimal,
          usablePartsOutcome: input.partsOutcome,
        },
      });

      if (updateResult.count === 0) {
        throw new StaleRevisionConflictError(
          input.weightAdjustmentId,
          input.expectedRevision,
          currentRevision,
        );
      }

      return { event, isReplay: false };
    };

    try {
      if (tx) {
        return await executeInTransaction(tx);
      } else {
        return await this.prisma.$transaction(executeInTransaction);
      }
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Recovery outside the failed transaction using fresh client
        const recovered = await this.prisma.seafoodPreparationFulfillmentEvent.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });

        if (recovered) {
          if (recovered.payloadHash === payloadHash) {
            return { event: recovered, isReplay: true };
          }
          throw new IdempotencyPayloadConflictError(
            input.idempotencyKey,
            recovered.payloadHash,
            payloadHash,
          );
        }

        // Target was revision uniqueness constraint (uq_prep_adj_revision)
        throw new StaleRevisionConflictError(
          input.weightAdjustmentId,
          input.expectedRevision,
          input.expectedRevision - 1,
        );
      }
      throw err;
    }
  }

  async findByRevision(
    weightAdjustmentId: string,
    revision: number,
    tx?: Prisma.TransactionClient,
  ): Promise<SeafoodPreparationFulfillmentEvent | null> {
    const client = tx ?? this.prisma;
    return client.seafoodPreparationFulfillmentEvent.findUnique({
      where: {
        uq_prep_adj_revision: {
          weightAdjustmentId,
          revision,
        },
      },
    });
  }

  async findEventsByAdjustmentId(
    weightAdjustmentId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<SeafoodPreparationFulfillmentEvent[]> {
    const client = tx ?? this.prisma;
    return client.seafoodPreparationFulfillmentEvent.findMany({
      where: { weightAdjustmentId },
      orderBy: { revision: 'asc' },
    });
  }

  update(): never {
    throw new ImmutableAuditMutationError('SeafoodPreparationFulfillmentEvent', 'CANNOT_UPDATE');
  }

  delete(): never {
    throw new ImmutableAuditMutationError('SeafoodPreparationFulfillmentEvent', 'CANNOT_DELETE');
  }
}
