import { randomUUID } from 'crypto';

import {
  PaymentProviderName,
  Prisma,
  RefundAttemptEventType,
  RefundAttemptStatus,
  RefundEvidenceDisposition,
  RefundEvidenceProvenance,
  RefundProviderAttempt,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { ProcessRefundEvidenceInput } from '../types/refund-reconciliation.types';
import { LockedRefundPaymentRow } from './refund-locks.helper';

export interface AttemptTargetCandidate {
  id: string;
  paymentId: string;
}

export async function resolveAttemptCandidate(
  prisma: PrismaService,
  input: ProcessRefundEvidenceInput,
): Promise<AttemptTargetCandidate | null> {
  const attemptId = input.attemptId?.trim();
  if (attemptId) {
    return prisma.refundProviderAttempt.findUnique({
      where: { id: attemptId },
      select: { id: true, paymentId: true },
    });
  }

  const idemKey = input.providerIdempotencyKey?.trim();
  if (idemKey) {
    return prisma.refundProviderAttempt.findUnique({
      where: { providerIdempotencyKey: idemKey },
      select: { id: true, paymentId: true },
    });
  }

  const refundRef = input.providerRefundReference?.trim();
  if (refundRef) {
    return prisma.refundProviderAttempt.findFirst({
      where: {
        provider: input.provider,
        merchantAccountId: input.merchantAccountId.trim(),
        providerRefundReference: refundRef,
      },
      select: { id: true, paymentId: true },
    });
  }

  return null;
}

export function mapEvidenceEventType(provenance: RefundEvidenceProvenance): RefundAttemptEventType {
  if (provenance === RefundEvidenceProvenance.AUTHENTICATED_WEBHOOK) {
    return RefundAttemptEventType.WEBHOOK_OBSERVED;
  }
  if (provenance === RefundEvidenceProvenance.VERIFIED_STATUS_POLL) {
    return RefundAttemptEventType.STATUS_POLL_OBSERVED;
  }
  return RefundAttemptEventType.PROVIDER_SYNC_RESPONSE;
}

export function areAttemptOutcomeAndEventConsistent(
  existingResultingStatus: RefundAttemptStatus,
  incomingOutcome: 'COMPLETED' | 'PENDING' | 'FAILED',
): boolean {
  if (incomingOutcome === 'COMPLETED') {
    return existingResultingStatus === RefundAttemptStatus.COMPLETED;
  }
  if (incomingOutcome === 'FAILED') {
    return existingResultingStatus === RefundAttemptStatus.FAILED;
  }
  return (
    existingResultingStatus === RefundAttemptStatus.PROVIDER_PENDING ||
    existingResultingStatus === RefundAttemptStatus.AMBIGUOUS_OUTCOME
  );
}

export async function detectExternalEventReplayTx(
  tx: Prisma.TransactionClient,
  input: ProcessRefundEvidenceInput,
  attempt: RefundProviderAttempt,
  normalizedDigest: string,
  normalizedRef: string | null,
): Promise<{ kind: 'DUPLICATE_EXACT' | 'CONFLICT_EVENT_REUSE'; reason: string } | null> {
  const existing = await tx.refundProviderAttemptEvent.findFirst({
    where: {
      provider: input.provider,
      merchantAccountId: input.merchantAccountId.trim(),
      providerEventId: input.evidence.eventId,
    },
  });

  if (!existing) {
    return null;
  }

  const sameAttempt = existing.attemptId === attempt.id;
  const sameDigest = existing.evidenceDigest.toLowerCase() === normalizedDigest.toLowerCase();
  const sameRef =
    !existing.providerRefundReference ||
    !normalizedRef ||
    existing.providerRefundReference.trim().toLowerCase() === normalizedRef.toLowerCase();
  const compatibleOutcome = areAttemptOutcomeAndEventConsistent(
    existing.resultingAttemptStatus,
    input.outcome,
  );

  if (sameAttempt && sameDigest && sameRef && compatibleOutcome) {
    return {
      kind: 'DUPLICATE_EXACT',
      reason: `Duplicate provider event "${input.evidence.eventId}" already processed for attempt "${attempt.id}"`,
    };
  }

  return {
    kind: 'CONFLICT_EVENT_REUSE',
    reason: `Provider event "${input.evidence.eventId}" reused with conflicting attempt, reference, outcome, or digest`,
  };
}

export async function validateEvidenceFieldsTx(
  tx: Prisma.TransactionClient,
  input: ProcessRefundEvidenceInput,
  attempt: RefundProviderAttempt,
  payment: LockedRefundPaymentRow,
): Promise<{ valid: true; normalizedRef: string | null } | { valid: false; reason: string }> {
  const trimmedAttemptId = input.attemptId?.trim();
  if (trimmedAttemptId && trimmedAttemptId !== attempt.id) {
    return { valid: false, reason: `attemptId "${trimmedAttemptId}" does not match "${attempt.id}"` };
  }

  const trimmedObligationId = input.obligationId?.trim();
  if (trimmedObligationId && trimmedObligationId !== attempt.obligationId) {
    return {
      valid: false,
      reason: `obligationId "${trimmedObligationId}" does not match "${attempt.obligationId}"`,
    };
  }

  if (input.provider !== attempt.provider) {
    return { valid: false, reason: `provider ${input.provider} does not match ${attempt.provider}` };
  }

  if (input.merchantAccountId.trim() !== attempt.merchantAccountId.trim()) {
    return {
      valid: false,
      reason: `merchantAccountId "${input.merchantAccountId}" does not match "${attempt.merchantAccountId}"`,
    };
  }

  const trimmedIdem = input.providerIdempotencyKey?.trim();
  if (trimmedIdem && trimmedIdem !== attempt.providerIdempotencyKey) {
    return {
      valid: false,
      reason: `providerIdempotencyKey "${trimmedIdem}" does not match attempt key`,
    };
  }

  const trimmedParentRef = input.parentPaymentReference?.trim();
  const expectedParentRef =
    attempt.parentPaymentReference?.trim() || payment.providerReference?.trim() || null;
  if (
    trimmedParentRef &&
    expectedParentRef &&
    trimmedParentRef.toLowerCase() !== expectedParentRef.toLowerCase()
  ) {
    return {
      valid: false,
      reason: `parentPaymentReference "${trimmedParentRef}" does not match expected "${expectedParentRef}"`,
    };
  }

  if (input.currency.trim().toUpperCase() !== attempt.currency.trim().toUpperCase()) {
    return {
      valid: false,
      reason: `currency "${input.currency}" does not match attempt currency "${attempt.currency}"`,
    };
  }

  const incomingAmount = new Prisma.Decimal(input.amount);
  const attemptAmount = new Prisma.Decimal(attempt.amount);
  if (!incomingAmount.equals(attemptAmount)) {
    return {
      valid: false,
      reason: `amount ${incomingAmount.toFixed(2)} does not match attempt amount ${attemptAmount.toFixed(2)}`,
    };
  }

  const normalizedRef = input.providerRefundReference?.trim() || null;
  if (input.outcome === 'COMPLETED' && !normalizedRef) {
    return {
      valid: false,
      reason: 'COMPLETED refund evidence requires a non-empty providerRefundReference',
    };
  }

  if (normalizedRef) {
    const parentRefs = [payment.providerReference, attempt.parentPaymentReference]
      .filter((r): r is string => Boolean(r && r.trim().length > 0))
      .map((r) => r.trim().toLowerCase());
    if (parentRefs.includes(normalizedRef.toLowerCase())) {
      return {
        valid: false,
        reason: `providerRefundReference "${normalizedRef}" illegally echoes parent payment reference`,
      };
    }

    if (
      attempt.providerRefundReference &&
      attempt.providerRefundReference.trim().toLowerCase() !== normalizedRef.toLowerCase()
    ) {
      return {
        valid: false,
        reason: `Conflicting providerRefundReference "${normalizedRef}" for attempt bound to "${attempt.providerRefundReference}"`,
      };
    }

    const refHolder = await tx.refundProviderAttempt.findFirst({
      where: {
        provider: attempt.provider,
        merchantAccountId: attempt.merchantAccountId,
        providerRefundReference: normalizedRef,
        id: { not: attempt.id },
      },
      select: { id: true },
    });
    if (refHolder) {
      return {
        valid: false,
        reason: `providerRefundReference "${normalizedRef}" is already bound to attempt "${refHolder.id}"`,
      };
    }
  }

  return { valid: true, normalizedRef };
}

export function persistEvidenceReceipt(
  client: PrismaService | Prisma.TransactionClient,
  params: {
    provider: PaymentProviderName;
    merchantAccountId: string;
    eventId: string;
    providerRefundReference?: string | null;
    attemptId?: string | null;
    refundId?: string | null;
    obligationId?: string | null;
    provenance: RefundEvidenceProvenance;
    disposition: RefundEvidenceDisposition;
    signatureValid: boolean;
    evidenceDigest: string;
    sourceIp?: string | null;
    rejectionReason?: string | null;
  },
) {
  return client.refundEvidenceReceipt.create({
    data: {
      id: randomUUID(),
      provider: params.provider,
      merchantAccountId: params.merchantAccountId.trim(),
      eventId: params.eventId,
      providerRefundReference: params.providerRefundReference ?? null,
      attemptId: params.attemptId ?? null,
      refundId: params.refundId ?? null,
      obligationId: params.obligationId ?? null,
      provenance: params.provenance,
      disposition: params.disposition,
      signatureValid: params.signatureValid,
      evidenceDigest: params.evidenceDigest,
      sourceIp: params.sourceIp ?? null,
      rejectionReason: params.rejectionReason ?? null,
    },
  });
}
