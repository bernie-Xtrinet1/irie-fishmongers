import { randomUUID } from 'crypto';

import {
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  PaymentProviderName,
  Prisma,
  RefundAttemptStatus,
  RefundEvidenceDisposition,
  RefundObligation,
  RefundProviderAttempt,
  RefundReconciliationActionType,
  RefundReconciliationApproval,
  RefundReconciliationApprovalEventType,
  RefundReconciliationApprovalStatus,
  RefundReconciliationOutcome,
  RoleName,
  UserStatus,
} from '@prisma/client';

import { sha256Hex } from './refund-locks.helper';

export async function verifyActiveAdministratorTx(
  tx: Prisma.TransactionClient,
  actorId: string | null | undefined,
  actorLabel: string,
): Promise<{ id: string; email: string }> {
  const trimmed = actorId?.trim();
  if (!trimmed) {
    throw new ForbiddenException(`${actorLabel} administrator identity is required`);
  }

  const user = await tx.user.findUnique({
    where: { id: trimmed },
    select: {
      id: true,
      email: true,
      status: true,
      roles: { select: { role: { select: { name: true } } } },
    },
  });

  if (!user) {
    throw new ForbiddenException(`${actorLabel} administrator "${trimmed}" does not exist`);
  }
  if (user.status !== UserStatus.ACTIVE) {
    throw new ForbiddenException(
      `${actorLabel} administrator "${trimmed}" is not ACTIVE (status=${user.status})`,
    );
  }
  if (!user.roles.some((r) => r.role.name === RoleName.ADMINISTRATOR)) {
    throw new ForbiddenException(`${actorLabel} user "${trimmed}" lacks ADMINISTRATOR role`);
  }

  return { id: user.id, email: user.email };
}

export function resolveActionTypeForOutcome(params: {
  requestedOutcome: RefundReconciliationOutcome;
  attempt: RefundProviderAttempt | null;
}): RefundReconciliationActionType {
  const { requestedOutcome, attempt } = params;

  if (requestedOutcome === RefundReconciliationOutcome.VOID_OBLIGATION) {
    return RefundReconciliationActionType.VOID_OBLIGATION;
  }
  if (requestedOutcome === RefundReconciliationOutcome.CONTINUE_QUARANTINE) {
    return RefundReconciliationActionType.CONTINUE_QUARANTINE;
  }
  if (requestedOutcome === RefundReconciliationOutcome.VERIFIED_FAILED) {
    return RefundReconciliationActionType.RESOLVE_QUARANTINED_DEFINITIVE_FAIL_NO_REMITTANCE;
  }

  // VERIFIED_COMPLETED
  if (
    attempt &&
    attempt.status !== RefundAttemptStatus.FAILED &&
    attempt.status !== RefundAttemptStatus.CANCELLED_BEFORE_DISPATCH &&
    attempt.status !== RefundAttemptStatus.COMPLETED
  ) {
    return RefundReconciliationActionType.RESOLVE_QUARANTINED_COMPLETED;
  }
  return RefundReconciliationActionType.MANUAL_OFFLINE_SETTLEMENT_COMPLETED;
}

export function computeReconciliationRequestDigest(params: {
  obligationId: string;
  refundId: string | null;
  attemptId: string | null;
  paymentId: string;
  provider: PaymentProviderName;
  merchantAccountId: string;
  amount: string;
  currency: string;
  actionType: RefundReconciliationActionType;
  requestedOutcome: RefundReconciliationOutcome | null;
  evidenceType: string;
  externalSettlementReference: string | null;
  evidenceDigest: string;
  evidenceReceiptIds: string[];
  rationale: string;
  requestedByActorId: string;
  expiresAt: string | null;
}): string {
  return sha256Hex({
    ...params,
    evidenceReceiptIds: [...params.evidenceReceiptIds].sort(),
  });
}

export function computeReconciliationApprovalDigest(params: {
  approvalId: string;
  requestDigest: string;
  approvedByActorId: string;
  approvedAt: string;
  expiresAt: string;
}): string {
  return sha256Hex(params);
}

