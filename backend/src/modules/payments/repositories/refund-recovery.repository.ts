import { randomUUID } from 'crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  RefundAttemptEventType,
  RefundAttemptFailureClass,
  RefundAttemptStatus,
  RefundEvidenceProvenance,
  RefundObligationStatus,
  RefundStatus,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { RefundDispatchActor } from '../types/refund-ledger.types';
import {
  RecoverExpiredAttemptOutcome,
  RecoverExpiredLeasesSummary,
} from '../types/refund-reconciliation.types';
import { getNextEventSequenceTx } from './refund-attempt-quarantine.helper';
import {
  buildRefundOutboxLogicalKey,
  lockPaymentObligationsAndRefunds,
  lockRefundFinancialHierarchy,
  sanitizeRefundPayload,
  sha256Hex,
} from './refund-locks.helper';

export async function recoverExpiredDispatchingAttemptWithClient(
  prisma: PrismaService,
  attemptId: string,
  paymentIdHint: string | null,
  referenceTime: Date,
  actor?: RefundDispatchActor,
): Promise<RecoverExpiredAttemptOutcome> {
  let effectivePaymentId = paymentIdHint;
  if (!effectivePaymentId) {
    const meta = await prisma.refundProviderAttempt.findUnique({
      where: { id: attemptId },
      select: { id: true, paymentId: true },
    });
    if (!meta) {
      throw new NotFoundException(`Refund provider attempt "${attemptId}" not found`);
    }
    effectivePaymentId = meta.paymentId;
  }

  return prisma.$transaction(
    async (tx) => {
      const payment = await lockRefundFinancialHierarchy(tx, effectivePaymentId);
      if (!payment) {
        throw new NotFoundException(`Payment "${effectivePaymentId}" not found for attempt recovery`);
      }
      await lockPaymentObligationsAndRefunds(tx, effectivePaymentId);

      const attempt = await tx.refundProviderAttempt.findUnique({
        where: { id: attemptId },
      });
      if (!attempt) {
        throw new NotFoundException(`Refund provider attempt "${attemptId}" not found`);
      }

      if (attempt.status !== RefundAttemptStatus.DISPATCHING) {
        return {
          attemptId: attempt.id,
          refundId: attempt.refundId,
          obligationId: attempt.obligationId,
          transitioned: false,
          previousAttemptStatus: attempt.status,
          resultingAttemptStatus: attempt.status,
          reason: `Attempt is in status ${attempt.status}, not DISPATCHING`,
        };
      }

      if (!attempt.leaseExpiresAt || attempt.leaseExpiresAt > referenceTime) {
        return {
          attemptId: attempt.id,
          refundId: attempt.refundId,
          obligationId: attempt.obligationId,
          transitioned: false,
          previousAttemptStatus: attempt.status,
          resultingAttemptStatus: attempt.status,
          reason: 'DISPATCHING lease has not expired yet',
        };
      }

      const now = new Date();
      const casUpdated = await tx.refundProviderAttempt.updateMany({
        where: {
          id: attempt.id,
          status: RefundAttemptStatus.DISPATCHING,
          version: attempt.version,
          leaseExpiresAt: { lte: referenceTime },
        },
        data: {
          status: RefundAttemptStatus.AMBIGUOUS_OUTCOME,
          failureClassification: RefundAttemptFailureClass.PROCESS_CRASH_SUSPECTED,
          retryEligible: false,
          quarantinedAt: now,
          pollLockUntil: null,
          version: { increment: 1 },
        },
      });

      if (casUpdated.count !== 1) {
        const latest = await tx.refundProviderAttempt.findUniqueOrThrow({
          where: { id: attempt.id },
          select: { status: true },
        });
        return {
          attemptId: attempt.id,
          refundId: attempt.refundId,
          obligationId: attempt.obligationId,
          transitioned: false,
          previousAttemptStatus: attempt.status,
          resultingAttemptStatus: latest.status,
          reason: 'CAS predicate rejected concurrent update during lease recovery',
        };
      }

      const nextSeq = await getNextEventSequenceTx(tx, attempt.id);
      const eventId = randomUUID();
      await tx.refundProviderAttemptEvent.create({
        data: {
          id: eventId,
          attemptId: attempt.id,
          refundId: attempt.refundId,
          obligationId: attempt.obligationId,
          eventSequence: nextSeq,
          eventType: RefundAttemptEventType.LEASE_EXPIRED_QUARANTINED,
          previousAttemptStatus: RefundAttemptStatus.DISPATCHING,
          resultingAttemptStatus: RefundAttemptStatus.AMBIGUOUS_OUTCOME,
          provenance: RefundEvidenceProvenance.LEASE_TIMEOUT_SWEEPER,
          provider: attempt.provider,
          merchantAccountId: attempt.merchantAccountId,
          evidenceDigest: sha256Hex({
            attemptId: attempt.id,
            leaseExpiresAt: attempt.leaseExpiresAt.toISOString(),
            referenceTime: referenceTime.toISOString(),
          }),
          sanitizedPayload: sanitizeRefundPayload({
            leaseExpiresAt: attempt.leaseExpiresAt.toISOString(),
            referenceTime: referenceTime.toISOString(),
            recoveredAt: now.toISOString(),
            reason: 'DISPATCHING lease expired; process crash suspected',
          }),
          actorId: actor?.actorId ?? null,
          actorRole: actor?.actorRole ?? null,
          occurredAt: now,
        },
      });

      const refund = await tx.refund.findUniqueOrThrow({ where: { id: attempt.refundId } });
      if (
        refund.status !== RefundStatus.RECONCILE_REQUIRED &&
        refund.status !== RefundStatus.COMPLETED &&
        refund.status !== RefundStatus.FAILED
      ) {
        await tx.refund.update({
          where: { id: refund.id },
          data: { status: RefundStatus.RECONCILE_REQUIRED },
        });
      }

      const obligation = await tx.refundObligation.findUniqueOrThrow({
        where: { id: attempt.obligationId },
      });
      if (
        obligation.status !== RefundObligationStatus.RECONCILE_REQUIRED &&
        obligation.status !== RefundObligationStatus.FULFILLED &&
        obligation.status !== RefundObligationStatus.CANCELLED_VOIDED
      ) {
        await tx.refundObligation.update({
          where: { id: obligation.id },
          data: { status: RefundObligationStatus.RECONCILE_REQUIRED },
        });
      }

      const logicalEventKey = buildRefundOutboxLogicalKey({
        eventType: 'REFUND_LEASE_EXPIRED_QUARANTINED',
        attemptId: attempt.id,
        eventSequence: nextSeq,
      });

      const outbox = await tx.paymentOutbox.create({
        data: {
          aggregateId: attempt.refundId,
          aggregateType: 'Refund',
          eventType: 'REFUND_LEASE_EXPIRED_QUARANTINED',
          payload: {
            logicalEventKey,
            sourceEventId: eventId,
            eventSequence: nextSeq,
            attemptId: attempt.id,
            refundId: attempt.refundId,
            obligationId: attempt.obligationId,
            paymentId: attempt.paymentId,
            orderId: payment.orderId,
            status: RefundStatus.RECONCILE_REQUIRED,
            attemptStatus: RefundAttemptStatus.AMBIGUOUS_OUTCOME,
            leaseExpiresAt: attempt.leaseExpiresAt.toISOString(),
            quarantinedAt: now.toISOString(),
            actorId: actor?.actorId ?? null,
          },
          published: false,
        },
      });

      return {
        attemptId: attempt.id,
        refundId: attempt.refundId,
        obligationId: attempt.obligationId,
        transitioned: true,
        previousAttemptStatus: RefundAttemptStatus.DISPATCHING,
        resultingAttemptStatus: RefundAttemptStatus.AMBIGUOUS_OUTCOME,
        attemptEventId: eventId,
        outboxEventId: outbox.id,
        reason: 'Expired DISPATCHING lease quarantined to AMBIGUOUS_OUTCOME',
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 15_000,
      timeout: 15_000,
    },
  );
}

export async function recoverExpiredDispatchingLeasesWithClient(
  prisma: PrismaService,
  referenceTime = new Date(),
  limit?: number,
  actor?: RefundDispatchActor,
): Promise<RecoverExpiredLeasesSummary> {
  const candidates = await prisma.refundProviderAttempt.findMany({
    where: {
      status: RefundAttemptStatus.DISPATCHING,
      leaseExpiresAt: { lte: referenceTime },
    },
    orderBy: [{ paymentId: 'asc' }, { id: 'asc' }],
    ...(limit && limit > 0 ? { take: limit } : {}),
    select: { id: true, paymentId: true },
  });

  const results: RecoverExpiredAttemptOutcome[] = [];
  const quarantinedIds: string[] = [];
  let skippedCount = 0;

  for (const candidate of candidates) {
    const outcome = await recoverExpiredDispatchingAttemptWithClient(
      prisma,
      candidate.id,
      candidate.paymentId,
      referenceTime,
      actor,
    );
    results.push(outcome);
    if (outcome.transitioned) {
      quarantinedIds.push(outcome.attemptId);
    } else {
      skippedCount += 1;
    }
  }

  return {
    scannedCount: candidates.length,
    quarantinedIds,
    skippedCount,
    results,
  };
}

@Injectable()
export class RefundRecoveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  recoverExpiredAttempt(
    attemptId: string,
    referenceTime = new Date(),
    actor?: RefundDispatchActor,
  ): Promise<RecoverExpiredAttemptOutcome> {
    return recoverExpiredDispatchingAttemptWithClient(
      this.prisma,
      attemptId,
      null,
      referenceTime,
      actor,
    );
  }

  recoverExpiredLeases(
    referenceTime = new Date(),
    limit = 50,
    actor?: RefundDispatchActor,
  ): Promise<RecoverExpiredLeasesSummary> {
    return recoverExpiredDispatchingLeasesWithClient(this.prisma, referenceTime, limit, actor);
  }
}
