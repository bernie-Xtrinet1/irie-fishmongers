import { randomUUID } from 'crypto';

import { ConflictException } from '@nestjs/common';
import {
  PaymentStatus,
  Prisma,
  RefundAttemptEventType,
  RefundAttemptFailureClass,
  RefundAttemptStatus,
  RefundObligation,
  RefundObligationStatus,
  RefundStatus,
} from '@prisma/client';

import { RecordAttemptOutcomeInput, RefundAttemptOutcomeResult } from '../types/refund-ledger.types';
import {
  executePreSendAbortTx,
  executeQuarantineOutcomeTx,
  fetchAttemptBundleTx,
  getNextEventSequenceTx,
  resolveSyncProvenance,
} from './refund-attempt-quarantine.helper';
import {
  buildRefundOutboxLogicalKey,
  sanitizeRefundPayload,
  sha256Hex,
} from './refund-locks.helper';

export { executePreSendAbortTx, executeQuarantineOutcomeTx };

export async function executeSyncOutcomeTx(
  tx: Prisma.TransactionClient,
  input: RecordAttemptOutcomeInput,
): Promise<RefundAttemptOutcomeResult> {
  const bundle = await fetchAttemptBundleTx(tx, input.attemptId, input.paymentId);
  const { attempt, obligation, customerId, orderId, paymentAmount, paymentReference } = bundle;
  const refund = await tx.refund.findUniqueOrThrow({ where: { id: attempt.refundId } });

  const expected = new Prisma.Decimal(input.expectedAmount);
  if (!new Prisma.Decimal(refund.amount).equals(expected)) {
    throw new ConflictException(
      `Refund amount mismatch: expected ${expected.toFixed(2)}, got ${new Prisma.Decimal(refund.amount).toFixed(2)}`,
    );
  }

  const trimmedRef = input.providerRefundReference?.trim() || null;
  if (trimmedRef && paymentReference && trimmedRef === paymentReference.trim()) {
    throw new ConflictException(
      `Provider refund reference "${trimmedRef}" cannot equal parent charge reference`,
    );
  }
  if (input.providerOutcome === 'COMPLETED' && !trimmedRef) {
    throw new ConflictException('Completed provider refund outcome requires non-empty providerRefundReference');
  }

  const targetAttemptStatus =
    input.providerOutcome === 'COMPLETED'
      ? RefundAttemptStatus.COMPLETED
      : input.providerOutcome === 'PENDING'
        ? RefundAttemptStatus.PROVIDER_PENDING
        : RefundAttemptStatus.FAILED;

  if (attempt.status === targetAttemptStatus) {
    if (trimmedRef && attempt.providerRefundReference && trimmedRef !== attempt.providerRefundReference) {
      throw new ConflictException(
        `Conflicting provider refund reference on attempt "${attempt.id}"`,
      );
    }
    return { obligation, refund, attempt };
  }

  if (
    attempt.status !== RefundAttemptStatus.DISPATCHING &&
    attempt.status !== RefundAttemptStatus.PROVIDER_PENDING
  ) {
    throw new ConflictException(
      `Refund attempt "${attempt.id}" cannot apply sync outcome ${targetAttemptStatus} from ${attempt.status}`,
    );
  }

  const now = new Date();
  const nextSeq = await getNextEventSequenceTx(tx, attempt.id);
  const provenance = resolveSyncProvenance(attempt.provider);
  const eventId = randomUUID();

  await tx.refundProviderAttemptEvent.create({
    data: {
      id: eventId,
      attemptId: attempt.id,
      refundId: refund.id,
      obligationId: obligation.id,
      eventSequence: nextSeq,
      eventType: RefundAttemptEventType.PROVIDER_SYNC_RESPONSE,
      previousAttemptStatus: attempt.status,
      resultingAttemptStatus: targetAttemptStatus,
      provenance,
      provider: attempt.provider,
      merchantAccountId: attempt.merchantAccountId,
      providerRefundReference: trimmedRef,
      httpStatusCode: input.httpStatusCode ?? null,
      evidenceDigest: sha256Hex({
        attemptId: attempt.id,
        outcome: input.providerOutcome,
        providerRefundReference: trimmedRef,
        rawResponsePayload: input.rawResponsePayload ?? null,
      }),
      sanitizedPayload: sanitizeRefundPayload(
        input.rawResponsePayload ?? { status: input.providerOutcome, providerReference: trimmedRef },
      ),
      actorId: input.actor?.actorId ?? null,
      actorRole: input.actor?.actorRole ?? null,
      occurredAt: now,
    },
  });

  const updatedAttempt = await tx.refundProviderAttempt.update({
    where: { id: attempt.id },
    data: {
      status: targetAttemptStatus,
      providerRefundReference: trimmedRef ?? attempt.providerRefundReference,
      providerRespondedAt: now,
      terminalizedAt: targetAttemptStatus === RefundAttemptStatus.PROVIDER_PENDING ? null : now,
      failureClassification:
        targetAttemptStatus === RefundAttemptStatus.FAILED
          ? (input.failureClass ?? RefundAttemptFailureClass.PROVIDER_DEFINITIVE_DECLINE)
          : RefundAttemptFailureClass.NONE,
      retryEligible:
        targetAttemptStatus === RefundAttemptStatus.FAILED ? (input.retryEligible ?? true) : false,
      resolvedByProvenance: provenance,
      resolvedByEventId:
        targetAttemptStatus === RefundAttemptStatus.PROVIDER_PENDING ? null : eventId,
      version: { increment: 1 },
    },
  });

  const targetRefundStatus =
    targetAttemptStatus === RefundAttemptStatus.COMPLETED
      ? RefundStatus.COMPLETED
      : targetAttemptStatus === RefundAttemptStatus.PROVIDER_PENDING
        ? RefundStatus.PENDING
        : RefundStatus.FAILED;

  const updatedRefund = await tx.refund.update({
    where: { id: refund.id },
    data: {
      status: targetRefundStatus,
      ...(trimmedRef ? { providerReference: trimmedRef } : {}),
    },
  });

  let updatedObligation: RefundObligation;
  if (targetAttemptStatus === RefundAttemptStatus.COMPLETED) {
    const completedSum = await tx.refund.aggregate({
      where: { paymentId: input.paymentId, status: RefundStatus.COMPLETED },
      _sum: { amount: true },
    });
    const totalRefunded = completedSum._sum.amount ?? new Prisma.Decimal(0);
    if (totalRefunded.gt(paymentAmount)) {
      throw new ConflictException(
        `Total completed refunds (${totalRefunded.toFixed(2)}) exceed payment amount (${paymentAmount.toFixed(2)})`,
      );
    }

    await tx.payment.update({
      where: { id: input.paymentId },
      data: {
        status: totalRefunded.gte(paymentAmount)
          ? PaymentStatus.REFUNDED
          : PaymentStatus.PARTIALLY_REFUNDED,
      },
    });

    updatedObligation = await tx.refundObligation.update({
      where: { id: obligation.id },
      data: {
        status: RefundObligationStatus.FULFILLED,
        fulfilledRefundId: updatedRefund.id,
        fulfilledAttemptId: updatedAttempt.id,
      },
    });
  } else if (targetAttemptStatus === RefundAttemptStatus.PROVIDER_PENDING) {
    updatedObligation = await tx.refundObligation.update({
      where: { id: obligation.id },
      data: { status: RefundObligationStatus.PENDING_PROVIDER },
    });
  } else {
    updatedObligation = await tx.refundObligation.update({
      where: { id: obligation.id },
      data: { status: RefundObligationStatus.OPEN },
    });
  }

  const outbox = await tx.paymentOutbox.create({
    data: {
      aggregateId: updatedRefund.id,
      aggregateType: 'Refund',
      eventType: 'REFUND_STATUS_CHANGED',
      payload: {
        logicalEventKey: buildRefundOutboxLogicalKey({
          eventType: 'REFUND_STATUS_CHANGED',
          attemptId: updatedAttempt.id,
          eventSequence: nextSeq,
        }),
        sourceEventId: eventId,
        eventSequence: nextSeq,
        refundId: updatedRefund.id,
        paymentId: input.paymentId,
        orderId,
        obligationId: updatedObligation.id,
        attemptId: updatedAttempt.id,
        customerId,
        amount: updatedRefund.amount.toString(),
        status: updatedRefund.status,
        attemptStatus: updatedAttempt.status,
        timestamp: now.toISOString(),
      },
      published: false,
    },
  });

  return {
    obligation: updatedObligation,
    refund: updatedRefund,
    attempt: updatedAttempt,
    outboxEventId: outbox.id,
  };
}