export async function appendApprovalLifecycleEventTx(
  tx: Prisma.TransactionClient,
  params: {
    approvalId: string;
    obligationId: string;
    eventType: RefundReconciliationApprovalEventType;
    previousStatus: RefundReconciliationApprovalStatus | null;
    resultingStatus: RefundReconciliationApprovalStatus;
    authorizationRevision: number;
    actorId: string;
    actorRole?: string | null;
    evidenceDigest: string;
    sanitizedPayload?: Prisma.InputJsonValue;
    occurredAt?: Date;
  },
): Promise<string> {
  const agg = await tx.refundReconciliationApprovalEvent.aggregate({
    where: { approvalId: params.approvalId },
    _max: { eventSequence: true },
  });
  const nextSeq = (agg._max.eventSequence ?? 0) + 1;
  const eventId = randomUUID();
  const occurredAt = params.occurredAt ?? new Date();

  await tx.refundReconciliationApprovalEvent.create({
    data: {
      id: eventId,
      approvalId: params.approvalId,
      obligationId: params.obligationId,
      eventSequence: nextSeq,
      eventType: params.eventType,
      previousStatus: params.previousStatus,
      resultingStatus: params.resultingStatus,
      authorizationRevision: params.authorizationRevision,
      actorId: params.actorId,
      actorRole: params.actorRole ?? 'ADMINISTRATOR',
      evidenceDigest: params.evidenceDigest,
      sanitizedPayload: params.sanitizedPayload ?? Prisma.JsonNull,
      occurredAt,
    },
  });

  return eventId;
}

export async function validateEvidenceReceiptsTx(
  tx: Prisma.TransactionClient,
  params: {
    receiptIds: string[];
    obligation: RefundObligation;
    attempt: RefundProviderAttempt | null;
    paymentProvider: PaymentProviderName;
    merchantAccountId: string;
    paymentProviderReference: string | null;
    externalSettlementReference: string | null;
    requestedOutcome: RefundReconciliationOutcome | null;
    currentApprovalId?: string | null;
  },
): Promise<{ valid: true; normalizedReceiptIds: string[] } | { valid: false; reason: string }> {
  const uniqueIds = Array.from(new Set(params.receiptIds.map((id) => id.trim()).filter(Boolean)));
  const extRef = params.externalSettlementReference?.trim() || null;

  if (extRef && params.paymentProviderReference) {
    if (extRef.toLowerCase() === params.paymentProviderReference.trim().toLowerCase()) {
      return {
        valid: false,
        reason: `externalSettlementReference "${extRef}" cannot echo parent payment charge reference`,
      };
    }
  }

  if (extRef) {
    const existingAttemptWithRef = await tx.refundProviderAttempt.findFirst({
      where: {
        provider: params.paymentProvider,
        merchantAccountId: params.merchantAccountId.trim(),
        providerRefundReference: { equals: extRef, mode: 'insensitive' },
        ...(params.attempt ? { id: { not: params.attempt.id } } : {}),
      },
      select: { id: true, obligationId: true, status: true },
    });
    if (existingAttemptWithRef) {
      return {
        valid: false,
        reason: `externalSettlementReference "${extRef}" is already recorded on attempt "${existingAttemptWithRef.id}" (${existingAttemptWithRef.status})`,
      };
    }

    const existingApprovalWithRef = await tx.refundReconciliationApproval.findFirst({
      where: {
        externalSettlementReference: { equals: extRef, mode: 'insensitive' },
        status: {
          in: [
            RefundReconciliationApprovalStatus.APPROVED,
            RefundReconciliationApprovalStatus.EXECUTING,
            RefundReconciliationApprovalStatus.APPLIED,
          ],
        },
        ...(params.currentApprovalId ? { id: { not: params.currentApprovalId } } : {}),
      },
      select: { id: true, status: true },
    });
    if (existingApprovalWithRef) {
      return {
        valid: false,
        reason: `externalSettlementReference "${extRef}" is already bound to approval "${existingApprovalWithRef.id}" (${existingApprovalWithRef.status})`,
      };
    }
  }

  for (const receiptId of uniqueIds) {
    const receipt = await tx.refundEvidenceReceipt.findUnique({ where: { id: receiptId } });
    if (!receipt) {
      return { valid: false, reason: `Evidence receipt "${receiptId}" does not exist` };
    }
    if (receipt.provider !== params.paymentProvider) {
      return {
        valid: false,
        reason: `Evidence receipt "${receiptId}" provider ${receipt.provider} mismatches ${params.paymentProvider}`,
      };
    }
    if (receipt.merchantAccountId.trim() !== params.merchantAccountId.trim()) {
      return {
        valid: false,
        reason: `Evidence receipt "${receiptId}" merchantAccountId mismatches "${params.merchantAccountId}"`,
      };
    }
    if (receipt.obligationId && receipt.obligationId !== params.obligation.id) {
      return {
        valid: false,
        reason: `Evidence receipt "${receiptId}" belongs to obligation "${receipt.obligationId}"`,
      };
    }
    if (params.attempt && receipt.attemptId && receipt.attemptId !== params.attempt.id) {
      return {
        valid: false,
        reason: `Evidence receipt "${receiptId}" belongs to attempt "${receipt.attemptId}"`,
      };
    }
    if (
      params.requestedOutcome === RefundReconciliationOutcome.VERIFIED_COMPLETED &&
      receipt.disposition === RefundEvidenceDisposition.SIGNATURE_REJECTED
    ) {
      return {
        valid: false,
        reason: `Unauthenticated SIGNATURE_REJECTED receipt "${receiptId}" cannot authorize VERIFIED_COMPLETED`,
      };
    }
  }

  return { valid: true, normalizedReceiptIds: uniqueIds };
}

