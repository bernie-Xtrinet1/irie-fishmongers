import { randomUUID } from 'crypto';

import {
  PaymentProviderName,
  Prisma,
  Refund,
  RefundAttemptEventType,
  RefundAttemptStatus,
  RefundEvidenceProvenance,
  RefundExecutionChannel,
  RefundObligation,
  RefundProviderAttempt,
} from '@prisma/client';

import { PrepareRefundAttemptInput } from '../types/refund-ledger.types';
import { LockedRefundPaymentRow, sha256Hex } from './refund-locks.helper';

const DEFAULT_DISPATCH_LEASE_MS = 30_000;

export async function createAndClaimAttemptTx(
  tx: Prisma.TransactionClient,
  payment: LockedRefundPaymentRow,
  obligation: RefundObligation,
  refund: Refund,
  input: PrepareRefundAttemptInput,
): Promise<RefundProviderAttempt> {
  const seqAgg = await tx.refundProviderAttempt.aggregate({
    where: { obligationId: obligation.id },
    _max: { attemptSequence: true },
  });
  const attemptSequence = (seqAgg._max.attemptSequence ?? 0) + 1;
  const attemptId = randomUUID();
  const providerIdempotencyKey = `refund:${obligation.id}:att:${attemptSequence}`;
  const executionChannel =
    input.executionChannel ??
    (payment.provider === PaymentProviderName.CASH_ON_DELIVERY
      ? RefundExecutionChannel.COD_INTERNAL
      : RefundExecutionChannel.AUTOMATED_GATEWAY);

  const requestDigest = sha256Hex({
    attemptId,
    obligationId: obligation.id,
    refundId: refund.id,
    paymentId: payment.id,
    provider: payment.provider,
    merchantAccountId: payment.merchantAccountId,
    attemptSequence,
    amount: new Prisma.Decimal(refund.amount).toFixed(2),
    currency: payment.currency,
    parentPaymentReference: payment.providerReference,
    providerIdempotencyKey,
  });

  const now = new Date();
  const leaseExpiresAt = new Date(
    now.getTime() + (input.leaseDurationMs ?? DEFAULT_DISPATCH_LEASE_MS),
  );
  const provenance =
    payment.provider === PaymentProviderName.CASH_ON_DELIVERY
      ? RefundEvidenceProvenance.INTERNAL_COD_ADAPTER
      : RefundEvidenceProvenance.APPLICATION_SYNC_RESPONSE;

  await tx.refundProviderAttempt.create({
    data: {
      id: attemptId,
      refundId: refund.id,
      obligationId: obligation.id,
      paymentId: payment.id,
      provider: payment.provider,
      merchantAccountId: payment.merchantAccountId,
      attemptSequence,
      providerIdempotencyKey,
      amount: refund.amount,
      currency: payment.currency,
      executionChannel,
      parentPaymentReference: payment.providerReference,
      status: RefundAttemptStatus.PREPARED,
      requestDigest,
      preparedAt: now,
      initiatedByActorId: input.actor?.actorId ?? null,
      initiatedByRole: input.actor?.actorRole ?? null,
    },
  });

  await tx.refundProviderAttemptEvent.create({
    data: {
      id: randomUUID(),
      attemptId,
      refundId: refund.id,
      obligationId: obligation.id,
      eventSequence: 1,
      eventType: RefundAttemptEventType.ATTEMPT_PREPARED,
      previousAttemptStatus: null,
      resultingAttemptStatus: RefundAttemptStatus.PREPARED,
      provenance,
      provider: payment.provider,
      merchantAccountId: payment.merchantAccountId,
      evidenceDigest: requestDigest,
      actorId: input.actor?.actorId ?? null,
      actorRole: input.actor?.actorRole ?? null,
      occurredAt: now,
    },
  });

  await tx.refundProviderAttemptEvent.create({
    data: {
      id: randomUUID(),
      attemptId,
      refundId: refund.id,
      obligationId: obligation.id,
      eventSequence: 2,
      eventType: RefundAttemptEventType.DISPATCH_CLAIMED,
      previousAttemptStatus: RefundAttemptStatus.PREPARED,
      resultingAttemptStatus: RefundAttemptStatus.DISPATCHING,
      provenance,
      provider: payment.provider,
      merchantAccountId: payment.merchantAccountId,
      evidenceDigest: sha256Hex({ attemptId, leaseExpiresAt: leaseExpiresAt.toISOString() }),
      actorId: input.actor?.actorId ?? null,
      actorRole: input.actor?.actorRole ?? null,
      occurredAt: now,
    },
  });

  return tx.refundProviderAttempt.update({
    where: { id: attemptId },
    data: {
      status: RefundAttemptStatus.DISPATCHING,
      dispatchStartedAt: now,
      leaseExpiresAt,
      version: { increment: 1 },
    },
  });
}
