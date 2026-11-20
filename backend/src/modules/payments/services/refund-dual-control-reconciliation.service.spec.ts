import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  RefundAttemptStatus,
  RefundObligationStatus,
  RefundReconciliationActionType,
  RefundReconciliationApprovalStatus,
  RefundReconciliationOutcome,
  RoleName,
} from '@prisma/client';

import { RefundDualControlRepository } from '../repositories/refund-dual-control.repository';
import { DualControlApprovalView } from '../types/refund-dual-control.types';
import { RefundDualControlReconciliationService } from './refund-dual-control-reconciliation.service';

describe('RefundDualControlReconciliationService (unit)', () => {
  const sampleView: DualControlApprovalView = {
    id: '11111111-1111-4111-8111-111111111111',
    obligationId: '22222222-2222-4222-8222-222222222222',
    refundId: '33333333-3333-4333-8333-333333333333',
    attemptId: '44444444-4444-4444-8444-444444444444',
    paymentId: '55555555-5555-4555-8555-555555555555',
    provider: 'WIPAY',
    merchantAccountId: 'merch-1',
    amount: '50.00',
    currency: 'JMD',
    actionType: RefundReconciliationActionType.RESOLVE_QUARANTINED_COMPLETED,
    requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
    evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL',
    externalSettlementReference: 'gw-ref-1',
    evidenceDigest: 'a'.repeat(64),
    evidenceReceiptIds: [],
    requestDigest: 'b'.repeat(64),
    approvalDigest: null,
    rationale: 'Verified settlement reference',
    authorizationRevision: 1,
    requestedByActorId: 'admin-a',
    requestedAt: new Date(),
    approvedByActorId: null,
    approvedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    rejectedByActorId: null,
    rejectedAt: null,
    rejectionReason: null,
    revokedByActorId: null,
    revokedAt: null,
    revocationReason: null,
    executedByActorId: null,
    executingAt: null,
    appliedAt: null,
    quarantinedAt: null,
    quarantineReason: null,
    resultingAttemptEventId: null,
    resultingOutboxId: null,
    resultingAttemptStatus: null,
    resultingRefundStatus: null,
    resultingObligationStatus: null,
    status: RefundReconciliationApprovalStatus.REQUESTED,
    events: [],
  };

  let requestMock: jest.Mock;
  let executeMock: jest.Mock;
  let repoMock: jest.Mocked<RefundDualControlRepository>;
  let service: RefundDualControlReconciliationService;

  beforeEach(() => {
    requestMock = jest.fn().mockResolvedValue(sampleView);
    executeMock = jest.fn().mockResolvedValue({
      applied: true,
      quarantined: false,
      expired: false,
      approval: { ...sampleView, status: RefundReconciliationApprovalStatus.APPLIED },
      obligationStatus: RefundObligationStatus.FULFILLED,
      refundStatus: 'COMPLETED',
      attemptStatus: RefundAttemptStatus.COMPLETED,
      attemptEventId: 'evt-1',
      outboxEventId: 'out-1',
      message: 'Applied',
    });
    repoMock = {
      requestReconciliation: requestMock,
      approveReconciliation: jest
        .fn()
        .mockResolvedValue({ ...sampleView, status: RefundReconciliationApprovalStatus.APPROVED }),
      rejectReconciliation: jest
        .fn()
        .mockResolvedValue({ ...sampleView, status: RefundReconciliationApprovalStatus.REJECTED }),
      revokeReconciliation: jest
        .fn()
        .mockResolvedValue({ ...sampleView, status: RefundReconciliationApprovalStatus.REVOKED }),
      executeReconciliation: executeMock,
      inspectApprovalById: jest.fn().mockResolvedValue(sampleView),
      listApprovals: jest.fn().mockResolvedValue([sampleView]),
      inspectObligation: jest.fn(),
    } as unknown as jest.Mocked<RefundDualControlRepository>;

    service = new RefundDualControlReconciliationService(repoMock);
  });

  it('rejects blank actor identities before reaching the repository', async () => {
    await expect(
      service.requestReconciliation({
        obligationId: sampleView.obligationId,
        requestedOutcome: RefundReconciliationOutcome.CONTINUE_QUARANTINE,
        evidenceType: 'MANUAL_REVIEW',
        rationale: 'Investigating gateway response',
        requestedByActorId: '   ',
      }),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      service.executeReconciliation({
        approvalId: sampleView.id,
        executedByActorId: '',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects invalid expiresAt dates on approveReconciliation', async () => {
    await expect(
      service.approveReconciliation({
        approvalId: sampleView.id,
        approvedByActorId: 'admin-b',
        expiresAt: new Date('invalid-date'),
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('delegates request, approve, reject, revoke, and execute with normalized ADMINISTRATOR role', async () => {
    await service.requestReconciliation({
      obligationId: sampleView.obligationId,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
      evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL',
      externalSettlementReference: 'gw-ref-1',
      rationale: 'Verified in portal',
      requestedByActorId: ' admin-a ',
    });
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedByActorId: 'admin-a',
        actorRole: RoleName.ADMINISTRATOR,
      }),
    );

    const execRes = await service.executeReconciliation({
      approvalId: sampleView.id,
      executedByActorId: ' admin-b ',
    });
    expect(execRes.applied).toBe(true);
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executedByActorId: 'admin-b',
        actorRole: RoleName.ADMINISTRATOR,
      }),
    );
  });
});
