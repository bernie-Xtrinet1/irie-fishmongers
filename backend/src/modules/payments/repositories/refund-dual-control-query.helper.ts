import { NotFoundException } from '@nestjs/common';
import {
  PaymentProviderName,
  Prisma,
  RefundObligation,
  RefundProviderAttempt,
  RefundReconciliationApproval,
  RefundReconciliationApprovalStatus,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  DualControlApprovalView,
  mapApprovalToView,
} from '../types/refund-dual-control.types';
import {
  computeReconciliationApprovalDigest,
  computeReconciliationRequestDigest,
  validateEvidenceReceiptsTx,
  verifyActiveAdministratorTx,
} from './refund-reconciliation-binding.helper';

export async function lockApprovalRowTx(
  tx: Prisma.TransactionClient,
  approvalId: string,
): Promise<RefundReconciliationApproval> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "refund_reconciliation_approvals" WHERE "id" = ${approvalId} FOR UPDATE`,
  );
  return tx.refundReconciliationApproval.findUniqueOrThrow({ where: { id: approvalId } });
}

export async function checkPreExecutionIntegrityTx(
  tx: Prisma.TransactionClient,
  approval: RefundReconciliationApproval,
  obligation: RefundObligation,
  payment: { provider: PaymentProviderName; merchantAccountId: string; providerReference: string | null },
  targetAttempt: RefundProviderAttempt | null,
  expectedEvidenceDigest?: string | null,
): Promise<string | null> {
  try {
    await verifyActiveAdministratorTx(tx, approval.requestedByActorId, 'Requester');
    await verifyActiveAdministratorTx(tx, approval.approvedByActorId, 'Approver');
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  if (
    expectedEvidenceDigest &&
    approval.evidenceDigest.toLowerCase() !== expectedEvidenceDigest.trim().toLowerCase()
  ) {
    return 'Provided evidenceDigest mismatches locked approval evidenceDigest';
  }

  if (
    approval.paymentId !== obligation.paymentId ||
    approval.provider !== payment.provider ||
    approval.merchantAccountId !== payment.merchantAccountId ||
    !approval.amount ||
    !new Prisma.Decimal(approval.amount).equals(new Prisma.Decimal(obligation.authorizedAmount)) ||
    approval.currency?.toUpperCase() !== obligation.currency.toUpperCase()
  ) {
    return 'Bound financial/merchant identity mismatch detected against locked payment/obligation';
  }

  const receiptIds = Array.isArray(approval.evidenceReceiptIds)
    ? approval.evidenceReceiptIds.filter((v): v is string => typeof v === 'string')
    : [];
  const expectedReqDigest = computeReconciliationRequestDigest({
    obligationId: obligation.id,
    refundId: approval.refundId,
    attemptId: approval.attemptId,
    paymentId: obligation.paymentId,
    provider: payment.provider,
    merchantAccountId: payment.merchantAccountId,
    amount: new Prisma.Decimal(obligation.authorizedAmount).toFixed(2),
    currency: obligation.currency,
    actionType: approval.actionType,
    requestedOutcome: approval.requestedOutcome,
    evidenceType: approval.evidenceType,
    externalSettlementReference: approval.externalSettlementReference,
    evidenceDigest: approval.evidenceDigest,
    evidenceReceiptIds: receiptIds,
    rationale: approval.rationale,
    requestedByActorId: approval.requestedByActorId,
    expiresAt: approval.expiresAt ? approval.expiresAt.toISOString() : null,
  });
  if (approval.requestDigest && approval.requestDigest !== expectedReqDigest) {
    return 'Approval requestDigest does not match recomputed canonical digest (tampered or modified evidence)';
  }

  if (approval.approvalDigest && approval.approvedByActorId && approval.approvedAt && approval.expiresAt) {
    const expectedAppDigest = computeReconciliationApprovalDigest({
      approvalId: approval.id,
      requestDigest: expectedReqDigest,
      approvedByActorId: approval.approvedByActorId,
      approvedAt: approval.approvedAt.toISOString(),
      expiresAt: approval.expiresAt.toISOString(),
    });
    if (approval.approvalDigest !== expectedAppDigest) {
      return 'Approval signature digest mismatch (post-approval alteration detected)';
    }
  }

  const receiptCheck = await validateEvidenceReceiptsTx(tx, {
    receiptIds,
    obligation,
    attempt: targetAttempt,
    paymentProvider: payment.provider,
    merchantAccountId: payment.merchantAccountId,
    paymentProviderReference: payment.providerReference,
    externalSettlementReference: approval.externalSettlementReference,
    requestedOutcome: approval.requestedOutcome,
    currentApprovalId: approval.id,
  });
  if (!receiptCheck.valid) {
    return receiptCheck.reason;
  }

  return null;
}

export async function inspectApprovalView(
  prisma: PrismaService,
  approvalId: string,
): Promise<DualControlApprovalView> {
  const row = await prisma.refundReconciliationApproval.findUnique({
    where: { id: approvalId },
    include: { events: { orderBy: { eventSequence: 'asc' } } },
  });
  if (!row) {
    throw new NotFoundException(`Reconciliation approval "${approvalId}" not found`);
  }
  return mapApprovalToView(row);
}

export async function listApprovalViews(
  prisma: PrismaService,
  filter?: {
    obligationId?: string;
    status?: RefundReconciliationApprovalStatus;
    limit?: number;
  },
): Promise<DualControlApprovalView[]> {
  const rows = await prisma.refundReconciliationApproval.findMany({
    where: {
      ...(filter?.obligationId ? { obligationId: filter.obligationId } : {}),
      ...(filter?.status ? { status: filter.status } : {}),
    },
    include: { events: { orderBy: { eventSequence: 'asc' } } },
    orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }],
    take: filter?.limit ?? 50,
  });
  return rows.map((r) => mapApprovalToView(r));
}

export async function inspectObligationReconciliationView(
  prisma: PrismaService,
  obligationId: string,
) {
  const obligation = await prisma.refundObligation.findUnique({
    where: { id: obligationId },
    include: {
      refunds: { orderBy: { createdAt: 'asc' } },
      attempts: {
        orderBy: { attemptSequence: 'asc' },
        include: { events: { orderBy: { eventSequence: 'asc' } } },
      },
      evidenceReceipts: { orderBy: { receivedAt: 'desc' } },
      reconciliationApprovals: {
        orderBy: { requestedAt: 'desc' },
        include: { events: { orderBy: { eventSequence: 'asc' } } },
      },
    },
  });
  if (!obligation) {
    throw new NotFoundException(`Refund obligation "${obligationId}" not found`);
  }
  return {
    id: obligation.id,
    paymentId: obligation.paymentId,
    orderId: obligation.orderId,
    vendorOrderId: obligation.vendorOrderId,
    obligationKey: obligation.obligationKey,
    obligationType: obligation.obligationType,
    authorizedAmount: obligation.authorizedAmount.toString(),
    currency: obligation.currency,
    reason: obligation.reason,
    status: obligation.status,
    refunds: obligation.refunds.map((r) => ({
      id: r.id,
      status: r.status,
      amount: r.amount.toString(),
      providerReference: r.providerReference,
      supersedesRefundId: r.supersedesRefundId,
      createdAt: r.createdAt,
    })),
    attempts: obligation.attempts.map((a) => ({
      id: a.id,
      refundId: a.refundId,
      attemptSequence: a.attemptSequence,
      status: a.status,
      failureClassification: a.failureClassification,
      provider: a.provider,
      merchantAccountId: a.merchantAccountId,
      providerRefundReference: a.providerRefundReference,
      resolvedByProvenance: a.resolvedByProvenance,
      quarantinedAt: a.quarantinedAt,
      terminalizedAt: a.terminalizedAt,
      events: a.events.map((e) => ({
        id: e.id,
        eventSequence: e.eventSequence,
        eventType: e.eventType,
        previousAttemptStatus: e.previousAttemptStatus,
        resultingAttemptStatus: e.resultingAttemptStatus,
        provenance: e.provenance,
        evidenceDigest: e.evidenceDigest,
        occurredAt: e.occurredAt,
      })),
    })),
    evidenceReceipts: obligation.evidenceReceipts.map((rc) => ({
      id: rc.id,
      eventId: rc.eventId,
      provider: rc.provider,
      merchantAccountId: rc.merchantAccountId,
      provenance: rc.provenance,
      disposition: rc.disposition,
      signatureValid: rc.signatureValid,
      evidenceDigest: rc.evidenceDigest,
      rejectionReason: rc.rejectionReason,
      receivedAt: rc.receivedAt,
    })),
    reconciliationApprovals: obligation.reconciliationApprovals.map((a) => mapApprovalToView(a)),
  };
}
