import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { RefundReconciliationApprovalStatus, RoleName } from '@prisma/client';

import { RefundDualControlRepository } from '../repositories/refund-dual-control.repository';
import {
  DualControlApprovalView,
  DualControlApproveInput,
  DualControlExecuteInput,
  DualControlExecutionResult,
  DualControlReconciliationRequestInput,
  DualControlRejectInput,
  DualControlRevokeInput,
} from '../types/refund-dual-control.types';

function assertActorIdentity(actorId: string | null | undefined, label: string): string {
  const trimmed = actorId?.trim();
  if (!trimmed) {
    throw new ForbiddenException(`${label} administrator identity is required`);
  }
  return trimmed;
}

@Injectable()
export class RefundDualControlReconciliationService {
  private readonly logger = new Logger(RefundDualControlReconciliationService.name);

  constructor(private readonly dualControlRepository: RefundDualControlRepository) {}

  async requestReconciliation(
    input: DualControlReconciliationRequestInput,
  ): Promise<DualControlApprovalView> {
    const requestedByActorId = assertActorIdentity(input.requestedByActorId, 'Requester');
    const view = await this.dualControlRepository.requestReconciliation({
      ...input,
      requestedByActorId,
      actorRole: input.actorRole ?? RoleName.ADMINISTRATOR,
    });

    this.logger.log(
      JSON.stringify({
        event: 'refund_reconciliation_requested',
        approvalId: view.id,
        obligationId: view.obligationId,
        actionType: view.actionType,
        requestedOutcome: view.requestedOutcome,
        authorizationRevision: view.authorizationRevision,
        evidenceDigest: view.evidenceDigest,
        actorId: requestedByActorId,
      }),
    );

    return view;
  }

  async approveReconciliation(
    input: DualControlApproveInput,
  ): Promise<DualControlApprovalView> {
    const approvedByActorId = assertActorIdentity(input.approvedByActorId, 'Approver');
    if (input.expiresAt && Number.isNaN(input.expiresAt.getTime())) {
      throw new BadRequestException('Invalid expiresAt timestamp');
    }

    const view = await this.dualControlRepository.approveReconciliation({
      ...input,
      approvedByActorId,
      actorRole: input.actorRole ?? RoleName.ADMINISTRATOR,
    });

    this.logger.log(
      JSON.stringify({
        event: 'refund_reconciliation_approved',
        approvalId: view.id,
        obligationId: view.obligationId,
        status: view.status,
        authorizationRevision: view.authorizationRevision,
        evidenceDigest: view.evidenceDigest,
        actorId: approvedByActorId,
      }),
    );

    return view;
  }

  async rejectReconciliation(
    input: DualControlRejectInput,
  ): Promise<DualControlApprovalView> {
    const rejectedByActorId = assertActorIdentity(input.rejectedByActorId, 'Rejector');
    const view = await this.dualControlRepository.rejectReconciliation({
      ...input,
      rejectedByActorId,
      actorRole: input.actorRole ?? RoleName.ADMINISTRATOR,
    });

    this.logger.log(
      JSON.stringify({
        event: 'refund_reconciliation_rejected',
        approvalId: view.id,
        obligationId: view.obligationId,
        status: view.status,
        authorizationRevision: view.authorizationRevision,
        actorId: rejectedByActorId,
      }),
    );

    return view;
  }

  async revokeReconciliation(
    input: DualControlRevokeInput,
  ): Promise<DualControlApprovalView> {
    const revokedByActorId = assertActorIdentity(input.revokedByActorId, 'Revoker');
    const view = await this.dualControlRepository.revokeReconciliation({
      ...input,
      revokedByActorId,
      actorRole: input.actorRole ?? RoleName.ADMINISTRATOR,
    });

    this.logger.log(
      JSON.stringify({
        event: 'refund_reconciliation_revoked',
        approvalId: view.id,
        obligationId: view.obligationId,
        status: view.status,
        authorizationRevision: view.authorizationRevision,
        actorId: revokedByActorId,
      }),
    );

    return view;
  }

  async executeReconciliation(
    input: DualControlExecuteInput,
  ): Promise<DualControlExecutionResult> {
    const executedByActorId = assertActorIdentity(input.executedByActorId, 'Executor');
    const result = await this.dualControlRepository.executeReconciliation({
      ...input,
      executedByActorId,
      actorRole: input.actorRole ?? RoleName.ADMINISTRATOR,
    });

    const event = result.applied
      ? 'refund_reconciliation_applied'
      : result.expired
        ? 'refund_reconciliation_expired'
        : 'refund_reconciliation_quarantined';

    this.logger.log(
      JSON.stringify({
        event,
        approvalId: result.approval.id,
        obligationId: result.approval.obligationId,
        approvalStatus: result.approval.status,
        obligationStatus: result.obligationStatus,
        refundStatus: result.refundStatus,
        attemptStatus: result.attemptStatus,
        authorizationRevision: result.approval.authorizationRevision,
        evidenceDigest: result.approval.evidenceDigest,
        actorId: executedByActorId,
      }),
    );

    return result;
  }

  inspectApprovalById(approvalId: string): Promise<DualControlApprovalView> {
    return this.dualControlRepository.inspectApprovalById(approvalId);
  }

  listApprovals(filter?: {
    obligationId?: string;
    status?: RefundReconciliationApprovalStatus;
    limit?: number;
  }): Promise<DualControlApprovalView[]> {
    return this.dualControlRepository.listApprovals(filter);
  }

  inspectObligation(obligationId: string) {
    return this.dualControlRepository.inspectObligation(obligationId);
  }
}
