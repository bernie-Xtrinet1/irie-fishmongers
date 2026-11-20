import { randomUUID } from 'crypto';

import { ConflictException } from '@nestjs/common';
import {
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  RefundAttemptFailureClass,
  RefundAttemptStatus,
  RefundEvidenceDisposition,
  RefundEvidenceProvenance,
  RefundExecutionChannel,
  RefundObligationStatus,
  RefundReconciliationApprovalStatus,
  RefundReconciliationOutcome,
  RefundStatus,
} from '@prisma/client';

import { RefundEvidenceRepository } from '../repositories/refund-evidence.repository';
import { computeEvidencePayloadDigest } from '../repositories/refund-locks.helper';
import { RefundEvidenceProcessorService } from '../services/refund-evidence-processor.service';
import { ProcessRefundEvidenceInput } from '../types/refund-reconciliation.types';
import {
  createDualControlTestFixture,
  DualControlTestFixture,
} from './refund-dual-control-fixture.helper';

jest.setTimeout(120_000);

describe('Dual-Control Execution Claims, Approval Event Security & Late Completion After FAILED (PG Suite)', () => {
  let fx: DualControlTestFixture;
  let evidenceProcessor: RefundEvidenceProcessorService;

  beforeAll(async () => {
    fx = await createDualControlTestFixture();
    evidenceProcessor = new RefundEvidenceProcessorService(
      new RefundEvidenceRepository(fx.ledger.prisma),
      {
        trustedWebhookAdapters: [PaymentProviderName.CASH_ON_DELIVERY, PaymentProviderName.WIPAY],
        trustedStatusPollAdapters: [PaymentProviderName.CASH_ON_DELIVERY, PaymentProviderName.WIPAY],
      },
    );
  });

  afterAll(async () => {
    await fx?.destroy();
  });

  function buildWebhookInput(params: {
    attemptId: string;
    obligationId: string;
    merchantAccountId: string;
    amount: string;
    outcome: 'COMPLETED' | 'PENDING' | 'FAILED';
    providerRefundReference?: string | null;
    eventId?: string;
  }): ProcessRefundEvidenceInput {
    const rawPayload = { attemptId: params.attemptId, outcome: params.outcome, ref: params.providerRefundReference ?? null, nonce: params.eventId ?? 'n1' };
    return {
      attemptId: params.attemptId,
      obligationId: params.obligationId,
      provider: PaymentProviderName.CASH_ON_DELIVERY,
      merchantAccountId: params.merchantAccountId,
      providerRefundReference: params.providerRefundReference ?? null,
      amount: params.amount,
      currency: 'JMD',
      outcome: params.outcome,
      httpStatusCode: 200,
      evidence: {
        provenance: RefundEvidenceProvenance.AUTHENTICATED_WEBHOOK,
        eventId: params.eventId ?? `wh-${randomUUID()}`,
        rawPayload,
        evidenceDigest: computeEvidencePayloadDigest(rawPayload),
        eventTimestamp: new Date(),
        signatureValid: true,
        verification: {
          verifiedByAdapter: PaymentProviderName.CASH_ON_DELIVERY,
          adapterVerificationToken: `tok-${randomUUID().slice(0, 8)}`,
          verifiedAt: new Date(),
        },
      },
    };
  }

  it('2A. Rejects APPROVED-only financial writes, mismatched claims/revisions, arbitrary events, and rolls back failed execution', async () => {
    const c = await fx.seedQuarantinedCase({ amount: '55.00' });
    const receipt = await fx.seedEvidenceReceipt({
      obligationId: c.obligationId, attemptId: c.attemptId, refundId: c.refundId, merchantAccountId: c.merchantAccountId,
    });
    const extRef = `gw-claim-${randomUUID().slice(0, 8)}`;
    const req = await fx.service.requestReconciliation({
      obligationId: c.obligationId,
      attemptId: c.attemptId,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
      evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL',
      externalSettlementReference: extRef,
      evidenceReceiptIds: [receipt.id],
      rationale: 'Execution claim and DB trigger isolation check',
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({ approvalId: req.id, approvedByActorId: fx.adminB.id });

    // APPROVED row alone CANNOT authorize attempt or obligation mutations in DB
    await expect(
      fx.ledger.prisma.$executeRawUnsafe(`
        UPDATE "refund_provider_attempts"
        SET "status"='COMPLETED',"resolvedByProvenance"='DUAL_CONTROL_ADMIN_RECONCILIATION',"reconciliationApprovalId"='${req.id}'
        WHERE "id"='${c.attemptId}'
      `),
    ).rejects.toThrow();

    await expect(
      fx.ledger.prisma.$executeRawUnsafe(`
        INSERT INTO "refund_provider_attempts"
          ("id","refundId","obligationId","paymentId","provider","merchantAccountId","attemptSequence","providerIdempotencyKey","amount","currency","executionChannel","status","reconciliationApprovalId","requestDigest")
        VALUES ('${randomUUID()}','${c.refundId}','${c.obligationId}','${c.paymentId}','CASH_ON_DELIVERY','${c.merchantAccountId}',99,'k-${randomUUID()}',55.00,'JMD','MANUAL_PORTAL_SETTLEMENT','COMPLETED','${req.id}','${'a'.repeat(64)}')
      `),
    ).rejects.toThrow();

    // Mismatched authorizationRevision or missing executionClaimToken or arbitrary approval event insert rejected by DB
    await expect(
      fx.ledger.prisma.$executeRawUnsafe(`
        UPDATE "refund_reconciliation_approvals"
        SET "status"='EXECUTING',"executedByActorId"='${fx.adminB.id}',"executingAt"=(clock_timestamp() AT TIME ZONE 'UTC'),"executionClaimToken"='t-1',"authorizationRevision"=99
        WHERE "id"='${req.id}'
      `),
    ).rejects.toThrow();
    await expect(
      fx.ledger.prisma.$executeRawUnsafe(`
        UPDATE "refund_reconciliation_approvals"
        SET "status"='EXECUTING',"executedByActorId"='${fx.adminB.id}',"executingAt"=(clock_timestamp() AT TIME ZONE 'UTC'),"authorizationRevision"=3
        WHERE "id"='${req.id}'
      `),
    ).rejects.toThrow();
    await expect(
      fx.ledger.prisma.$executeRawUnsafe(`
        INSERT INTO "refund_reconciliation_approval_events"
          ("id","approvalId","obligationId","eventSequence","eventType","resultingStatus","authorizationRevision","actorId","evidenceDigest")
        VALUES ('${randomUUID()}','${req.id}','${c.obligationId}',3,'APPLIED','APPLIED',2,'${fx.adminB.id}','${receipt.evidenceDigest}')
      `),
    ).rejects.toThrow();

    // Failure right before commit after claim, attempt/refund/obligation writes rolls back BOTH financial & audit state
    const origTx = fx.ledger.prisma.$transaction.bind(fx.ledger.prisma);
    const spy = jest.spyOn(fx.ledger.prisma, '$transaction').mockImplementationOnce(
      async (
        cb: (tx: Prisma.TransactionClient) => Promise<unknown>,
        opts?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
      ) =>
        origTx(async (tx: Prisma.TransactionClient) => {
          const proxyTx = new Proxy(tx, {
            get(target, prop, receiver) {
              if (prop === 'paymentOutbox') {
                return { create: () => Promise.reject(new Error('INJECTED_MID_EXECUTION_FAILURE')) };
              }
              return Reflect.get(target, prop, receiver) as unknown;
            },
          });
          return cb(proxyTx);
        }, opts),
    );
    await expect(
      fx.service.executeReconciliation({ approvalId: req.id, executedByActorId: fx.adminB.id }),
    ).rejects.toThrow('INJECTED_MID_EXECUTION_FAILURE');
    spy.mockRestore();

    const postFailApproval = await fx.service.inspectApprovalById(req.id);
    const postFailAttempt = await fx.ledger.prisma.refundProviderAttempt.findUniqueOrThrow({ where: { id: c.attemptId } });
    expect(postFailApproval.status).toBe(RefundReconciliationApprovalStatus.APPROVED);
    expect(postFailApproval.authorizationRevision).toBe(2);
    expect(postFailApproval.events).toHaveLength(2);
    expect(postFailAttempt.status).toBe(RefundAttemptStatus.AMBIGUOUS_OUTCOME);
  });

  it('3A. Handles late VERIFIED_COMPLETED after terminal FAILED with NO replacement and blocks double-counting', async () => {
    const providerSpy = jest.fn().mockResolvedValue({ providerReference: 'gw-init-declined', status: 'FAILED' });
    const { payment } = await fx.ledger.seedOrderWithPayment({ amount: '100.00' });
    const refundSvc = fx.ledger.createPaymentsService({ refundPayment: providerSpy });
    const r1Res = await refundSvc.refundByPaymentId(payment.id, 100, 'Declined initial refund', randomUUID());
    const r1 = await fx.ledger.prisma.refund.findUniqueOrThrow({ where: { id: r1Res.id } });
    const a1 = await fx.ledger.prisma.refundProviderAttempt.findFirstOrThrow({ where: { refundId: r1.id } });
    expect(a1.status).toBe(RefundAttemptStatus.FAILED);
    providerSpy.mockClear();

    // Late COMPLETED evidence on failed A1 quarantines obligation and blocks replacement dispatch
    const lateExtRes = await evidenceProcessor.processEvidence(
      buildWebhookInput({
        attemptId: a1.id, obligationId: r1.obligationId!, merchantAccountId: a1.merchantAccountId,
        amount: '100.00', outcome: 'COMPLETED', providerRefundReference: 'late-ref-no-repl-1',
      }),
    );
    expect(lateExtRes.disposition).toBe(RefundEvidenceDisposition.CONFLICT_REJECTED);
    expect(lateExtRes.resultingAttemptStatus).toBe(RefundAttemptStatus.FAILED);
    expect(lateExtRes.resultingObligationStatus).toBe(RefundObligationStatus.RECONCILE_REQUIRED);
    await expect(
      fx.ledger.attemptsRepo.prepareAndClaimAttempt({
        paymentId: payment.id, obligationId: r1.obligationId!, amount: '100.00',
        reason: 'Replacement must block while conflict unresolved', allowReplacementRetry: true,
      }),
    ).rejects.toThrow(ConflictException);
    expect(providerSpy).not.toHaveBeenCalled();

    // Dual-control VERIFIED_COMPLETED settles via #61-safe superseding R2 + MANUAL_PORTAL_SETTLEMENT A2 (0 provider calls)
    const portalReceipt = await fx.seedEvidenceReceipt({ obligationId: r1.obligationId!, merchantAccountId: a1.merchantAccountId });
    const remRef = `portal-3a-${randomUUID().slice(0, 8)}`;
    const req = await fx.service.requestReconciliation({
      obligationId: r1.obligationId!,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
      evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL',
      externalSettlementReference: remRef,
      evidenceReceiptIds: [portalReceipt.id],
      rationale: 'Late portal remittance verified after FAILED initial attempt',
      requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({ approvalId: req.id, approvedByActorId: fx.adminB.id });
    const execRes = await fx.service.executeReconciliation({ approvalId: req.id, executedByActorId: fx.adminC.id });

    expect(providerSpy).not.toHaveBeenCalled();
    expect(execRes.applied).toBe(true);
    expect(execRes.obligationStatus).toBe(RefundObligationStatus.FULFILLED);
    expect(execRes.refundStatus).toBe(RefundStatus.COMPLETED);
    expect((await fx.ledger.prisma.refund.findUniqueOrThrow({ where: { id: r1.id } })).status).toBe(RefundStatus.FAILED);
    expect((await fx.ledger.prisma.refundProviderAttempt.findUniqueOrThrow({ where: { id: a1.id } })).status).toBe(RefundAttemptStatus.FAILED);

    const a2 = await fx.ledger.prisma.refundProviderAttempt.findFirstOrThrow({
      where: { obligationId: r1.obligationId!, executionChannel: RefundExecutionChannel.MANUAL_PORTAL_SETTLEMENT },
    });
    expect(a2.status).toBe(RefundAttemptStatus.COMPLETED);
    expect(a2.providerRefundReference).toBe(remRef);

    // Repeated / concurrent processing cannot count the same remittance twice
    const p2 = await fx.ledger.seedOrderWithPayment({ amount: '100.00' });
    const prep2 = await fx.ledger.attemptsRepo.prepareAndClaimAttempt({ paymentId: p2.payment.id, amount: '100.00', reason: 'Quarantine check', idempotencyKey: randomUUID() });
    await fx.ledger.attemptsRepo.quarantineAttemptOutcome({ attemptId: prep2.attempt!.id, paymentId: p2.payment.id, failureClass: RefundAttemptFailureClass.TRANSPORT_AMBIGUOUS, errorMessage: 'timeout' });
    await expect(
      fx.service.requestReconciliation({
        obligationId: prep2.obligation!.id,
        requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
        evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL',
        externalSettlementReference: remRef,
        rationale: 'Duplicate remittance reuse check',
        requestedByActorId: fx.adminA.id,
      }),
    ).rejects.toThrow(ConflictException);
    expect((await fx.ledger.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(PaymentStatus.REFUNDED);
  });

  it('3B. Handles late VERIFIED_COMPLETED with IN-FLIGHT replacement cleanly without duplicating remittance or calls', async () => {
    const { payment } = await fx.ledger.seedOrderWithPayment({ amount: '100.00' });
    const refundSvc = fx.ledger.createPaymentsService({
      refundPayment: jest.fn()
        .mockResolvedValueOnce({ providerReference: 'gw-dec-3b', status: 'FAILED' })
        .mockResolvedValueOnce({ providerReference: 'gw-pend-3b', status: 'PENDING' }),
    });
    const idemKey = randomUUID();
    const failedRes = await refundSvc.refundByPaymentId(payment.id, 100, 'Initial fail before retry', idemKey);
    const r1 = await fx.ledger.prisma.refund.findUniqueOrThrow({ where: { id: failedRes.id } });
    const a1 = await fx.ledger.prisma.refundProviderAttempt.findFirstOrThrow({ where: { refundId: r1.id } });

    // Replacement R2/A2 enters PROVIDER_PENDING
    const prep2 = await fx.ledger.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id, obligationId: r1.obligationId!, amount: '100.00', reason: 'Retry attempt', allowReplacementRetry: true,
    });
    const a2 = prep2.attempt!;
    await fx.ledger.attemptsRepo.recordSyncOutcomeAndOutbox({
      attemptId: a2.id, paymentId: payment.id, providerOutcome: 'PENDING', providerRefundReference: 'gw-pend-3b', expectedAmount: '100.00',
    });

    // Late COMPLETED evidence on original FAILED A1 conflicts -> quarantines obligation, leaves A1 FAILED and A2 PROVIDER_PENDING
    const conflictRes = await evidenceProcessor.processEvidence(
      buildWebhookInput({
        attemptId: a1.id, obligationId: r1.obligationId!, merchantAccountId: a1.merchantAccountId,
        amount: '100.00', outcome: 'COMPLETED', providerRefundReference: 'late-3b-conf',
      }),
    );
    expect(conflictRes.disposition).toBe(RefundEvidenceDisposition.CONFLICT_REJECTED);
    expect(conflictRes.resultingObligationStatus).toBe(RefundObligationStatus.RECONCILE_REQUIRED);
    expect((await fx.ledger.prisma.refund.findUniqueOrThrow({ where: { id: r1.id } })).status).toBe(RefundStatus.FAILED);
    expect((await fx.ledger.prisma.refundProviderAttempt.findUniqueOrThrow({ where: { id: a2.id } })).status).toBe(RefundAttemptStatus.PROVIDER_PENDING);

    // Targeting stale A1 rejected; targeting active A2 via dual-control VERIFIED_COMPLETED settles once with zero new provider calls
    await expect(
      fx.service.requestReconciliation({
        obligationId: r1.obligationId!, attemptId: a1.id,
        requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
        evidenceType: 'MANUAL_REVIEW', externalSettlementReference: 'gw-pend-3b',
        rationale: 'Stale A1 rejected when A2 exists', requestedByActorId: fx.adminA.id,
      }),
    ).rejects.toThrow(ConflictException);

    const req = await fx.service.requestReconciliation({
      obligationId: r1.obligationId!, attemptId: a2.id,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
      evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL', externalSettlementReference: 'gw-pend-3b',
      rationale: 'Verified settlement of in-flight replacement A2', requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({ approvalId: req.id, approvedByActorId: fx.adminB.id });
    const execRes = await fx.service.executeReconciliation({ approvalId: req.id, executedByActorId: fx.adminC.id });

    expect(execRes.applied).toBe(true);
    expect(execRes.attemptStatus).toBe(RefundAttemptStatus.COMPLETED);
    expect(execRes.obligationStatus).toBe(RefundObligationStatus.FULFILLED);
    expect((await fx.ledger.prisma.refundProviderAttempt.findUniqueOrThrow({ where: { id: a1.id } })).status).toBe(RefundAttemptStatus.FAILED);
    expect((await fx.ledger.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(PaymentStatus.REFUNDED);
  });

  it('3C. Rejects double counting when replacement ALREADY settled COMPLETED under concurrent/repeated late events', async () => {
    const { payment } = await fx.ledger.seedOrderWithPayment({ amount: '100.00' });
    const refundSvc = fx.ledger.createPaymentsService({
      refundPayment: jest.fn()
        .mockResolvedValueOnce({ providerReference: 'gw-dec-3c', status: 'FAILED' })
        .mockResolvedValueOnce({ providerReference: 'gw-ok-3c', status: 'COMPLETED' }),
    });
    const failedRes = await refundSvc.refundByPaymentId(payment.id, 100, 'Declined then settled replacement', randomUUID());
    const r1 = await fx.ledger.prisma.refund.findUniqueOrThrow({ where: { id: failedRes.id } });
    const a1 = await fx.ledger.prisma.refundProviderAttempt.findFirstOrThrow({ where: { refundId: r1.id } });

    const prep2 = await fx.ledger.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id, obligationId: r1.obligationId!, amount: '100.00', reason: 'Settled retry', allowReplacementRetry: true,
    });
    await fx.ledger.attemptsRepo.recordSyncOutcomeAndOutbox({
      attemptId: prep2.attempt!.id, paymentId: payment.id, providerOutcome: 'COMPLETED', providerRefundReference: 'gw-ok-3c', expectedAmount: '100.00',
    });

    // Concurrent + repeated late COMPLETED evidence on FAILED A1 or COMPLETED A2 cannot mutate FULFILLED / REFUNDED
    const concurrentEvents = await Promise.all([
      evidenceProcessor.processEvidence(buildWebhookInput({ attemptId: a1.id, obligationId: r1.obligationId!, merchantAccountId: a1.merchantAccountId, amount: '100.00', outcome: 'COMPLETED', providerRefundReference: 'late-3c-1' })),
      evidenceProcessor.processEvidence(buildWebhookInput({ attemptId: a1.id, obligationId: r1.obligationId!, merchantAccountId: a1.merchantAccountId, amount: '100.00', outcome: 'COMPLETED', providerRefundReference: 'late-3c-2' })),
      evidenceProcessor.processEvidence(buildWebhookInput({ attemptId: prep2.attempt!.id, obligationId: r1.obligationId!, merchantAccountId: a1.merchantAccountId, amount: '100.00', outcome: 'COMPLETED', providerRefundReference: 'gw-ok-3c' })),
    ]);

    expect(concurrentEvents[0].disposition).toBe(RefundEvidenceDisposition.CONFLICT_REJECTED);
    expect(concurrentEvents[1].disposition).toBe(RefundEvidenceDisposition.CONFLICT_REJECTED);
    expect(concurrentEvents[2].disposition).toBe(RefundEvidenceDisposition.DUPLICATE_IGNORED);
    expect((await fx.ledger.prisma.refund.count({ where: { paymentId: payment.id, status: RefundStatus.COMPLETED } }))).toBe(1);
    expect((await fx.ledger.prisma.refundObligation.findUniqueOrThrow({ where: { id: r1.obligationId! } })).status).toBe(RefundObligationStatus.FULFILLED);
    expect((await fx.ledger.prisma.refund.findUniqueOrThrow({ where: { id: r1.id } })).status).toBe(RefundStatus.FAILED);
    expect((await fx.ledger.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(PaymentStatus.REFUNDED);

    await expect(
      fx.service.requestReconciliation({
        obligationId: r1.obligationId!,
        requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
        evidenceType: 'MANUAL_REVIEW',
        externalSettlementReference: 'gw-ok-3c',
        rationale: 'Double completion on FULFILLED obligation blocked',
        requestedByActorId: fx.adminA.id,
      }),
    ).rejects.toThrow(ConflictException);
  });
});