export async function checkStaleStateOrContradictionsTx(
  tx: Prisma.TransactionClient,
  approval: RefundReconciliationApproval,
  obligation: RefundObligation,
  targetAttempt: RefundProviderAttempt | null,
): Promise<{ stale: false } | { stale: true; reason: string }> {
  if (
    approval.requestedOutcome === RefundReconciliationOutcome.VOID_OBLIGATION &&
    obligation.status === 'FULFILLED'
  ) {
    return { stale: true, reason: 'Obligation became FULFILLED after approval' };
  }
  if (
    approval.requestedOutcome !== RefundReconciliationOutcome.CONTINUE_QUARANTINE &&
    obligation.status === 'CANCELLED_VOIDED'
  ) {
    return { stale: true, reason: 'Obligation is already CANCELLED_VOIDED' };
  }
  if (
    approval.requestedOutcome === RefundReconciliationOutcome.VERIFIED_COMPLETED &&
    obligation.status === 'FULFILLED'
  ) {
    return { stale: true, reason: 'Obligation was already FULFILLED concurrently' };
  }
  if (targetAttempt && approval.requestedOutcome !== RefundReconciliationOutcome.CONTINUE_QUARANTINE) {
    if (targetAttempt.status === RefundAttemptStatus.COMPLETED) {
      return {
        stale: true,
        reason: `Target attempt "${targetAttempt.id}" is already terminal COMPLETED`,
      };
    }
    const newerAttempts = await tx.refundProviderAttempt.count({
      where: {
        obligationId: obligation.id,
        attemptSequence: { gt: targetAttempt.attemptSequence },
      },
    });
    if (newerAttempts > 0) {
      return {
        stale: true,
        reason: `Newer attempt(s) created on obligation "${obligation.id}" after approval target`,
      };
    }
  }

  const boundIds = Array.isArray(approval.evidenceReceiptIds)
    ? approval.evidenceReceiptIds.filter((v): v is string => typeof v === 'string')
    : [];

  const newerReceipts = await tx.refundEvidenceReceipt.findMany({
    where: {
      obligationId: obligation.id,
      receivedAt: { gt: approval.requestedAt },
      disposition: {
        in: [RefundEvidenceDisposition.APPLIED, RefundEvidenceDisposition.CONFLICT_REJECTED],
      },
      ...(boundIds.length > 0 ? { id: { notIn: boundIds } } : {}),
    },
    select: { id: true, disposition: true },
  });
  if (
    newerReceipts.length > 0 &&
    approval.requestedOutcome !== RefundReconciliationOutcome.CONTINUE_QUARANTINE
  ) {
    return {
      stale: true,
      reason: `Newer ${newerReceipts[0]!.disposition} evidence receipt arrived after request (${newerReceipts[0]!.id})`,
    };
  }

  return { stale: false };
}

export function assertValidEvidenceDigestFormat(digest: string): string {
  const trimmed = digest.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    throw new ConflictException('evidenceDigest must be a valid 64-char SHA-256 hex digest');
  }
  return trimmed;
}

export function sha256HexForAttemptDigest(
  obligation: RefundObligation,
  extRef: string,
  attemptId: string,
): string {
  return sha256Hex({
    obligationId: obligation.id,
    paymentId: obligation.paymentId,
    amount: obligation.authorizedAmount.toString(),
    currency: obligation.currency,
    externalSettlementReference: extRef,
    attemptId,
  });
}
