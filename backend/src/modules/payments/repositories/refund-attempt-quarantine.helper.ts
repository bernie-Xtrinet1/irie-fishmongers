import { randomUUID } from 'crypto';

import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  RefundAttemptEventType,
  RefundAttemptFailureClass,
  RefundAttemptStatus,
  RefundEvidenceProvenance,
  RefundObligation,
  RefundObligationStatus,
  RefundProviderAttempt,
  RefundStatus,
} from '@prisma/client';

import {
  QuarantineAttemptInput,
  RecordPreSendAbortInput,
  RefundAttemptOutcomeResult,
} from '../types/refund-ledger.types';
import {
  buildRefundOutboxLogicalKey,
  lockPaymentObligationsAndRefunds,
  lockRefundFinancialHierarchy,
  sanitizeRefundPayload,
  sha256Hex,
} from './refund-locks.helper';

export function resolveSyncProvenance(provider: PaymentProviderName): RefundEvidenceProvenance {
  return provider === PaymentProviderName.CASH_ON_DELIVERY
    ? RefundEvidenceProvenance.INTERNAL_COD_ADAPTER
    : RefundEvidenceProvenance.APPLICATION_SYNC_RESPONSE;
}

export async function getNextEventSequenceTx(
  tx: Prisma.TransactionClient,
  attemptId: string,
): Promise<number> {
  const agg = await tx.refundProviderAttemptEvent.aggregate({
    where: { attemptId },
    _max: { eventSequence: true },
  });
  return (agg._max.eventSequence ?? 0) + 1;
}

export async function fetchAttemptBundleTx(
  tx: Prisma.TransactionClient,
  attemptId: string,
  paymentId: string,
): Promise<{
  attempt: RefundProviderAttempt;
  obligation: RefundObligation;
  customerId: string;
  orderId: string;
  paymentAmount: Prisma.Decimal;
  paymentStatus: PaymentStatus;
  paymentReference: string | null;
}> {
  const lockedPayment = await lockRefundFinancialHierarchy(tx, paymentId);
  if (!lockedPayment) {
    throw new NotFoundException(`Payment "${paymentId}" not found`);
  }
  await lockPaymentObligationsAndRefunds(tx, paymentId);

  const attempt = await tx.refundProviderAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.paymentId !== paymentId) {
    throw new NotFoundException(`Refund attempt "${attemptId}" not found for payment "${paymentId}"`);
  }

  const obligation = await tx.refundObligation.findUniqueOrThrow({
    where: { id: attempt.obligationId },
  });
  const order = await tx.order.findUnique({
    where: { id: lockedPayment.orderId },
    select: { customerId: true },
  });

  return {
    attempt,
    obligation,
    customerId: order?.customerId ?? '',
    orderId: lockedPayment.orderId,
    paymentAmount: new Prisma.Decimal(lockedPayment.amount),
    paymentReference: lockedPayment.providerReference,
    paymentStatus: lockedPayment.status,
  };
}

export async function executePreSendAbortTx(
  tx: Prisma.TransactionClient,
  input: RecordPreSendAbortInput,
): Promise<RefundAttemptOutcomeResult> {
  const { attempt, obligation } = await fetchAttemptBundleTx(tx, input.attemptId, input.paymentId);

  if (attempt.status === RefundAttemptStatus.CANCELLED_BEFORE_DISPATCH) {
    const refund = await tx.refund.findUniqueOrThrow({ where: { id: attempt.refundId } });
    return { obligation, refund, attempt };
  }
  if (
    attempt.status !== RefundAttemptStatus.DISPATCHING &&
    attempt.status !== RefundAttemptStatus.PREPARED
  ) {
    throw new ConflictException(
      `Cannot abort refund attempt "${attempt.id}" in status ${attempt.status}`,
    );
  }

  const now = new Date();
  const nextSeq = await getNextEventSequenceTx(tx, attempt.id);
  const eventType =
    input.failureClass === RefundAttemptFailureClass.UNSUPPORTED_OPERATION
      ? RefundAttemptEventType.DISPATCH_ABORTED_UNSUPPORTED
      : RefundAttemptEventType.DISPATCH_FAILED_PRE_SEND;
  const provenance = resolveSyncProvenance(attempt.provider);
  const eventId = randomUUID();

  await tx.refundProviderAttemptEvent.create({
    data: {
      id: eventId,
      attemptId: attempt.id,
      refundId: attempt.refundId,
      obligationId: attempt.obligationId,
      eventSequence: nextSeq,
      eventType,
      previousAttemptStatus: attempt.status,
      resultingAttemptStatus: RefundAttemptStatus.CANCELLED_BEFORE_DISPATCH,
      provenance,
      provider: attempt.provider,
      merchantAccountId: attempt.merchantAccountId,
      httpStatusCode: input.httpStatusCode ?? null,
      evidenceDigest: sha256Hex({
        attemptId: attempt.id,
        failureClass: input.failureClass,
        errorReason: input.errorReason,
        rawErrorPayload: input.rawErrorPayload ?? null,
      }),
      sanitizedPayload: sanitizeRefundPayload(input.rawErrorPayload ?? { error: input.errorReason }),
      actorId: input.actor?.actorId ?? null,
      actorRole: input.actor?.actorRole ?? null,
      occurredAt: now,
    },
  });

  const updatedAttempt = await tx.refundProviderAttempt.update({
    where: { id: attempt.id },
    data: {
      status: RefundAttemptStatus.CANCELLED_BEFORE_DISPATCH,
      failureClassification: input.failureClass,
      retryEligible: true,
      terminalizedAt: now,
      resolvedByProvenance: provenance,
      resolvedByEventId: eventId,
      version: { increment: 1 },
    },
  });

  const updatedRefund = await tx.refund.update({
    where: { id: attempt.refundId },
    data: { status: RefundStatus.REQUIRED },
  });

  const updatedObligation = await tx.refundObligation.update({
    where: { id: obligation.id },
    data: { status: RefundObligationStatus.OPEN },
  });

  return { obligation: updatedObligation, refund: updatedRefund, attempt: updatedAttempt };
}

