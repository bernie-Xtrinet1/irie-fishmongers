import { randomUUID } from 'crypto';

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  RefundReconciliationApprovalEventType,
  RefundReconciliationApprovalStatus,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  DualControlApprovalView,
  DualControlApproveInput,
  DualControlExecuteInput,
  DualControlExecutionResult,
  DualControlReconciliationRequestInput,
  DualControlRejectInput,
  DualControlRevokeInput,
  mapApprovalToView,
} from '../types/refund-dual-control.types';
import {
  applyPreExecutionTerminationTxFlow,
  DEFAULT_APPROVAL_TTL_MS,
  getDbNowTx,
  RECONCILIATION_TX_OPTIONS,
  requestReconciliationTxFlow,
} from './refund-dual-control-lifecycle.helper';
import {
  checkPreExecutionIntegrityTx,
  inspectApprovalView,
  inspectObligationReconciliationView,
  listApprovalViews,
  lockApprovalRowTx,
} from './refund-dual-control-query.helper';
import {
  lockPaymentObligationsAndRefunds,
  lockRefundFinancialHierarchy,
} from './refund-locks.helper';
import {
  appendApprovalLifecycleEventTx,
  checkStaleStateOrContradictionsTx,
  computeReconciliationApprovalDigest,
  verifyActiveAdministratorTx,
} from './refund-reconciliation-binding.helper';
import {
  executeApprovedTransitionTx,
  finalizeTerminalApprovalOutcomeTx,
} from './refund-reconciliation-execution.helper';

@Injectable()
export class RefundDualControlRepository {
  constructor(private readonly prisma: PrismaService) {}

  requestReconciliation(
    input: DualControlReconciliationRequestInput,
  ): Promise<DualControlApprovalView> {
    return requestReconciliationTxFlow(this.prisma, input);
  }

  async approveReconciliation(input: DualControlApproveInput): Promise<DualControlApprovalView> {
    return this.prisma.$transaction(async (tx) => {
      const approvalMeta = await tx.refundReconciliationApproval.findUnique({
        where: { id: input.approvalId },
      });
      if (!approvalMeta) {
        throw new NotFoundException(`Reconciliation approval "${input.approvalId}" not found`);
      }
      const obligationMeta = await tx.refundObligation.findUniqueOrThrow({
        where: { id: approvalMeta.obligationId },
      });

      const payment = await lockRefundFinancialHierarchy(
        tx,
        obligationMeta.paymentId,
        obligationMeta.orderId,
      );
      if (!payment) {
        throw new NotFoundException(`Payment "${obligationMeta.paymentId}" not found`);
      }
      await lockPaymentObligationsAndRefunds(tx, payment.id);

      const approval = await lockApprovalRowTx(tx, input.approvalId);
      const now = await getDbNowTx(tx);

      await verifyActiveAdministratorTx(tx, input.approvedByActorId, 'Approver');
      await verifyActiveAdministratorTx(tx, approval.requestedByActorId, 'Requester');

      if (approval.requestedByActorId === input.approvedByActorId) {
        throw new ForbiddenException('Dual control violation: approver cannot equal requester');
      }
      if (approval.status !== RefundReconciliationApprovalStatus.REQUESTED) {
        throw new ConflictException(`Approval "${approval.id}" is in status ${approval.status}`);
      }
      if (
        !approval.paymentId ||
        !approval.provider ||
        !approval.merchantAccountId ||
        !approval.amount ||
        !approval.currency ||
        !approval.requestedOutcome ||
        !approval.requestDigest ||
        !approval.expiresAt
      ) {
        throw new ConflictException(
          `Legacy/unbound approval "${approval.id}" lacks dual-control bindings; retire via revoke before creating a fresh bound request`,
        );
      }
      if (
        input.expectedAuthorizationRevision !== undefined &&
        approval.authorizationRevision !== input.expectedAuthorizationRevision
      ) {
        throw new ConflictException('Stale authorizationRevision on approval');
      }
      if (
        input.expectedEvidenceDigest &&
        approval.evidenceDigest.toLowerCase() !== input.expectedEvidenceDigest.trim().toLowerCase()
      ) {
        throw new ConflictException('Provided evidenceDigest does not match request evidenceDigest');
      }

      if (approval.expiresAt && now >= approval.expiresAt) {
        const nextRev = approval.authorizationRevision + 1;
        await tx.refundReconciliationApproval.update({
          where: { id: approval.id },
          data: { status: RefundReconciliationApprovalStatus.EXPIRED, authorizationRevision: nextRev },
        });
        await appendApprovalLifecycleEventTx(tx, {
          approvalId: approval.id,
          obligationId: obligationMeta.id,
          eventType: RefundReconciliationApprovalEventType.EXPIRED,
          previousStatus: approval.status,
          resultingStatus: RefundReconciliationApprovalStatus.EXPIRED,
          authorizationRevision: nextRev,
          actorId: input.approvedByActorId,
          actorRole: input.actorRole,
          evidenceDigest: approval.evidenceDigest,
          occurredAt: now,
        });
        throw new ConflictException(`Approval "${approval.id}" expired before grant`);
      }

      const approvalExpiresAt =
        input.expiresAt ?? approval.expiresAt ?? new Date(now.getTime() + DEFAULT_APPROVAL_TTL_MS);
      const approvalDigest = computeReconciliationApprovalDigest({
        approvalId: approval.id,
        requestDigest: approval.requestDigest ?? approval.evidenceDigest,
        approvedByActorId: input.approvedByActorId,
        approvedAt: now.toISOString(),
        expiresAt: approvalExpiresAt.toISOString(),
      });
      const nextRev = approval.authorizationRevision + 1;

      const updated = await tx.refundReconciliationApproval.update({
        where: { id: approval.id },
        data: {
          status: RefundReconciliationApprovalStatus.APPROVED,
          approvedByActorId: input.approvedByActorId,
          approvedAt: now,
          expiresAt: approvalExpiresAt,
          approvalDigest,
          authorizationRevision: nextRev,
        },
      });

      await appendApprovalLifecycleEventTx(tx, {
        approvalId: approval.id,
        obligationId: obligationMeta.id,
        eventType: RefundReconciliationApprovalEventType.APPROVED,
        previousStatus: approval.status,
        resultingStatus: RefundReconciliationApprovalStatus.APPROVED,
        authorizationRevision: nextRev,
        actorId: input.approvedByActorId,
        actorRole: input.actorRole,
        evidenceDigest: approval.evidenceDigest,
        sanitizedPayload: { approvalDigest, expiresAt: approvalExpiresAt.toISOString() },
        occurredAt: now,
      });

      const events = await tx.refundReconciliationApprovalEvent.findMany({
        where: { approvalId: approval.id },
        orderBy: { eventSequence: 'asc' },
      });
      return mapApprovalToView({ ...updated, events });
    }, RECONCILIATION_TX_OPTIONS);
  }

