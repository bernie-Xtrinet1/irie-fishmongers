import { randomUUID } from 'crypto';

import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  RefundAttemptFailureClass,
  RefundAttemptStatus,
  RefundEvidenceDisposition,
  RefundObligationStatus,
  RefundReconciliationApprovalEventType,
  RefundReconciliationApprovalStatus,
  RefundReconciliationOutcome,
  RoleName,
  UserStatus,
} from '@prisma/client';

import {
  createDualControlTestFixture,
  DualControlTestFixture,
} from './refund-dual-control-fixture.helper';

jest.setTimeout(120_000);

describe('Dual-Control Refund Reconciliation Authorization, Expiry & Digest Binding (PG Suite)', () => {
  let fx: DualControlTestFixture;

  beforeAll(async () => {
    fx = await createDualControlTestFixture();
  });

  afterAll(async () => {
    await fx?.destroy();
  });

  it('1. Rejects non-admin, inactive-admin, and self-approval/self-execution requester=approver/executor attempts', async () => {
    const c1 = await fx.seedQuarantinedCase({ amount: '55.00' });
    const receipt = await fx.seedEvidenceReceipt({
      obligationId: c1.obligationId,
      attemptId: c1.attemptId,
      refundId: c1.refundId,
      merchantAccountId: c1.merchantAccountId,
    });
    const nonAdmin = await fx.seedAdminUser('cust', { role: RoleName.CUSTOMER });
    const suspendedAdmin = await fx.seedAdminUser('susp', { status: UserStatus.SUSPENDED });

    await expect(
      fx.service.requestReconciliation({
        obligationId: c1.obligationId,
        requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
        evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL',
        externalSettlementReference: `gw-auth-${randomUUID().slice(0, 8)}`,
        evidenceReceiptIds: [receipt.id],
        rationale: 'Non-admin requester must be rejected',
        requestedByActorId: nonAdmin.id,
      }),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      fx.service.requestReconciliation({
        obligationId: c1.obligationId,
        requestedOutcome: RefundReconciliationOutcome.CONTINUE_QUARANTINE,
        evidenceType: 'MANUAL_REVIEW',
        rationale: 'Suspended admin requester must be rejected',
        requestedByActorId: suspendedAdmin.id,
      }),
    ).rejects.toThrow(ForbiddenException);

    const req = await fx.service.requestReconciliation({
      obligationId: c1.obligationId,
      attemptId: c1.attemptId,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
      evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL',
      externalSettlementReference: `gw-ref-${randomUUID().slice(0, 8)}`,
      evidenceReceiptIds: [receipt.id],
      rationale: 'Verified settlement in gateway portal',
      requestedByActorId: fx.adminA.id,
    });
    expect(req.status).toBe(RefundReconciliationApprovalStatus.REQUESTED);

    await expect(
      fx.service.approveReconciliation({
        approvalId: req.id,
        approvedByActorId: fx.adminA.id,
      }),
    ).rejects.toThrow(ForbiddenException);

    const approved = await fx.service.approveReconciliation({
      approvalId: req.id,
      approvedByActorId: fx.adminB.id,
    });
    expect(approved.status).toBe(RefundReconciliationApprovalStatus.APPROVED);

    await expect(
      fx.service.executeReconciliation({
        approvalId: req.id,
        executedByActorId: fx.adminA.id,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('2 & 3. Revocation/suspension/demotion of requester (Admin A) or approver (Admin B) blocks approval & execution cleanly', async () => {
    const custRole = await fx.ledger.prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });

    // Case 2: Requester suspended before Admin B can approve
    const revReqAdmin = await fx.seedAdminUser('rev_req');
    const caseA = await fx.seedQuarantinedCase({ amount: '40.00' });
    const appA = await fx.service.requestReconciliation({
      obligationId: caseA.obligationId,
      requestedOutcome: RefundReconciliationOutcome.CONTINUE_QUARANTINE,
      evidenceType: 'MANUAL_REVIEW',
      rationale: 'Holding quarantine while awaiting bank response',
      requestedByActorId: revReqAdmin.id,
    });
    await fx.ledger.prisma.user.update({
      where: { id: revReqAdmin.id },
      data: { status: UserStatus.SUSPENDED },
    });
    await expect(
      fx.service.approveReconciliation({
        approvalId: appA.id,
        approvedByActorId: fx.adminB.id,
      }),
    ).rejects.toThrow(ForbiddenException);

    // Case 3A: Admin A demoted AFTER Admin B approved, BEFORE execution -> QUARANTINED safely
    const demotedAdminA = await fx.seedAdminUser('demote_req');
    const caseB = await fx.seedQuarantinedCase({ amount: '45.00' });
    const appB = await fx.service.requestReconciliation({
      obligationId: caseB.obligationId,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_FAILED,
      evidenceType: 'AUTHENTICATED_GATEWAY_DECLINE',
      rationale: 'Gateway decline verified post-request',
      requestedByActorId: demotedAdminA.id,
    });
    await fx.service.approveReconciliation({
      approvalId: appB.id,
      approvedByActorId: fx.adminB.id,
    });
    await fx.ledger.prisma.userRole.deleteMany({ where: { userId: demotedAdminA.id } });
    await fx.ledger.prisma.userRole.create({
      data: { userId: demotedAdminA.id, roleId: custRole.id },
    });

    const execAfterADemotion = await fx.service.executeReconciliation({
      approvalId: appB.id,
      executedByActorId: fx.adminC.id,
    });
    expect(execAfterADemotion.applied).toBe(false);
    expect(execAfterADemotion.quarantined).toBe(true);
    expect(execAfterADemotion.approval.status).toBe(RefundReconciliationApprovalStatus.QUARANTINED);

    // Case 3B: Admin B deactivated AFTER approving, BEFORE execution -> QUARANTINED safely
    const revokedApproverB = await fx.seedAdminUser('revoke_app');
    const caseC = await fx.seedQuarantinedCase({ amount: '46.00' });
    const appC = await fx.service.requestReconciliation({
      obligationId: caseC.obligationId,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_FAILED,
      evidenceType: 'AUTHENTICATED_GATEWAY_DECLINE',
      rationale: 'Approver suspended before execution window',
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({
      approvalId: appC.id,
      approvedByActorId: revokedApproverB.id,
    });
    await fx.ledger.prisma.user.update({
      where: { id: revokedApproverB.id },
      data: { status: UserStatus.SUSPENDED },
    });

    const execAfterBRevoke = await fx.service.executeReconciliation({
      approvalId: appC.id,
      executedByActorId: fx.adminC.id,
    });
    expect(execAfterBRevoke.applied).toBe(false);
    expect(execAfterBRevoke.quarantined).toBe(true);
    expect(execAfterBRevoke.approval.status).toBe(RefundReconciliationApprovalStatus.QUARANTINED);
  });

  it('4. Expired approval commits EXPIRED state, records EXPIRED event, and refuses execution', async () => {
    const c = await fx.seedQuarantinedCase({ amount: '50.00' });
    const req = await fx.service.requestReconciliation({
      obligationId: c.obligationId,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_FAILED,
      evidenceType: 'MANUAL_REVIEW',
      rationale: 'Testing wall-clock expiration window',
      ttlMs: 800,
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({
      approvalId: req.id,
      approvedByActorId: fx.adminB.id,
    });

    await new Promise((r) => setTimeout(r, 950));

    const res = await fx.service.executeReconciliation({
      approvalId: req.id,
      executedByActorId: fx.adminB.id,
    });
    expect(res.applied).toBe(false);
    expect(res.expired).toBe(true);
    expect(res.approval.status).toBe(RefundReconciliationApprovalStatus.EXPIRED);
    expect(res.approval.events.map((e) => e.eventType)).toContain(
      RefundReconciliationApprovalEventType.EXPIRED,
    );
    expect(res.attemptStatus).toBe(RefundAttemptStatus.AMBIGUOUS_OUTCOME);
  });

  it('5. Modified evidence / digest mismatch between approval and execution quarantines the approval', async () => {
    const c = await fx.seedQuarantinedCase({ amount: '62.00' });
    const receipt = await fx.seedEvidenceReceipt({
      obligationId: c.obligationId,
      attemptId: c.attemptId,
      refundId: c.refundId,
      merchantAccountId: c.merchantAccountId,
    });
    const req = await fx.service.requestReconciliation({
      obligationId: c.obligationId,
      attemptId: c.attemptId,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
      evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL',
      externalSettlementReference: `gw-dig-${randomUUID().slice(0, 8)}`,
      evidenceReceiptIds: [receipt.id],
      evidenceDigest: receipt.evidenceDigest,
      rationale: 'Digest-bound reconciliation approval',
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({
      approvalId: req.id,
      approvedByActorId: fx.adminB.id,
      expectedEvidenceDigest: receipt.evidenceDigest,
    });

    const mismatched = await fx.service.executeReconciliation({
      approvalId: req.id,
      executedByActorId: fx.adminB.id,
      expectedEvidenceDigest: 'f'.repeat(64),
    });
    expect(mismatched.applied).toBe(false);
    expect(mismatched.quarantined).toBe(true);
    expect(mismatched.approval.status).toBe(RefundReconciliationApprovalStatus.QUARANTINED);
    expect(mismatched.approval.quarantineReason).toContain('evidenceDigest');
  });

  it('13. Blocks VOID_OBLIGATION while attempts are AMBIGUOUS_OUTCOME, DISPATCHING, COMPLETED, or allocations exist', async () => {
    const cAmb = await fx.seedQuarantinedCase({ amount: '35.00' });
    const reqAmb = await fx.service.requestReconciliation({
      obligationId: cAmb.obligationId,
      requestedOutcome: RefundReconciliationOutcome.VOID_OBLIGATION,
      evidenceType: 'CUSTOMER_CANCELLED_REFUND',
      rationale: 'Attempt void while ambiguous outcome exists',
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({ approvalId: reqAmb.id, approvedByActorId: fx.adminB.id });
    await expect(
      fx.service.executeReconciliation({ approvalId: reqAmb.id, executedByActorId: fx.adminB.id }),
    ).rejects.toThrow(ConflictException);

    // Completed attempt blocked at request stage
    const cComp = await fx.seedQuarantinedCase({
      amount: '35.00',
      attemptStatus: RefundAttemptStatus.AMBIGUOUS_OUTCOME,
    });
    const receiptComp = await fx.seedEvidenceReceipt({
      obligationId: cComp.obligationId,
      attemptId: cComp.attemptId,
      refundId: cComp.refundId,
      merchantAccountId: cComp.merchantAccountId,
    });
    const okCompReq = await fx.service.requestReconciliation({
      obligationId: cComp.obligationId,
      attemptId: cComp.attemptId,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
      evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL',
      externalSettlementReference: `gw-done-${randomUUID().slice(0, 8)}`,
      evidenceReceiptIds: [receiptComp.id],
      rationale: 'Complete quarantined attempt first',
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({
      approvalId: okCompReq.id,
      approvedByActorId: fx.adminB.id,
    });
    await fx.service.executeReconciliation({
      approvalId: okCompReq.id,
      executedByActorId: fx.adminB.id,
    });
    await expect(
      fx.service.requestReconciliation({
        obligationId: cComp.obligationId,
        requestedOutcome: RefundReconciliationOutcome.VOID_OBLIGATION,
        evidenceType: 'MANUAL_REVIEW',
        rationale: 'Attempt void after fulfillment',
        requestedByActorId: fx.adminA.id,
      }),
    ).rejects.toThrow(ConflictException);

    // Reject and revoke lifecycle states block subsequent execution cleanly
    const cRev = await fx.seedQuarantinedCase({ amount: '33.00' });
    const toReject = await fx.service.requestReconciliation({
      obligationId: cRev.obligationId,
      requestedOutcome: RefundReconciliationOutcome.CONTINUE_QUARANTINE,
      evidenceType: 'MANUAL_REVIEW',
      rationale: 'Pending approval slated for rejection',
      requestedByActorId: fx.adminA.id,
    });
    const rejected = await fx.service.rejectReconciliation({
      approvalId: toReject.id,
      rejectedByActorId: fx.adminB.id,
      rejectionReason: 'Insufficient bank trace attached',
    });
    expect(rejected.status).toBe(RefundReconciliationApprovalStatus.REJECTED);

    const toRevoke = await fx.service.requestReconciliation({
      obligationId: cRev.obligationId,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_FAILED,
      evidenceType: 'AUTHENTICATED_GATEWAY_DECLINE',
      rationale: 'Will be approved then revoked before execution',
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({
      approvalId: toRevoke.id,
      approvedByActorId: fx.adminB.id,
      expectedAuthorizationRevision: 1,
    });
    const revoked = await fx.service.revokeReconciliation({
      approvalId: toRevoke.id,
      revokedByActorId: fx.adminA.id,
      revocationReason: 'Discovered pending dispute alert',
    });
    expect(revoked.status).toBe(RefundReconciliationApprovalStatus.REVOKED);
    await expect(
      fx.service.executeReconciliation({
        approvalId: toRevoke.id,
        executedByActorId: fx.adminB.id,
      }),
    ).rejects.toThrow(ConflictException);

    expect(RefundAttemptFailureClass.TRANSPORT_AMBIGUOUS).toBeDefined();
    expect(RefundEvidenceDisposition.APPLIED).toBeDefined();
    expect(RefundObligationStatus.RECONCILE_REQUIRED).toBeDefined();
  });
});