export async function executeQuarantineOutcomeTx(
  tx: Prisma.TransactionClient,
  input: QuarantineAttemptInput,
): Promise<RefundAttemptOutcomeResult> {
  const { attempt, obligation, orderId, customerId } = await fetchAttemptBundleTx(
    tx,
    input.attemptId,
    input.paymentId,
  );

  if (attempt.status === RefundAttemptStatus.AMBIGUOUS_OUTCOME) {
    const refund = await tx.refund.findUniqueOrThrow({ where: { id: attempt.refundId } });
    return { obligation, refund, attempt };
  }
  if (
    attempt.status === RefundAttemptStatus.COMPLETED ||
    attempt.status === RefundAttemptStatus.FAILED ||
    attempt.status === RefundAttemptStatus.CANCELLED_BEFORE_DISPATCH
  ) {
    throw new ConflictException(
      `Cannot quarantine terminal refund attempt "${attempt.id}" in status ${attempt.status}`,
    );
  }

  const now = new Date();
  const nextSeq = await getNextEventSequenceTx(tx, attempt.id);
  const eventType =
    input.failureClass === RefundAttemptFailureClass.EVIDENCE_CONTRADICTION
      ? RefundAttemptEventType.CONTRADICTION_QUARANTINED
      : RefundAttemptEventType.PROVIDER_TRANSPORT_TIMEOUT;

  const quarantineEventId = randomUUID();

  await tx.refundProviderAttemptEvent.create({
    data: {
      id: quarantineEventId,
      attemptId: attempt.id,
      refundId: attempt.refundId,
      obligationId: attempt.obligationId,
      eventSequence: nextSeq,
      eventType,
      previousAttemptStatus: attempt.status,
      resultingAttemptStatus: RefundAttemptStatus.AMBIGUOUS_OUTCOME,
      provenance: resolveSyncProvenance(attempt.provider),
      provider: attempt.provider,
      merchantAccountId: attempt.merchantAccountId,
      httpStatusCode: input.httpStatusCode ?? null,
      evidenceDigest: sha256Hex({
        attemptId: attempt.id,
        failureClass: input.failureClass,
        errorMessage: input.errorMessage,
        rawPayload: input.rawPayload ?? null,
      }),
      sanitizedPayload: sanitizeRefundPayload(input.rawPayload ?? { error: input.errorMessage }),
      actorId: input.actor?.actorId ?? null,
      actorRole: input.actor?.actorRole ?? null,
      occurredAt: now,
    },
  });

  const updatedAttempt = await tx.refundProviderAttempt.update({
    where: { id: attempt.id },
    data: {
      status: RefundAttemptStatus.AMBIGUOUS_OUTCOME,
      failureClassification: input.failureClass,
      retryEligible: false,
      quarantinedAt: now,
      version: { increment: 1 },
    },
  });

  const updatedRefund = await tx.refund.update({
    where: { id: attempt.refundId },
    data: { status: RefundStatus.RECONCILE_REQUIRED },
  });

  const updatedObligation = await tx.refundObligation.update({
    where: { id: obligation.id },
    data: { status: RefundObligationStatus.RECONCILE_REQUIRED },
  });

  const outbox = await tx.paymentOutbox.create({
    data: {
      aggregateId: updatedRefund.id,
      aggregateType: 'Refund',
      eventType: 'REFUND_OUTCOME_QUARANTINED',
      payload: {
        logicalEventKey: buildRefundOutboxLogicalKey({
          eventType: 'REFUND_OUTCOME_QUARANTINED',
          attemptId: updatedAttempt.id,
          eventSequence: nextSeq,
        }),
        sourceEventId: quarantineEventId,
        eventSequence: nextSeq,
        refundId: updatedRefund.id,
        paymentId: input.paymentId,
        orderId,
        obligationId: updatedObligation.id,
        attemptId: updatedAttempt.id,
        customerId,
        status: updatedRefund.status,
        failureClass: input.failureClass,
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
