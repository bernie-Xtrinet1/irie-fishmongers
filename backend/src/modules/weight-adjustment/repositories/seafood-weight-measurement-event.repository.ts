import { Injectable } from '@nestjs/common';
import { Prisma, SeafoodWeightMeasurementEvent } from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../database/prisma.service';
import { AppendMeasurementEventInput } from './types/weight-adjustment-repository.types';
import { computeCanonicalPayloadHash } from './utils/canonical-hash.util';
import {
  AdjustmentNotFoundError,
  IdempotencyPayloadConflictError,
  ImmutableAuditMutationError,
  StaleRevisionConflictError,
} from './errors/weight-adjustment-repository.errors';

@Injectable()
export class SeafoodWeightMeasurementEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends an immutable scale weight measurement event.
   * - Enforces canonical payload hashing and idempotent replay detection.
   * - Atomically advances parent activeMeasurementRevision via atomic compare-and-swap.
   * - Fences revisions: rejects stale revisions; never silently re-sequences.
   * - Recovers from concurrent idempotency P2002 collisions cleanly.
   * - Strictly append-only: no update or delete operations are permitted.
   */
  async appendMeasurementEvent(
    input: AppendMeasurementEventInput,
    tx?: Prisma.TransactionClient,
  ): Promise<{ event: SeafoodWeightMeasurementEvent; isReplay: boolean }> {
    // 1. Compute canonical payload hash
    const payloadForHashing = {
      weightAdjustmentId: input.weightAdjustmentId,
      expectedRevision: input.expectedRevision,
      pricingBasis: input.pricingBasis,
      unit: input.unit,
      measuredWeight: new Decimal(input.measuredWeight).toFixed(3),
      scalePhotoUrl: input.scalePhotoUrl,
      scaleDeviceIdentifier: input.scaleDeviceIdentifier ?? null,
      scaleCalibrationDate: input.scaleCalibrationDate ? input.scaleCalibrationDate.toISOString() : null,
      operatorUserId: input.operatorUserId,
      correctionReason: input.correctionReason ?? null,
    };
    const payloadHash = computeCanonicalPayloadHash(payloadForHashing);

    // 2. Preliminary check on existing idempotency key
    const client = tx ?? this.prisma;
    const existing = await client.seafoodWeightMeasurementEvent.findUnique({
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
      // In-transaction check: query for existing idempotency key on current transaction client before attempting insert
      const inTxExisting = await txClient.seafoodWeightMeasurementEvent.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (inTxExisting) {
        if (inTxExisting.payloadHash === payloadHash) {
          return { event: inTxExisting, isReplay: true };
        }
        throw new IdempotencyPayloadConflictError(
          input.idempotencyKey,
          inTxExisting.payloadHash,
          payloadHash,
        );
      }

      // Fencing check: Query parent adjustment
      const adjustment = await txClient.seafoodOrderWeightAdjustment.findUnique({
        where: { id: input.weightAdjustmentId },
        select: { activeMeasurementRevision: true },
      });

      if (!adjustment) {
        throw new AdjustmentNotFoundError(input.weightAdjustmentId);
      }

      const currentRevision = adjustment.activeMeasurementRevision ?? 0;
      if (input.expectedRevision !== currentRevision + 1) {
        throw new StaleRevisionConflictError(
          input.weightAdjustmentId,
          input.expectedRevision,
          currentRevision,
        );
      }

      const measuredWeightDecimal = new Prisma.Decimal(new Decimal(input.measuredWeight).toFixed(3));

      // Insert immutable event
      const event = await txClient.seafoodWeightMeasurementEvent.create({
        data: {
          weightAdjustmentId: input.weightAdjustmentId,
          revision: input.expectedRevision,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          pricingBasis: input.pricingBasis,
          unit: input.unit,
          measuredWeight: measuredWeightDecimal,
          scalePhotoUrl: input.scalePhotoUrl,
          scaleDeviceIdentifier: input.scaleDeviceIdentifier,
          scaleCalibrationDate: input.scaleCalibrationDate,
          operatorUserId: input.operatorUserId,
          correctionReason: input.correctionReason,
        },
      });

      // Atomic compare-and-swap: update parent only if activeMeasurementRevision has not drifted
      const updateResult = await txClient.seafoodOrderWeightAdjustment.updateMany({
        where: {
          id: input.weightAdjustmentId,
          activeMeasurementRevision: adjustment.activeMeasurementRevision,
        },
        data: {
          activeMeasurementRevision: input.expectedRevision,
          verifiedBillableWeight: measuredWeightDecimal,
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

    // 4. If an external transaction was supplied:
    // Execute directly inside the caller's transaction.
    // On P2002 or any error, do NOT catch and query a fallback client.
    // Propagate the error so the caller's transaction rolls back cleanly without issuing further SQL against an aborted transaction.
    if (tx) {
      return await executeInTransaction(tx);
    }

    // 5. Standalone repository transaction mode:
    // Run inside its own isolated transaction.
    // If P2002 occurs, $transaction rolls back first.
    // Replay recovery is performed ONLY after the transaction has rolled back.
    try {
      return await this.prisma.$transaction(executeInTransaction);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Recovery outside the failed standalone transaction using fresh client ONLY after its transaction has rolled back
        const recovered = await this.prisma.seafoodWeightMeasurementEvent.findUnique({
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

        // Target was revision uniqueness constraint (uq_weight_adj_revision)
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
  ): Promise<SeafoodWeightMeasurementEvent | null> {
    const client = tx ?? this.prisma;
    return client.seafoodWeightMeasurementEvent.findUnique({
      where: {
        uq_weight_adj_revision: {
          weightAdjustmentId,
          revision,
        },
      },
    });
  }

  async findEventsByAdjustmentId(
    weightAdjustmentId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<SeafoodWeightMeasurementEvent[]> {
    const client = tx ?? this.prisma;
    return client.seafoodWeightMeasurementEvent.findMany({
      where: { weightAdjustmentId },
      orderBy: { revision: 'asc' },
    });
  }

  update(): never {
    throw new ImmutableAuditMutationError('SeafoodWeightMeasurementEvent', 'CANNOT_UPDATE');
  }

  delete(): never {
    throw new ImmutableAuditMutationError('SeafoodWeightMeasurementEvent', 'CANNOT_DELETE');
  }
}
