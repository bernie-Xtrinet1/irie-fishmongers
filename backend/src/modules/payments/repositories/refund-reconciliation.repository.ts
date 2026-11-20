import { randomUUID } from 'crypto';

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  PaymentProviderName,
  RefundAttemptStatus,
  RefundEvidenceDisposition,
  RefundEvidenceProvenance,
  RefundProviderAttempt,
  RefundReconciliationActionType,
  RefundReconciliationApproval,
  RefundReconciliationOutcome,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  ApproveReconciliationInput,
  ReconciliationApprovalResult,
  RefundAttemptInspectionRecord,
  RequestReconciliationApprovalInput,
  VoidObligationWithApprovalInput,
} from '../types/refund-ledger.types';
import { RefundDualControlRepository } from './refund-dual-control.repository';
import { sha256Hex } from './refund-locks.helper';
import { recoverExpiredDispatchingLeasesWithClient } from './refund-recovery.repository';

function mapLegacyActionToOutcome(
  actionType: RefundReconciliationActionType,
): RefundReconciliationOutcome {
  if (actionType === RefundReconciliationActionType.VOID_OBLIGATION) {
    return RefundReconciliationOutcome.VOID_OBLIGATION;
  }
  if (actionType === RefundReconciliationActionType.CONTINUE_QUARANTINE) {
    return RefundReconciliationOutcome.CONTINUE_QUARANTINE;
  }
  if (
    actionType === RefundReconciliationActionType.RESOLVE_QUARANTINED_DEFINITIVE_FAIL_NO_REMITTANCE
  ) {
    return RefundReconciliationOutcome.VERIFIED_FAILED;
  }
  return RefundReconciliationOutcome.VERIFIED_COMPLETED;
}

@Injectable()
export class RefundReconciliationRepository {
  private readonly dualControl: RefundDualControlRepository;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() dualControlRepo?: RefundDualControlRepository,
  ) {
    this.dualControl = dualControlRepo ?? new RefundDualControlRepository(prisma);
  }

  async inspectByObligationId(obligationId: string): Promise<RefundAttemptInspectionRecord | null> {
    const obligation = await this.prisma.refundObligation.findUnique({
      where: { id: obligationId },
    });
    if (!obligation) {
      return null;
    }

    const [refunds, attempts] = await Promise.all([
      this.prisma.refund.findMany({
        where: { obligationId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.refundProviderAttempt.findMany({
        where: { obligationId },
        include: { events: { orderBy: { eventSequence: 'asc' } } },
        orderBy: { attemptSequence: 'asc' },
      }),
    ]);

    return { obligation, refunds, attempts };
  }

  async inspectByRefundId(refundId: string): Promise<RefundAttemptInspectionRecord | null> {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund?.obligationId) {
      return null;
    }
    return this.inspectByObligationId(refund.obligationId);
  }

  async listQuarantinedAndActiveAttempts(paymentId?: string): Promise<RefundProviderAttempt[]> {
    return this.prisma.refundProviderAttempt.findMany({
      where: {
        ...(paymentId ? { paymentId } : {}),
        status: {
          in: [
            RefundAttemptStatus.PREPARED,
            RefundAttemptStatus.DISPATCHING,
            RefundAttemptStatus.PROVIDER_PENDING,
            RefundAttemptStatus.AMBIGUOUS_OUTCOME,
          ],
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async quarantineExpiredDispatchingAttempts(referenceTime = new Date()): Promise<string[]> {
    const summary = await recoverExpiredDispatchingLeasesWithClient(this.prisma, referenceTime);
    return summary.quarantinedIds;
  }

  async requestApproval(
    input: RequestReconciliationApprovalInput,
  ): Promise<RefundReconciliationApproval> {
    const view = await this.dualControl.requestReconciliation({
      obligationId: input.obligationId,
      attemptId: input.attemptId ?? null,
      requestedOutcome: mapLegacyActionToOutcome(input.actionType),
      evidenceType: input.evidenceType,
      externalSettlementReference: input.externalSettlementReference ?? null,
      rawEvidence: input.rawEvidence,
      rationale: input.rationale,
      requestedByActorId: input.requestedByActorId,
    });
    return this.prisma.refundReconciliationApproval.findUniqueOrThrow({
      where: { id: view.id },
    });
  }

  async approveApproval(input: ApproveReconciliationInput): Promise<RefundReconciliationApproval> {
    const view = await this.dualControl.approveReconciliation({
      approvalId: input.approvalId,
      approvedByActorId: input.approvedByActorId,
    });
    return this.prisma.refundReconciliationApproval.findUniqueOrThrow({
      where: { id: view.id },
    });
  }

  async voidObligationWithApproval(
    input: VoidObligationWithApprovalInput,
  ): Promise<ReconciliationApprovalResult> {
    const existingApproval = await this.prisma.refundReconciliationApproval.findUnique({
      where: { id: input.approvalId },
    });
    if (!existingApproval || existingApproval.obligationId !== input.obligationId) {
      throw new ConflictException('Void approval does not match obligation');
    }
    if (existingApproval.actionType !== RefundReconciliationActionType.VOID_OBLIGATION) {
      throw new ConflictException(
        `Approval actionType ${existingApproval.actionType} is not VOID_OBLIGATION`,
      );
    }
    if (!input.actor?.actorId) {
      throw new ForbiddenException('Executor administrator identity is required');
    }

    const result = await this.dualControl.executeReconciliation({
      approvalId: input.approvalId,
      executedByActorId: input.actor.actorId,
      actorRole: input.actor.actorRole ?? null,
    });
    if (!result.applied) {
      throw new ConflictException(result.message);
    }

    const [approval, obligation] = await Promise.all([
      this.prisma.refundReconciliationApproval.findUniqueOrThrow({ where: { id: input.approvalId } }),
      this.prisma.refundObligation.findUniqueOrThrow({ where: { id: input.obligationId } }),
    ]);
    if (!approval || !obligation) {
      throw new NotFoundException('Voided obligation or approval missing after execution');
    }
    return { approval, obligation };
  }

  recordExternalEvidenceReceipt(params: {
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
    rawEvidence: unknown;
    sourceIp?: string | null;
    rejectionReason?: string | null;
  }) {
    return this.prisma.refundEvidenceReceipt.create({
      data: {
        id: randomUUID(),
        provider: params.provider,
        merchantAccountId: params.merchantAccountId,
        eventId: params.eventId,
        providerRefundReference: params.providerRefundReference ?? null,
        attemptId: params.attemptId ?? null,
        refundId: params.refundId ?? null,
        obligationId: params.obligationId ?? null,
        provenance: params.provenance,
        disposition: params.disposition,
        signatureValid: params.signatureValid,
        evidenceDigest: sha256Hex(params.rawEvidence),
        sourceIp: params.sourceIp ?? null,
        rejectionReason: params.rejectionReason ?? null,
      },
    });
  }
}
