import { randomUUID } from 'crypto';

import {
  PaymentProviderName,
  PaymentStatus,
  RefundAttemptEventType,
  RefundAttemptFailureClass,
  RefundAttemptStatus,
  RefundEvidenceDisposition,
  RefundObligationStatus,
  RefundStatus,
} from '@prisma/client';

import {
  createRefundRecoveryHarness,
  RefundRecoveryHarness,
} from './refund-recovery-fixture.helper';

jest.setTimeout(120_000);

describe('Refund Evidence Processor & Reconciliation Contracts (PostgreSQL Integration)', () => {
  let harness: RefundRecoveryHarness;

  beforeAll(async () => {
    harness = await createRefundRecoveryHarness();
  });

  afterAll(async () => {
    await harness?.destroy();
  });

  it('5. Rejects unauthenticated or untrusted evidence fail-closed with SIGNATURE_REJECTED receipt and zero mutation', async () => {
    const { payment } = await harness.seedOrderWithPayment({ amount: '100.00' });
    const prep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount: '100.00',
      reason: 'Spoofed webhook test',
      idempotencyKey: randomUUID(),
    });
    const attemptId = prep.attempt!.id;

    const fakeSigResult = await harness.defaultEvidenceProcessor.processEvidence(
      harness.buildWebhookEvidenceInput({
        attemptId,
        obligationId: prep.obligation!.id,
        providerRefundReference: 'cod-refund-spoof-5',
        amount: '100.00',
        outcome: 'COMPLETED',
        signatureValid: false,
      }),
    );

    expect(fakeSigResult.applied).toBe(false);
    expect(fakeSigResult.disposition).toBe(RefundEvidenceDisposition.SIGNATURE_REJECTED);
    expect(fakeSigResult.quarantined).toBe(false);

    const untrustedAdapterResult = await harness.defaultEvidenceProcessor.processEvidence(
      harness.buildWebhookEvidenceInput({
        attemptId,
        obligationId: prep.obligation!.id,
        providerRefundReference: 'cod-refund-untrusted-5',
        amount: '100.00',
        outcome: 'COMPLETED',
        signatureValid: true,
        verifiedByAdapter: 'UNKNOWN_ADAPTER',
      }),
    );
    expect(untrustedAdapterResult.disposition).toBe(RefundEvidenceDisposition.SIGNATURE_REJECTED);

    const attempt = await harness.prisma.refundProviderAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    expect(attempt.status).toBe(RefundAttemptStatus.DISPATCHING);
    const receipt = await harness.prisma.refundEvidenceReceipt.findUniqueOrThrow({
      where: { id: fakeSigResult.receiptId },
    });
    expect(receipt.disposition).toBe(RefundEvidenceDisposition.SIGNATURE_REJECTED);
  });

  it('6. Preserves terminal FAILED on contradictory COMPLETED webhook and escalates obligation to RECONCILE_REQUIRED', async () => {
    const { payment } = await harness.seedOrderWithPayment({
      amount: '80.00',
      providerReference: 'cod-parent-6',
    });
    const prep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount: '80.00',
      reason: 'Failed then late completed contradiction',
      idempotencyKey: randomUUID(),
    });
    await harness.attemptsRepo.recordSyncOutcomeAndOutbox({
      paymentId: payment.id,
      attemptId: prep.attempt!.id,
      expectedAmount: '80.00',
      providerOutcome: 'FAILED',
      failureClass: RefundAttemptFailureClass.PROVIDER_DEFINITIVE_DECLINE,
      retryEligible: true,
    });

    const res = await harness.evidenceProcessor.processEvidence(
      harness.buildWebhookEvidenceInput({
        attemptId: prep.attempt!.id,
        obligationId: prep.obligation!.id,
        providerRefundReference: 'cod-refund-late-6',
        parentPaymentReference: 'cod-parent-6',
        amount: '80.00',
        outcome: 'COMPLETED',
      }),
    );

    expect(res.applied).toBe(false);
    expect(res.disposition).toBe(RefundEvidenceDisposition.CONFLICT_REJECTED);
    expect(res.quarantined).toBe(true);

    const attempt = await harness.prisma.refundProviderAttempt.findUniqueOrThrow({
      where: { id: prep.attempt!.id },
    });
    const refund = await harness.prisma.refund.findUniqueOrThrow({ where: { id: prep.refund!.id } });
    const obligation = await harness.prisma.refundObligation.findUniqueOrThrow({
      where: { id: prep.obligation!.id },
    });
    const dbPayment = await harness.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });

    expect(attempt.status).toBe(RefundAttemptStatus.FAILED);
    expect(refund.status).toBe(RefundStatus.FAILED);
    expect(obligation.status).toBe(RefundObligationStatus.RECONCILE_REQUIRED);
    expect(dbPayment.status).toBe(PaymentStatus.PAID);

    await expect(
      harness.attemptsRepo.prepareAndClaimAttempt({
        paymentId: payment.id,
        obligationId: obligation.id,
        allowReplacementRetry: true,
        amount: '80.00',
        reason: 'Blocked retry while contradicted',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it('7 & 8. Preserves COMPLETED on contradictory FAILED webhook and ignores out-of-order PENDING', async () => {
    const { payment } = await harness.seedOrderWithPayment({
      amount: '95.00',
      providerReference: 'cod-parent-7',
    });
    const prep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount: '95.00',
      reason: 'Completed attempt contradictions',
      idempotencyKey: randomUUID(),
    });
    await harness.attemptsRepo.recordSyncOutcomeAndOutbox({
      paymentId: payment.id,
      attemptId: prep.attempt!.id,
      expectedAmount: '95.00',
      providerOutcome: 'COMPLETED',
      providerRefundReference: 'cod-refund-done-7',
    });

    const outOfOrderPending = await harness.evidenceProcessor.processEvidence(
      harness.buildWebhookEvidenceInput({
        attemptId: prep.attempt!.id,
        amount: '95.00',
        outcome: 'PENDING',
      }),
    );
    expect(outOfOrderPending.disposition).toBe(RefundEvidenceDisposition.DUPLICATE_IGNORED);
    expect(outOfOrderPending.quarantined).toBe(false);

    const contradictoryFailed = await harness.evidenceProcessor.processEvidence(
      harness.buildWebhookEvidenceInput({
        attemptId: prep.attempt!.id,
        providerRefundReference: 'cod-refund-done-7',
        amount: '95.00',
        outcome: 'FAILED',
      }),
    );
    expect(contradictoryFailed.disposition).toBe(RefundEvidenceDisposition.CONFLICT_REJECTED);
    expect(contradictoryFailed.quarantined).toBe(true);

    const attempt = await harness.prisma.refundProviderAttempt.findUniqueOrThrow({
      where: { id: prep.attempt!.id },
    });
    const obligation = await harness.prisma.refundObligation.findUniqueOrThrow({
      where: { id: prep.obligation!.id },
    });
    const dbPayment = await harness.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(attempt.status).toBe(RefundAttemptStatus.COMPLETED);
    expect(obligation.status).toBe(RefundObligationStatus.FULFILLED);
    expect(dbPayment.status).toBe(PaymentStatus.REFUNDED);
  });

  it('9 & 10. Deduplicates concurrent identical webhooks and quarantines tampered amounts, charge echoes, and unknowns', async () => {
    const { payment } = await harness.seedOrderWithPayment({
      amount: '140.00',
      providerReference: 'wipay-chg-9',
    });
    const prep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount: '140.00',
      reason: 'Webhook idempotency and tamper tests',
      idempotencyKey: randomUUID(),
    });
    const sharedEventId = `evt-dup-${randomUUID()}`;
    const webhookPayload = harness.buildWebhookEvidenceInput({
      attemptId: prep.attempt!.id,
      providerRefundReference: 'cod-refund-win-9',
      parentPaymentReference: 'wipay-chg-9',
      amount: '140.00',
      outcome: 'COMPLETED',
      eventId: sharedEventId,
    });

    const raceResults = await Promise.all([
      harness.evidenceProcessor.processEvidence(webhookPayload),
      harness.evidenceProcessor.processEvidence(webhookPayload),
      harness.evidenceProcessor.processEvidence(webhookPayload),
    ]);
    expect(raceResults.filter((r) => r.disposition === RefundEvidenceDisposition.APPLIED)).toHaveLength(1);
    expect(raceResults.filter((r) => r.disposition === RefundEvidenceDisposition.DUPLICATE_IGNORED)).toHaveLength(2);

    const reusedWithDiffDigest = await harness.evidenceProcessor.processEvidence({
      ...webhookPayload,
      amount: '50.00',
      evidence: {
        ...webhookPayload.evidence,
        rawPayload: { tampered: true },
        evidenceDigest: 'a'.repeat(64),
      },
    });
    expect(reusedWithDiffDigest.disposition).toBe(RefundEvidenceDisposition.CONFLICT_REJECTED);

    const { payment: p2 } = await harness.seedOrderWithPayment({
      amount: '60.00',
      providerReference: 'wipay-chg-tamper',
    });
    const prep2 = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: p2.id,
      amount: '60.00',
      reason: 'Tampered field checks',
      idempotencyKey: randomUUID(),
    });
    const echoChargeRef = await harness.evidenceProcessor.processEvidence(
      harness.buildWebhookEvidenceInput({
        attemptId: prep2.attempt!.id,
        providerRefundReference: 'wipay-chg-tamper',
        amount: '60.00',
        outcome: 'COMPLETED',
      }),
    );
    expect(echoChargeRef.disposition).toBe(RefundEvidenceDisposition.CONFLICT_REJECTED);
    expect(echoChargeRef.quarantined).toBe(true);
    expect(echoChargeRef.resultingAttemptStatus).toBe(RefundAttemptStatus.AMBIGUOUS_OUTCOME);

    const unknownAttempt = await harness.evidenceProcessor.processEvidence(
      harness.buildWebhookEvidenceInput({
        attemptId: randomUUID(),
        provider: PaymentProviderName.CASH_ON_DELIVERY,
        providerRefundReference: 'cod-refund-unknown',
        amount: '25.00',
        outcome: 'COMPLETED',
      }),
    );
    expect(unknownAttempt.disposition).toBe(RefundEvidenceDisposition.UNMATCHED_IGNORED);

    const { payment: p3 } = await harness.seedOrderWithPayment({ amount: '40.00' });
    const prep3 = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: p3.id,
      amount: '40.00',
      reason: 'Amount currency merchant mismatch',
      idempotencyKey: randomUUID(),
    });
    const wrongAmount = await harness.evidenceProcessor.processEvidence(
      harness.buildWebhookEvidenceInput({
        attemptId: prep3.attempt!.id,
        providerRefundReference: 'cod-ref-wrong-amt',
        amount: '39.00',
        outcome: 'COMPLETED',
      }),
    );
    expect(wrongAmount.disposition).toBe(RefundEvidenceDisposition.CONFLICT_REJECTED);
    expect(wrongAmount.resultingAttemptStatus).toBe(RefundAttemptStatus.AMBIGUOUS_OUTCOME);

    const wrongCurrency = await harness.evidenceProcessor.processEvidence(
      harness.buildWebhookEvidenceInput({
        attemptId: prep3.attempt!.id,
        providerRefundReference: 'cod-ref-wrong-curr',
        amount: '40.00',
        currency: 'USD',
        outcome: 'COMPLETED',
      }),
    );
    expect(wrongCurrency.disposition).toBe(RefundEvidenceDisposition.CONFLICT_REJECTED);
  });

  it('13 & 14. Conserves multi-vendor capacity across evidence resolution and concurrent replacement race', async () => {
    const { payment, vendorOrders } = await harness.seedOrderWithPayment({
      amount: '150.00',
      subtotals: ['60.00', '90.00'],
      providerReference: 'cod-multi-13',
    });

    const p1 = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      vendorOrderId: vendorOrders[0]!.id,
      amount: '60.00',
      reason: 'Vendor 1 partial refund',
      idempotencyKey: randomUUID(),
    });
    const p2 = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      vendorOrderId: vendorOrders[1]!.id,
      amount: '90.00',
      reason: 'Vendor 2 failed then replacement race',
      idempotencyKey: randomUUID(),
    });
    await harness.attemptsRepo.recordSyncOutcomeAndOutbox({
      paymentId: payment.id,
      attemptId: p2.attempt!.id,
      expectedAmount: '90.00',
      providerOutcome: 'FAILED',
      retryEligible: true,
    });

    const [winOutcome, replaceOutcome] = await Promise.allSettled([
      harness.evidenceProcessor.processEvidence(
        harness.buildWebhookEvidenceInput({
          attemptId: p1.attempt!.id,
          providerRefundReference: 'cod-ref-vo1',
          amount: '60.00',
          outcome: 'COMPLETED',
        }),
      ),
      harness.attemptsRepo.prepareAndClaimAttempt({
        paymentId: payment.id,
        obligationId: p2.obligation!.id,
        allowReplacementRetry: true,
        vendorOrderId: vendorOrders[1]!.id,
        amount: '90.00',
        reason: 'Replacement retry for vo2',
        idempotencyKey: randomUUID(),
      }),
    ]);

    expect(winOutcome.status).toBe('fulfilled');
    expect(replaceOutcome.status).toBe('fulfilled');

    const dbPay = await harness.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(dbPay.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);

    // Late contradictory COMPLETED arriving for failed A1 while replacement is active escalates obligation to RECONCILE_REQUIRED
    const lateConflict = await harness.evidenceProcessor.processEvidence(
      harness.buildWebhookEvidenceInput({
        attemptId: p2.attempt!.id,
        providerRefundReference: 'cod-ref-vo2-late',
        amount: '90.00',
        outcome: 'COMPLETED',
      }),
    );
    expect(lateConflict.disposition).toBe(RefundEvidenceDisposition.CONFLICT_REJECTED);

    const ob2 = await harness.prisma.refundObligation.findUniqueOrThrow({
      where: { id: p2.obligation!.id },
    });
    expect(ob2.status).toBe(RefundObligationStatus.RECONCILE_REQUIRED);
    const conflictEvent = await harness.prisma.refundProviderAttemptEvent.findFirst({
      where: {
        attemptId: p2.attempt!.id,
        eventType: RefundAttemptEventType.CONTRADICTION_QUARANTINED,
      },
    });
    expect(conflictEvent).not.toBeNull();
  });
});
