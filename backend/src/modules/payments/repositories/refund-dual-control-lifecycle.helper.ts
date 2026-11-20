import { randomUUID } from 'crypto';

import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  RefundAttemptStatus,
  RefundObligationStatus,
  RefundProviderAttempt,
  RefundReconciliationApprovalEventType,
  RefundReconciliationApprovalStatus,
  RefundReconciliationOutcome,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  DualControlApprovalView,
  DualControlReconciliationRequestInput,
  mapApprovalToView,
} from '../types/refund-dual-control.types';
import { lockApprovalRowTx } from './refund-dual-control-query.helper';
import {
  lockPaymentObligationsAndRefunds,
  lockRefundFinancialHierarchy,
  sha256Hex,
} from './refund-locks.helper';
import {
  appendApprovalLifecycleEventTx,
  assertValidEvidenceDigestFormat,
  computeReconciliationRequestDigest,
  resolveActionTypeForOutcome,
  validateEvidenceReceiptsTx,
  verifyActiveAdministratorTx,
} from './refund-reconciliation-binding.helper';

export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;
export const RECONCILIATION_TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 15_000,
  timeout: 15_000,
};

export async function getDbNowTx(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS now`,
  );
  return rows[0]?.now ?? new Date();
}

export async function requestReconciliationTxFlow(
  prisma: PrismaService,
  input: DualControlReconciliationRequestInput,
): Promise<DualControlApprovalView> {
  return prisma.$transaction(async (tx) => {
    const obligationMeta = await tx.refundObligation.findUnique({
      where: { id: input.obligationId },
      include: { payment: true },
    });
    if (!obligationMeta) {
      throw new NotFoundException(`Refund obligation "${input.obligationId}" not found`);
    }

    const payment = await lockRefundFinancialHierarchy(
      tx,
      obligationMeta.paymentId,
      obligationMeta.orderId,
    );
    if (!payment) {
      throw new NotFoundException(`Payment "${obligationMeta.paymentId}" not found`);
    }
    await lockPaymentObligationsAndRefunds(tx, payment.id);

    await verifyActiveAdministratorTx(tx, input.requestedByActorId, 'Requester');

    const obligation = await tx.refundObligation.findUniqueOrThrow({
      where: { id: input.obligationId },
    });
    if (
      obligation.status === RefundObligationStatus.FULFILLED ||
      obligation.status === RefundObligationStatus.CANCELLED_VOIDED
    ) {
      throw new ConflictException(
        `Cannot request reconciliation for terminal obligation in status ${obligation.status}`,
      );
    }

    const existingOpenApproval = await tx.refundReconciliationApproval.findFirst({
      where: {
        obligationId: obligation.id,
        status: {
          in: [
            RefundReconciliationApprovalStatus.REQUESTED,
            RefundReconciliationApprovalStatus.APPROVED,
            RefundReconciliationApprovalStatus.EXECUTING,
          ],
        },
      },
    });
    if (existingOpenApproval) {
      throw new ConflictException(
        `Active approval "${existingOpenApproval.id}" already exists for obligation "${obligation.id}"`,
      );
    }

    let targetAttempt: RefundProviderAttempt | null = null;
    if (input.attemptId) {
      targetAttempt = await tx.refundProviderAttempt.findUnique({
        where: { id: input.attemptId },
      });
      if (!targetAttempt || targetAttempt.obligationId !== obligation.id) {
        throw new ConflictException(
          `Attempt "${input.attemptId}" does not belong to obligation "${obligation.id}"`,
        );
      }
      const newerAttemptCount = await tx.refundProviderAttempt.count({
        where: {
          obligationId: obligation.id,
          attemptSequence: { gt: targetAttempt.attemptSequence },
        },
      });
      if (newerAttemptCount > 0) {
        throw new ConflictException(
          `Attempt "${targetAttempt.id}" is superseded by a newer attempt on obligation "${obligation.id}"`,
        );
      }
    } else {
      targetAttempt = await tx.refundProviderAttempt.findFirst({
        where: { obligationId: obligation.id },
        orderBy: { attemptSequence: 'desc' },
      });
    }

    if (
      targetAttempt?.status === RefundAttemptStatus.COMPLETED &&
      input.requestedOutcome !== RefundReconciliationOutcome.CONTINUE_QUARANTINE
    ) {
      throw new ConflictException(
        `Attempt "${targetAttempt.id}" is already COMPLETED; terminal completion cannot be modified`,
      );
    }

    const targetRefund = targetAttempt
      ? await tx.refund.findUnique({ where: { id: targetAttempt.refundId } })
      : await tx.refund.findFirst({
          where: { obligationId: obligation.id },
          orderBy: { createdAt: 'desc' },
        });

    const trimmedExtRef = input.externalSettlementReference?.trim() || null;
    if (
      input.requestedOutcome === RefundReconciliationOutcome.VERIFIED_COMPLETED &&
      !trimmedExtRef
    ) {
      throw new ConflictException(
        'VERIFIED_COMPLETED requires verified externalSettlementReference',
      );
    }

    const receiptCheck = await validateEvidenceReceiptsTx(tx, {
      receiptIds: input.evidenceReceiptIds ?? [],
      obligation,
      attempt: targetAttempt,
      paymentProvider: payment.provider,
      merchantAccountId: payment.merchantAccountId,
      paymentProviderReference: payment.providerReference,
      externalSettlementReference: trimmedExtRef,
      requestedOutcome: input.requestedOutcome,
    });
    if (!receiptCheck.valid) {
      throw new ConflictException(receiptCheck.reason);
    }

    const evidenceDigest = input.evidenceDigest
      ? assertValidEvidenceDigestFormat(input.evidenceDigest)
      : sha256Hex(
          input.rawEvidence ?? {
            evidenceType: input.evidenceType,
            externalSettlementReference: trimmedExtRef,
            receiptIds: receiptCheck.normalizedReceiptIds,
          },
        );

    const actionType = resolveActionTypeForOutcome({
      requestedOutcome: input.requestedOutcome,
      attempt: targetAttempt,
    });
    const now = await getDbNowTx(tx);
    const ttlMs = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : DEFAULT_APPROVAL_TTL_MS;
    const expiresAt = new Date(now.getTime() + ttlMs);
    const requestDigest = computeReconciliationRequestDigest({
      obligationId: obligation.id,
      refundId: targetRefund?.id ?? null,
      attemptId: targetAttempt?.id ?? null,
      paymentId: payment.id,
      provider: payment.provider,
      merchantAccountId: payment.merchantAccountId,
      amount: new Prisma.Decimal(obligation.authorizedAmount).toFixed(2),
      currency: obligation.currency,
      actionType,
      requestedOutcome: input.requestedOutcome,
      evidenceType: input.evidenceType.trim(),
      externalSettlementReference: trimmedExtRef,
      evidenceDigest,
      evidenceReceiptIds: receiptCheck.normalizedReceiptIds,
      rationale: input.rationale.trim(),
      requestedByActorId: input.requestedByActorId,
      expiresAt: expiresAt.toISOString(),
    });

    const approvalId = randomUUID();
    const created = await tx.refundReconciliationApproval.create({
      data: {
        id: approvalId,
        obligationId: obligation.id,
        refundId: targetRefund?.id ?? null,
        attemptId: targetAttempt?.id ?? null,
        paymentId: payment.id,
        provider: payment.provider,
        merchantAccountId: payment.merchantAccountId,
        amount: obligation.authorizedAmount,
        currency: obligation.currency,
        actionType,
        requestedOutcome: input.requestedOutcome,
        evidenceType: input.evidenceType.trim(),
        externalSettlementReference: trimmedExtRef,
        evidenceDigest,
        evidenceReceiptIds: receiptCheck.normalizedReceiptIds,
        requestDigest,
        rationale: input.rationale.trim(),
        authorizationRevision: 1,
        requestedByActorId: input.requestedByActorId,
        requestedAt: now,
        expiresAt,
        status: RefundReconciliationApprovalStatus.REQUESTED,
      },
    });

    await appendApprovalLifecycleEventTx(tx, {
      approvalId,
      obligationId: obligation.id,
      eventType: RefundReconciliationApprovalEventType.REQUESTED,
      previousStatus: null,
      resultingStatus: RefundReconciliationApprovalStatus.REQUESTED,
      authorizationRevision: 1,
      actorId: input.requestedByActorId,
      actorRole: input.actorRole,
      evidenceDigest,
      sanitizedPayload: {
        actionType,
        requestedOutcome: input.requestedOutcome,
        expiresAt: expiresAt.toISOString(),
      },
      occurredAt: now,
    });

    const events = await tx.refundReconciliationApprovalEvent.findMany({
      where: { approvalId },
      orderBy: { eventSequence: 'asc' },
    });
    return mapApprovalToView({ ...created, events });
  }, RECONCILIATION_TX_OPTIONS);
}

export async function applyPreExecutionTerminationTxFlow(
  prisma: PrismaService,
  params: {
    approvalId: string;
    actorId: string;
    actorRole: string | null | undefined;
    reason: string;
    targetStatus: 'REJECTED' | 'REVOKED';
  },
): Promise<DualControlApprovalView> {
  const { approvalId, actorId, actorRole, reason, targetStatus } = params;
  return prisma.$transaction(async (tx) => {
    const approvalMeta = await tx.refundReconciliationApproval.findUnique({
      where: { id: approvalId },
    });
    if (!approvalMeta) {
      throw new NotFoundException(`Reconciliation approval "${approvalId}" not found`);
    }
    const obligationMeta = await tx.refundObligation.findUniqueOrThrow({
      where: { id: approvalMeta.obligationId },
    });
    await lockRefundFinancialHierarchy(tx, obligationMeta.paymentId, obligationMeta.orderId);
    await lockPaymentObligationsAndRefunds(tx, obligationMeta.paymentId);

    const approval = await lockApprovalRowTx(tx, approvalId);
    await verifyActiveAdministratorTx(
      tx,
      actorId,
      targetStatus === 'REJECTED' ? 'Rejector' : 'Revoker',
    );

    if (targetStatus === 'REJECTED') {
      if (approval.status !== RefundReconciliationApprovalStatus.REQUESTED) {
        throw new ConflictException(`Only REQUESTED approvals can be rejected (got ${approval.status})`);
      }
      if (approval.requestedByActorId === actorId) {
        throw new ForbiddenException('Dual control violation: requester cannot reject own request');
      }
    } else if (
      approval.status !== RefundReconciliationApprovalStatus.REQUESTED &&
      approval.status !== RefundReconciliationApprovalStatus.APPROVED
    ) {
      throw new ConflictException(`Cannot revoke approval in status ${approval.status}`);
    }

    const now = await getDbNowTx(tx);
    const nextRev = approval.authorizationRevision + 1;
    const updated = await tx.refundReconciliationApproval.update({
      where: { id: approval.id },
      data: {
        status: targetStatus,
        authorizationRevision: nextRev,
        ...(targetStatus === 'REJECTED'
          ? { rejectedByActorId: actorId, rejectedAt: now, rejectionReason: reason.trim() }
          : { revokedByActorId: actorId, revokedAt: now, revocationReason: reason.trim() }),
      },
    });

    await appendApprovalLifecycleEventTx(tx, {
      approvalId: approval.id,
      obligationId: obligationMeta.id,
      eventType:
        targetStatus === 'REJECTED'
          ? RefundReconciliationApprovalEventType.REJECTED
          : RefundReconciliationApprovalEventType.REVOKED,
      previousStatus: approval.status,
      resultingStatus: targetStatus,
      authorizationRevision: nextRev,
      actorId,
      actorRole,
      evidenceDigest: approval.evidenceDigest,
      sanitizedPayload: { reason: reason.trim() },
      occurredAt: now,
    });

    const events = await tx.refundReconciliationApprovalEvent.findMany({
      where: { approvalId: approval.id },
      orderBy: { eventSequence: 'asc' },
    });
    return mapApprovalToView({ ...updated, events });
  }, RECONCILIATION_TX_OPTIONS);
}
