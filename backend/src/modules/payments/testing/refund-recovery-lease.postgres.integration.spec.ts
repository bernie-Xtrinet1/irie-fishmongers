import { randomUUID } from 'crypto';

import {
  PaymentStatus,
  RefundAttemptEventType,
  RefundAttemptFailureClass,
  RefundAttemptStatus,
  RefundEvidenceDisposition,
  RefundEvidenceProvenance,
  RefundObligationStatus,
  RefundStatus,
} from '@prisma/client';

import {
  createRefundRecoveryHarness,
  RefundRecoveryHarness,
} from './refund-recovery-fixture.helper';

jest.setTimeout(120_000);

describe('Refund Recovery Service & Lease Crash Windows (PostgreSQL Integration)', () => {
  let harness: RefundRecoveryHarness;

  beforeAll(async () => {
    harness = await createRefundRecoveryHarness();
  });

  afterAll(async () => {
    await harness?.destroy();
  });

  it('1. Moves expired DISPATCHING lease -> AMBIGUOUS_OUTCOME + RECONCILE_REQUIRED + event + deterministic outbox', async () => {
    const { payment } = await harness.seedOrderWithPayment({ amount: '150.00' });
    const prep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount: '150.00',
      reason: 'Lease timeout recovery scenario 1',
      idempotencyKey: randomUUID(),
      leaseDurationMs: 25,
    });
    expect(prep.action).toBe('DISPATCH');
    expect(prep.attempt?.status).toBe(RefundAttemptStatus.DISPATCHING);

    await new Promise((r) => setTimeout(r, 45));
    const summary = await harness.recoveryService.recoverExpiredLeases(new Date(), 50, {
      actorId: 'recovery-worker-1',
      actorRole: 'SYSTEM_RECOVERY',
    });

    expect(summary.quarantinedIds).toContain(prep.attempt!.id);
    const outcome = summary.results.find((r) => r.attemptId === prep.attempt!.id);
    expect(outcome?.transitioned).toBe(true);
    expect(outcome?.resultingAttemptStatus).toBe(RefundAttemptStatus.AMBIGUOUS_OUTCOME);

    const attempt = await harness.prisma.refundProviderAttempt.findUniqueOrThrow({
      where: { id: prep.attempt!.id },
    });
    const refund = await harness.prisma.refund.findUniqueOrThrow({ where: { id: prep.refund!.id } });
    const obligation = await harness.prisma.refundObligation.findUniqueOrThrow({
      where: { id: prep.obligation!.id },
    });
    expect(attempt.status).toBe(RefundAttemptStatus.AMBIGUOUS_OUTCOME);
    expect(attempt.failureClassification).toBe(RefundAttemptFailureClass.PROCESS_CRASH_SUSPECTED);
    expect(attempt.retryEligible).toBe(false);
    expect(attempt.quarantinedAt).not.toBeNull();
    expect(refund.status).toBe(RefundStatus.RECONCILE_REQUIRED);
    expect(obligation.status).toBe(RefundObligationStatus.RECONCILE_REQUIRED);

    const events = await harness.prisma.refundProviderAttemptEvent.findMany({
      where: { attemptId: attempt.id },
      orderBy: { eventSequence: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual([
      RefundAttemptEventType.ATTEMPT_PREPARED,
      RefundAttemptEventType.DISPATCH_CLAIMED,
      RefundAttemptEventType.LEASE_EXPIRED_QUARANTINED,
    ]);

    const outbox = await harness.prisma.paymentOutbox.findFirstOrThrow({
      where: { aggregateId: refund.id, eventType: 'REFUND_LEASE_EXPIRED_QUARANTINED' },
    });
    const payload = outbox.payload as Record<string, unknown>;
    expect(payload['logicalEventKey']).toBe(
      `refund_outbox:REFUND_LEASE_EXPIRED_QUARANTINED:att:${attempt.id}:seq:3`,
    );
  });

  it('2. Serializes concurrent recovery workers via CAS so exactly one transitions and zero duplicates are emitted', async () => {
    const { payment } = await harness.seedOrderWithPayment({ amount: '90.00' });
    const prep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount: '90.00',
      reason: 'Concurrent recovery race',
      idempotencyKey: randomUUID(),
      leaseDurationMs: 20,
    });
    const attemptId = prep.attempt!.id;

    await new Promise((r) => setTimeout(r, 40));
    const raceTime = new Date();
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, idx) =>
        harness.recoveryService.recoverAttempt(attemptId, raceTime, {
          actorId: `worker-${idx}`,
          actorRole: 'SYSTEM_RECOVERY',
        }),
      ),
    );

    const winners = outcomes.filter((o) => o.transitioned);
    expect(winners).toHaveLength(1);
    expect(outcomes.filter((o) => !o.transitioned)).toHaveLength(5);

    const leaseEvents = await harness.prisma.refundProviderAttemptEvent.findMany({
      where: { attemptId, eventType: RefundAttemptEventType.LEASE_EXPIRED_QUARANTINED },
    });
    expect(leaseEvents).toHaveLength(1);

    const outboxRows = await harness.prisma.paymentOutbox.findMany({
      where: { aggregateId: prep.refund!.id, eventType: 'REFUND_LEASE_EXPIRED_QUARANTINED' },
    });
    expect(outboxRows).toHaveLength(1);
  });

  it('3 & 4. Leaves non-expired lease untouched and makes repeated recovery idempotent', async () => {
    const { payment } = await harness.seedOrderWithPayment({ amount: '75.00' });
    const prep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount: '75.00',
      reason: 'Active lease guard',
      idempotencyKey: randomUUID(),
      leaseDurationMs: 60_000,
    });
    const attemptId = prep.attempt!.id;

    const earlyAttempt = await harness.recoveryService.recoverAttempt(attemptId, new Date());
    expect(earlyAttempt.transitioned).toBe(false);
    expect(earlyAttempt.resultingAttemptStatus).toBe(RefundAttemptStatus.DISPATCHING);

    const futureTime = new Date(Date.now() + 120_000);
    const firstRecovery = await harness.recoveryService.recoverAttempt(attemptId, futureTime);
    expect(firstRecovery.transitioned).toBe(true);

    const repeatRecovery = await harness.recoveryService.recoverAttempt(attemptId, futureTime);
    expect(repeatRecovery.transitioned).toBe(false);
    expect(repeatRecovery.resultingAttemptStatus).toBe(RefundAttemptStatus.AMBIGUOUS_OUTCOME);

    const paymentAfter = await harness.prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(paymentAfter.status).toBe(PaymentStatus.PAID);
  });

  it('12. Resolves AMBIGUOUS_OUTCOME after late authenticated webhook arrival without retry dispatch', async () => {
    const { payment } = await harness.seedOrderWithPayment({
      amount: '110.00',
      providerReference: 'cod-parent-12',
    });
    const prep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount: '110.00',
      reason: 'Crash quarantine followed by late webhook',
      idempotencyKey: randomUUID(),
      leaseDurationMs: 20,
    });
    const attemptId = prep.attempt!.id;

    await new Promise((r) => setTimeout(r, 40));
    await harness.recoveryService.recoverAttempt(attemptId, new Date());

    const webhookResult = await harness.evidenceProcessor.processEvidence(
      harness.buildWebhookEvidenceInput({
        attemptId,
        obligationId: prep.obligation!.id,
        providerRefundReference: 'cod-refund-late-12',
        parentPaymentReference: 'cod-parent-12',
        amount: '110.00',
        outcome: 'COMPLETED',
        eventId: `evt-late-win-${randomUUID()}`,
      }),
    );

    expect(webhookResult.applied).toBe(true);
    expect(webhookResult.disposition).toBe(RefundEvidenceDisposition.APPLIED);
    expect(webhookResult.resultingAttemptStatus).toBe(RefundAttemptStatus.COMPLETED);
    expect(webhookResult.resultingRefundStatus).toBe(RefundStatus.COMPLETED);
    expect(webhookResult.resultingObligationStatus).toBe(RefundObligationStatus.FULFILLED);

    const finalAttempt = await harness.prisma.refundProviderAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    expect(finalAttempt.resolvedByProvenance).toBe(
      RefundEvidenceProvenance.AUTHENTICATED_WEBHOOK,
    );
    expect(finalAttempt.resolvedByEventId).toBe(webhookResult.attemptEventId);

    const finalPayment = await harness.prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(finalPayment.status).toBe(PaymentStatus.REFUNDED);
  });

  it('12b. Resolves AMBIGUOUS_OUTCOME after late definitive FAILED webhook and reopens obligation', async () => {
    const { payment } = await harness.seedOrderWithPayment({
      amount: '45.00',
      providerReference: 'cod-parent-12b',
    });
    const prep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount: '45.00',
      reason: 'Crash quarantine followed by late decline webhook',
      idempotencyKey: randomUUID(),
      leaseDurationMs: 20,
    });
    await new Promise((r) => setTimeout(r, 40));
    await harness.recoveryService.recoverAttempt(prep.attempt!.id, new Date());

    const failedWebhook = await harness.evidenceProcessor.processEvidence(
      harness.buildWebhookEvidenceInput({
        attemptId: prep.attempt!.id,
        obligationId: prep.obligation!.id,
        parentPaymentReference: 'cod-parent-12b',
        amount: '45.00',
        outcome: 'FAILED',
        eventId: `evt-late-fail-${randomUUID()}`,
      }),
    );

    expect(failedWebhook.applied).toBe(true);
    expect(failedWebhook.resultingAttemptStatus).toBe(RefundAttemptStatus.FAILED);
    expect(failedWebhook.resultingRefundStatus).toBe(RefundStatus.FAILED);
    expect(failedWebhook.resultingObligationStatus).toBe(RefundObligationStatus.OPEN);
  });
});