  rejectReconciliation(input: DualControlRejectInput): Promise<DualControlApprovalView> {
    return applyPreExecutionTerminationTxFlow(this.prisma, {
      approvalId: input.approvalId,
      actorId: input.rejectedByActorId,
      actorRole: input.actorRole,
      reason: input.rejectionReason,
      targetStatus: 'REJECTED',
    });
  }

  revokeReconciliation(input: DualControlRevokeInput): Promise<DualControlApprovalView> {
    return applyPreExecutionTerminationTxFlow(this.prisma, {
      approvalId: input.approvalId,
      actorId: input.revokedByActorId,
      actorRole: input.actorRole,
      reason: input.revocationReason,
      targetStatus: 'REVOKED',
    });
  }

  async executeReconciliation(
    input: DualControlExecuteInput,
  ): Promise<DualControlExecutionResult> {
    return this.prisma.$transaction(async (tx) => {
      const approvalMeta = await tx.refundReconciliationApproval.findUnique({
        where: { id: input.approvalId },
      });
      if (!approvalMeta) {
        throw new NotFoundException(`Reconciliation approval "${input.approvalId}" not found`);
      }
      const obligationMeta = await tx.refundObligation.findUniqueOrThrow({
        where: { id: approvalMeta.obligationId },
      });

      const payment = await lockRefundFinancialHierarchy(
        tx,
        obligationMeta.paymentId,
        obligationMeta.orderId,
      );
      if (!payment) {
        throw new NotFoundException(`Payment "${obligationMeta.paymentId}" not found`);
      }
      await lockPaymentObligationsAndRefunds(tx, payment.id);

      const approval = await lockApprovalRowTx(tx, input.approvalId);
      const obligation = await tx.refundObligation.findUniqueOrThrow({
        where: { id: approval.obligationId },
      });
      const targetAttempt = approval.attemptId
        ? await tx.refundProviderAttempt.findUnique({ where: { id: approval.attemptId } })
        : null;
      const targetRefund = approval.refundId
        ? await tx.refund.findUnique({ where: { id: approval.refundId } })
        : null;
      const now = await getDbNowTx(tx);

      if (approval.status !== RefundReconciliationApprovalStatus.APPROVED) {
        throw new ConflictException(
          `Approval "${approval.id}" cannot execute from status ${approval.status}`,
        );
      }
      if (approval.requestedByActorId === input.executedByActorId) {
        throw new ForbiddenException('Dual control violation: requester cannot execute own request');
      }
      await verifyActiveAdministratorTx(tx, input.executedByActorId, 'Executor');

      if (approval.expiresAt && now >= approval.expiresAt) {
        return finalizeTerminalApprovalOutcomeTx(tx, {
          approval,
          targetStatus: 'EXPIRED',
          actorId: input.executedByActorId,
          actorRole: input.actorRole,
          now,
          reason: `Approval "${approval.id}" expired at ${approval.expiresAt.toISOString()}`,
          payment,
          obligation,
          currentRefundStatus: targetRefund?.status ?? null,
          currentAttemptStatus: targetAttempt?.status ?? null,
        });
      }

      if (
        input.expectedAuthorizationRevision !== undefined &&
        approval.authorizationRevision !== input.expectedAuthorizationRevision
      ) {
        throw new ConflictException('Stale authorizationRevision on execution');
      }

      const integrityFailure = await checkPreExecutionIntegrityTx(
        tx,
        approval,
        obligation,
        payment,
        targetAttempt,
        input.expectedEvidenceDigest,
      );
      if (integrityFailure) {
        return finalizeTerminalApprovalOutcomeTx(tx, {
          approval,
          targetStatus: 'QUARANTINED',
          actorId: input.executedByActorId,
          actorRole: input.actorRole,
          now,
          reason: integrityFailure,
          payment,
          obligation,
          currentRefundStatus: targetRefund?.status ?? null,
          currentAttemptStatus: targetAttempt?.status ?? null,
        });
      }

      const claimToken = randomUUID();
      const claimedRev = approval.authorizationRevision + 1;
      const casClaim = await tx.refundReconciliationApproval.updateMany({
        where: {
          id: approval.id,
          status: RefundReconciliationApprovalStatus.APPROVED,
          authorizationRevision: approval.authorizationRevision,
        },
        data: {
          status: RefundReconciliationApprovalStatus.EXECUTING,
          executedByActorId: input.executedByActorId,
          executingAt: now,
          executionClaimToken: claimToken,
          authorizationRevision: claimedRev,
        },
      });
      if (casClaim.count !== 1) {
        throw new ConflictException(`Concurrent execution claim rejected for "${approval.id}"`);
      }

      await appendApprovalLifecycleEventTx(tx, {
        approvalId: approval.id,
        obligationId: obligation.id,
        eventType: RefundReconciliationApprovalEventType.EXECUTION_CLAIMED,
        previousStatus: RefundReconciliationApprovalStatus.APPROVED,
        resultingStatus: RefundReconciliationApprovalStatus.EXECUTING,
        authorizationRevision: claimedRev,
        actorId: input.executedByActorId,
        actorRole: input.actorRole,
        evidenceDigest: approval.evidenceDigest,
        sanitizedPayload: { executionClaimToken: claimToken },
        occurredAt: now,
      });

      const claimedApproval = await tx.refundReconciliationApproval.findUniqueOrThrow({
        where: { id: approval.id },
      });

      const staleness = await checkStaleStateOrContradictionsTx(
        tx,
        claimedApproval,
        obligation,
        targetAttempt,
      );
      if (staleness.stale) {
        return finalizeTerminalApprovalOutcomeTx(tx, {
          approval: claimedApproval,
          targetStatus: 'QUARANTINED',
          actorId: input.executedByActorId,
          actorRole: input.actorRole,
          now,
          reason: staleness.reason,
          payment,
          obligation,
          currentRefundStatus: targetRefund?.status ?? null,
          currentAttemptStatus: targetAttempt?.status ?? null,
        });
      }

      return executeApprovedTransitionTx({
        tx,
        approval: claimedApproval,
        claimedRevision: claimedRev,
        now,
        executedByActorId: input.executedByActorId,
        actorRole: input.actorRole,
        payment,
        obligation,
        targetAttempt,
        targetRefundStatus: targetRefund?.status ?? null,
      });
    }, RECONCILIATION_TX_OPTIONS);
  }

  inspectApprovalById(approvalId: string): Promise<DualControlApprovalView> {
    return inspectApprovalView(this.prisma, approvalId);
  }

  listApprovals(filter?: {
    obligationId?: string;
    status?: RefundReconciliationApprovalStatus;
    limit?: number;
  }): Promise<DualControlApprovalView[]> {
    return listApprovalViews(this.prisma, filter);
  }

  inspectObligation(obligationId: string) {
    return inspectObligationReconciliationView(this.prisma, obligationId);
  }
}
