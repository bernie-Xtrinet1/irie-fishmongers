import { randomUUID } from 'crypto';

import { ConflictException } from '@nestjs/common';
import {
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  RefundAttemptStatus,
  RefundEvidenceDisposition,
  RefundEvidenceProvenance,
  RefundExecutionChannel,
  RefundObligationStatus,
  RefundReconciliationApprovalEventType,
  RefundReconciliationApprovalStatus,
  RefundReconciliationOutcome,
  RefundStatus,
} from '@prisma/client';

import { RefundEvidenceRepository } from '../repositories/refund-evidence.repository';
import { sha256Hex } from '../repositories/refund-locks.helper';
import {
  createDualControlTestFixture,
  DualControlTestFixture,
} from './refund-dual-control-fixture.helper';

jest.setTimeout(120_000);

describe('Dual-Control Refund Reconciliation Execution, Concurrency & Recovery (PG Suite)', () => {
  let fx: DualControlTestFixture;

  beforeAll(async () => {
    fx = await createDualControlTestFixture();
  });

  afterAll(async () => {
    await fx?.destroy();
  });

  it('6 & 7. Enforces single execution under concurrency and rejects repeated execution', async () => {
    const c = await fx.seedQuarantinedCase({ amount: '95.00' });
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
      externalSettlementReference: `gw-conc-${randomUUID().slice(0, 8)}`,
      evidenceReceiptIds: [receipt.id],
      rationale: 'Concurrent dual-control execution safety test',
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({
      approvalId: req.id,
      approvedByActorId: fx.adminB.id,
    });

    const settled = await Promise.allSettled([
      fx.service.executeReconciliation({ approvalId: req.id, executedByActorId: fx.adminB.id }),
      fx.service.executeReconciliation({ approvalId: req.id, executedByActorId: fx.adminC.id }),
      fx.service.executeReconciliation({ approvalId: req.id, executedByActorId: fx.adminB.id }),
      fx.service.executeReconciliation({ approvalId: req.id, executedByActorId: fx.adminC.id }),
    ]);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(3);

    const events = await fx.ledger.prisma.refundReconciliationApprovalEvent.findMany({
      where: { approvalId: req.id },
      orderBy: { eventSequence: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual([
      RefundReconciliationApprovalEventType.REQUESTED,
      RefundReconciliationApprovalEventType.APPROVED,
      RefundReconciliationApprovalEventType.EXECUTION_CLAIMED,
      RefundReconciliationApprovalEventType.APPLIED,
    ]);

    // Scenario 7: Repeated execution is blocked cleanly
    await expect(
      fx.service.executeReconciliation({
        approvalId: req.id,
        executedByActorId: fx.adminB.id,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('8 & 9. Rejects wrong obligation/attempt/merchant/parent-ref/unauthenticated evidence', async () => {
    const c1 = await fx.seedQuarantinedCase({ amount: '70.00' });
    const c2 = await fx.seedQuarantinedCase({ amount: '70.00' });
    const wrongMerchantReceipt = await fx.seedEvidenceReceipt({
      obligationId: c1.obligationId,
      merchantAccountId: 'other-merchant-acct',
    });
    const sigRejectedReceipt = await fx.seedEvidenceReceipt({
      obligationId: c1.obligationId,
      merchantAccountId: c1.merchantAccountId,
      disposition: RefundEvidenceDisposition.SIGNATURE_REJECTED,
      provenance: RefundEvidenceProvenance.AUTHENTICATED_WEBHOOK,
      signatureValid: false,
    });

    // Wrong attempt for obligation
    await expect(
      fx.service.requestReconciliation({
        obligationId: c1.obligationId,
        attemptId: c2.attemptId,
        requestedOutcome: RefundReconciliationOutcome.VERIFIED_FAILED,
        evidenceType: 'MANUAL_REVIEW',
        rationale: 'Attempt belongs to another obligation',
        requestedByActorId: fx.adminA.id,
      }),
    ).rejects.toThrow(ConflictException);

    // Merchant mismatch receipt
    await expect(
      fx.service.requestReconciliation({
        obligationId: c1.obligationId,
        requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
        evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL',
        externalSettlementReference: `gw-ok-${randomUUID().slice(0, 8)}`,
        evidenceReceiptIds: [wrongMerchantReceipt.id],
        rationale: 'Merchant account mismatch check',
        requestedByActorId: fx.adminA.id,
      }),
    ).rejects.toThrow(ConflictException);

    // Unauthenticated SIGNATURE_REJECTED receipt cannot authorize VERIFIED_COMPLETED
    await expect(
      fx.service.requestReconciliation({
        obligationId: c1.obligationId,
        requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
        evidenceType: 'PROVIDER_WEBHOOK',
        externalSettlementReference: `gw-sig-${randomUUID().slice(0, 8)}`,
        evidenceReceiptIds: [sigRejectedReceipt.id],
        rationale: 'Unsigned webhook cannot verify completion',
        requestedByActorId: fx.adminA.id,
      }),
    ).rejects.toThrow(ConflictException);

    // Parent charge providerReference echoed as refund externalSettlementReference rejected
    await expect(
      fx.service.requestReconciliation({
        obligationId: c1.obligationId,
        requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
        evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL',
        externalSettlementReference: c1.providerReference,
        rationale: 'Cannot echo parent payment charge ref',
        requestedByActorId: fx.adminA.id,
      }),
    ).rejects.toThrow(ConflictException);

    // SQL tamper of bound amount on approved approval blocked directly by M70 trigger,
    // and mismatched expectedEvidenceDigest quarantines at execution without financial mutation
    const reqGood = await fx.service.requestReconciliation({
      obligationId: c1.obligationId,
      attemptId: c1.attemptId,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_FAILED,
      evidenceType: 'AUTHENTICATED_GATEWAY_DECLINE',
      rationale: 'Bound field immutability and digest quarantine check',
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({
      approvalId: reqGood.id,
      approvedByActorId: fx.adminB.id,
    });
    await expect(
      fx.ledger.prisma.$executeRawUnsafe(
        `UPDATE "refund_reconciliation_approvals" SET "amount" = 999.00 WHERE "id" = '${reqGood.id}'`,
      ),
    ).rejects.toThrow();

    const tamperedExec = await fx.service.executeReconciliation({
      approvalId: reqGood.id,
      executedByActorId: fx.adminB.id,
      expectedEvidenceDigest: 'd'.repeat(64),
    });
    expect(tamperedExec.applied).toBe(false);
    expect(tamperedExec.quarantined).toBe(true);
    expect(tamperedExec.approval.status).toBe(RefundReconciliationApprovalStatus.QUARANTINED);
  });

  it('10 & 11. Quarantines execution when contradictory evidence arrives or attempt already completed', async () => {
    // 10. Late contradictory evidence receipt after approval
    const c10 = await fx.seedQuarantinedCase({ amount: '60.00' });
    const req10 = await fx.service.requestReconciliation({
      obligationId: c10.obligationId,
      attemptId: c10.attemptId,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_FAILED,
      evidenceType: 'AUTHENTICATED_GATEWAY_DECLINE',
      rationale: 'Decline before late webhook contradiction',
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({ approvalId: req10.id, approvedByActorId: fx.adminB.id });
    await fx.seedEvidenceReceipt({
      obligationId: c10.obligationId,
      attemptId: c10.attemptId,
      merchantAccountId: c10.merchantAccountId,
      disposition: RefundEvidenceDisposition.CONFLICT_REJECTED,
      receivedAt: new Date(Date.now() + 2000),
    });

    const exec10 = await fx.service.executeReconciliation({
      approvalId: req10.id,
      executedByActorId: fx.adminC.id,
    });
    expect(exec10.applied).toBe(false);
    expect(exec10.quarantined).toBe(true);
    expect(exec10.outboxEventId).toBeTruthy();

    // 11. Attempt concurrently completed while approval was waiting for execution
    const c11 = await fx.seedQuarantinedCase({ amount: '60.00' });
    const req11 = await fx.service.requestReconciliation({
      obligationId: c11.obligationId,
      attemptId: c11.attemptId,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_FAILED,
      evidenceType: 'AUTHENTICATED_GATEWAY_DECLINE',
      rationale: 'Gateway settled via poll before manual fail ran',
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({ approvalId: req11.id, approvedByActorId: fx.adminB.id });
    const evidenceRepo = new RefundEvidenceRepository(fx.ledger.prisma);
    const pollPayload = { status: 'COMPLETED', tx: randomUUID() };
    const pollDigest = sha256Hex(pollPayload);
    await evidenceRepo.applyVerifiedEvidence({
      attemptId: c11.attemptId, obligationId: c11.obligationId,
      provider: PaymentProviderName.CASH_ON_DELIVERY, merchantAccountId: c11.merchantAccountId,
      amount: '60.00', currency: 'JMD', outcome: 'COMPLETED',
      providerRefundReference: `poll-settle-${randomUUID().slice(0, 8)}`,
      evidence: {
        provenance: RefundEvidenceProvenance.VERIFIED_STATUS_POLL,
        eventId: `poll-evt-${randomUUID()}`, rawPayload: pollPayload,
        evidenceDigest: pollDigest, eventTimestamp: new Date(), signatureValid: true,
      },
    }, pollDigest);

    const exec11 = await fx.service.executeReconciliation({ approvalId: req11.id, executedByActorId: fx.adminC.id });
    expect(exec11.applied).toBe(false);
    expect(exec11.quarantined).toBe(true);
    expect(exec11.attemptStatus).toBe(RefundAttemptStatus.COMPLETED);
  });

  it('12 & CONTINUE_QUARANTINE / VERIFIED_FAILED / MANUAL_PORTAL_SETTLEMENT transitions', async () => {
    const c = await fx.seedQuarantinedCase({ amount: '85.00' });
    const reqHold = await fx.service.requestReconciliation({
      obligationId: c.obligationId, attemptId: c.attemptId,
      requestedOutcome: RefundReconciliationOutcome.CONTINUE_QUARANTINE,
      evidenceType: 'BANK_TRACE_PENDING', rationale: 'Awaiting acquiring bank settlement trace',
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({ approvalId: reqHold.id, approvedByActorId: fx.adminB.id });
    const resHold = await fx.service.executeReconciliation({ approvalId: reqHold.id, executedByActorId: fx.adminB.id });
    expect(resHold.applied).toBe(true);
    expect(resHold.attemptStatus).toBe(RefundAttemptStatus.AMBIGUOUS_OUTCOME);
    expect(resHold.obligationStatus).toBe(RefundObligationStatus.RECONCILE_REQUIRED);

    const blockedPrep = await fx.ledger.attemptsRepo.prepareAndClaimAttempt({
      paymentId: c.paymentId, amount: '85.00', reason: 'Blocked while quarantined', idempotencyKey: randomUUID(),
    });
    expect(blockedPrep.action).toBe('EXCEEDS_BALANCE');
    const sameObligationPrep = await fx.ledger.attemptsRepo.prepareAndClaimAttempt({
      paymentId: c.paymentId, obligationId: c.obligationId, amount: '85.00',
      reason: 'Same obligation stays quarantined', allowReplacementRetry: true,
    });
    expect(sameObligationPrep.action).toBe('RETURN_EXISTING');
    expect(sameObligationPrep.attempt?.id).toBe(c.attemptId);

    const reqFail = await fx.service.requestReconciliation({
      obligationId: c.obligationId, attemptId: c.attemptId,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_FAILED,
      evidenceType: 'BANK_TRACE_NO_REMITTANCE', rationale: 'Acquiring bank confirmed no remittance occurred',
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({ approvalId: reqFail.id, approvedByActorId: fx.adminB.id });
    const resFail = await fx.service.executeReconciliation({ approvalId: reqFail.id, executedByActorId: fx.adminB.id });
    expect(resFail.applied).toBe(true);
    expect(resFail.attemptStatus).toBe(RefundAttemptStatus.FAILED);
    expect(resFail.refundStatus).toBe(RefundStatus.FAILED);
    expect(resFail.obligationStatus).toBe(RefundObligationStatus.OPEN);

    const portalReceipt = await fx.seedEvidenceReceipt({ obligationId: c.obligationId, merchantAccountId: c.merchantAccountId });
    const portalExtRef = `portal-settle-${randomUUID().slice(0, 8)}`;
    const reqManual = await fx.service.requestReconciliation({
      obligationId: c.obligationId, requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
      evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL', externalSettlementReference: portalExtRef,
      evidenceReceiptIds: [portalReceipt.id], rationale: 'Customer refunded directly in merchant settlement portal',
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({ approvalId: reqManual.id, approvedByActorId: fx.adminB.id });
    const resManual = await fx.service.executeReconciliation({
      approvalId: reqManual.id,
      executedByActorId: fx.adminC.id,
    });
    expect(resManual.applied).toBe(true);
    expect(resManual.obligationStatus).toBe(RefundObligationStatus.FULFILLED);
    expect(resManual.refundStatus).toBe(RefundStatus.COMPLETED);

    const payment = await fx.ledger.prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } });
    expect(payment.status).toBe(PaymentStatus.REFUNDED);
    const failedRefund = await fx.ledger.prisma.refund.findUniqueOrThrow({ where: { id: c.refundId } });
    expect(failedRefund.status).toBe(RefundStatus.FAILED);

    const manualAttempt = await fx.ledger.prisma.refundProviderAttempt.findFirstOrThrow({
      where: { obligationId: c.obligationId, executionChannel: RefundExecutionChannel.MANUAL_PORTAL_SETTLEMENT },
    });
    expect(manualAttempt.status).toBe(RefundAttemptStatus.COMPLETED);
    expect(manualAttempt.providerRefundReference).toBe(portalExtRef);
  });

  it('14. Preserves APPROVED state on TX crash before commit and prevents duplicate side effects after commit', async () => {
    const c = await fx.seedQuarantinedCase({ amount: '75.00' });
    const req = await fx.service.requestReconciliation({
      obligationId: c.obligationId,
      attemptId: c.attemptId,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_FAILED,
      evidenceType: 'BANK_TRACE_NO_REMITTANCE',
      rationale: 'Simulated crash before commit recovery test',
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({ approvalId: req.id, approvedByActorId: fx.adminB.id });

    const origTx = fx.ledger.prisma.$transaction.bind(fx.ledger.prisma);
    const spy = jest.spyOn(fx.ledger.prisma, '$transaction').mockImplementationOnce(async (_fn) => {
      return origTx(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRawUnsafe(
          `UPDATE "refund_reconciliation_approvals" SET "status" = 'EXECUTING', "executedByActorId" = '${fx.adminB.id}', "executingAt" = (clock_timestamp() AT TIME ZONE 'UTC'), "executionClaimToken" = 'crash-token', "authorizationRevision" = 3 WHERE "id" = '${req.id}'`,
        );
        throw new Error('SIMULATED_PROCESS_CRASH_BEFORE_COMMIT');
      });
    });

    await expect(
      fx.service.executeReconciliation({ approvalId: req.id, executedByActorId: fx.adminB.id }),
    ).rejects.toThrow('SIMULATED_PROCESS_CRASH_BEFORE_COMMIT');
    spy.mockRestore();

    const postCrash = await fx.service.inspectApprovalById(req.id);
    expect(postCrash.status).toBe(RefundReconciliationApprovalStatus.APPROVED);
    expect(postCrash.authorizationRevision).toBe(2);

    const recovered = await fx.service.executeReconciliation({ approvalId: req.id, executedByActorId: fx.adminB.id });
    expect(recovered.applied).toBe(true);
    await expect(
      fx.service.executeReconciliation({ approvalId: req.id, executedByActorId: fx.adminB.id }),
    ).rejects.toThrow(ConflictException);
  });
});
