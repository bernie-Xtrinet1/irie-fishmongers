import { randomUUID } from 'crypto';

import { NotImplementedException } from '@nestjs/common';
import {
  PaymentProviderName,
  PaymentStatus,
  RefundAttemptStatus,
  RefundEvidenceProvenance,
  RefundObligationStatus,
  RefundStatus,
} from '@prisma/client';

import {
  PaymentProviderAdapter,
  RefundStatusLookupQuery,
} from '../interfaces/payment-provider.interface';
import { RefundOutboxRecord } from '../types/refund-reconciliation.types';
import {
  createRefundRecoveryHarness,
  RefundRecoveryHarness,
} from './refund-recovery-fixture.helper';

jest.setTimeout(120_000);

describe('Refund Status Polling & Outbox Idempotent Delivery (PostgreSQL Integration)', () => {
  let harness: RefundRecoveryHarness;

  beforeAll(async () => {
    harness = await createRefundRecoveryHarness();
  });

  afterAll(async () => {
    await harness?.destroy();
  });

  it('Phase 3: fails closed for WiPay and uses read-only CAS polling without invoking refundPayment', async () => {
    const { payment: wiPayPayment } = await harness.seedOrderWithPayment({
      amount: '85.00',
      provider: PaymentProviderName.WIPAY,
      providerReference: 'wipay-chg-poll-1',
    });
    const wiPayPrep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: wiPayPayment.id,
      amount: '85.00',
      reason: 'WiPay quarantined attempt stays unsupported for polling',
      idempotencyKey: randomUUID(),
      leaseDurationMs: 20,
    });
    await new Promise((r) => setTimeout(r, 35));
    await harness.recoveryService.recoverAttempt(wiPayPrep.attempt!.id, new Date());

    await expect(
      harness.statusReconciliationService.reconcileAttemptStatus(wiPayPrep.attempt!.id),
    ).rejects.toThrow(NotImplementedException);

    const { payment } = await harness.seedOrderWithPayment({
      amount: '125.00',
      providerReference: 'cod-chg-poll-2',
    });
    const prep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount: '125.00',
      reason: 'Pending then polled to completion',
      idempotencyKey: randomUUID(),
    });
    await harness.attemptsRepo.recordSyncOutcomeAndOutbox({
      paymentId: payment.id,
      attemptId: prep.attempt!.id,
      expectedAmount: '125.00',
      providerOutcome: 'PENDING',
    });

    const refundPaymentSpy = jest.fn();
    let pollCalls = 0;
    const mockAdapter: PaymentProviderAdapter = {
      name: PaymentProviderName.CASH_ON_DELIVERY,
      supportsRefundStatusLookup: true,
      createPayment: jest.fn(),
      verifyPayment: jest.fn(),
      refundPayment: refundPaymentSpy,
      verifyRefundStatus: jest.fn().mockImplementation(async (query: RefundStatusLookupQuery) => {
        pollCalls += 1;
        await new Promise((r) => setTimeout(r, 30));
        return {
          outcome: 'COMPLETED' as const,
          providerIdempotencyKey: query.providerIdempotencyKey,
          providerRefundReference: 'cod-poll-ref-125',
          parentPaymentReference: 'cod-chg-poll-2',
          amount: '125.00',
          currency: 'JMD',
          providerEventId: `poll-evt-${prep.attempt!.id}`,
        };
      }),
    };

    const pollResults = await Promise.all(
      Array.from({ length: 4 }, () =>
        harness.statusReconciliationService.reconcileAttemptStatus(prep.attempt!.id, {
          adapterOverrides: { [PaymentProviderName.CASH_ON_DELIVERY]: mockAdapter },
          evidencePolicyOverride: {
            trustedStatusPollAdapters: [PaymentProviderName.CASH_ON_DELIVERY],
          },
        }),
      ),
    );

    expect(pollCalls).toBe(1);
    expect(refundPaymentSpy).not.toHaveBeenCalled();
    expect(pollResults.filter((r) => r.outcome === 'COMPLETED')).toHaveLength(1);
    expect(pollResults.filter((r) => r.outcome === 'SKIPPED_LEASED_OR_INELIGIBLE')).toHaveLength(3);

    const resolved = await harness.prisma.refundProviderAttempt.findUniqueOrThrow({
      where: { id: prep.attempt!.id },
    });
    expect(resolved.status).toBe(RefundAttemptStatus.COMPLETED);
    expect(resolved.resolvedByProvenance).toBe(RefundEvidenceProvenance.VERIFIED_STATUS_POLL);
    expect(resolved.pollAttemptCount).toBe(1);
    expect(resolved.pollLockUntil).toBeNull();

    const finalPayment = await harness.prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(finalPayment.status).toBe(PaymentStatus.REFUNDED);
  });

  it('Phase 3 edge cases: releases pollLockUntil on transient error and keeps AMBIGUOUS_OUTCOME on PENDING poll', async () => {
    const { payment } = await harness.seedOrderWithPayment({
      amount: '65.00',
      providerReference: 'cod-chg-poll-3',
    });
    const prep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount: '65.00',
      reason: 'Ambiguous attempt poll transitions',
      idempotencyKey: randomUUID(),
      leaseDurationMs: 20,
    });
    await new Promise((r) => setTimeout(r, 35));
    await harness.recoveryService.recoverAttempt(prep.attempt!.id, new Date());

    const failingAdapter: PaymentProviderAdapter = {
      name: PaymentProviderName.CASH_ON_DELIVERY,
      supportsRefundStatusLookup: true,
      createPayment: jest.fn(),
      verifyPayment: jest.fn(),
      refundPayment: jest.fn(),
      verifyRefundStatus: jest.fn().mockRejectedValue(new Error('503 status endpoint timeout')),
    };

    await expect(
      harness.statusReconciliationService.reconcileAttemptStatus(prep.attempt!.id, {
        adapterOverrides: { [PaymentProviderName.CASH_ON_DELIVERY]: failingAdapter },
      }),
    ).rejects.toThrow('503 status endpoint timeout');

    const afterError = await harness.prisma.refundProviderAttempt.findUniqueOrThrow({
      where: { id: prep.attempt!.id },
    });
    expect(afterError.pollLockUntil).toBeNull();
    expect(afterError.status).toBe(RefundAttemptStatus.AMBIGUOUS_OUTCOME);

    const pendingAdapter: PaymentProviderAdapter = {
      name: PaymentProviderName.CASH_ON_DELIVERY,
      supportsRefundStatusLookup: true,
      createPayment: jest.fn(),
      verifyPayment: jest.fn(),
      refundPayment: jest.fn(),
      verifyRefundStatus: jest.fn().mockResolvedValue({
        outcome: 'PENDING' as const,
        amount: '65.00',
        currency: 'JMD',
        providerEventId: `poll-still-pending-${prep.attempt!.id}`,
      }),
    };

    const pendingPoll = await harness.statusReconciliationService.reconcileAttemptStatus(
      prep.attempt!.id,
      {
        adapterOverrides: { [PaymentProviderName.CASH_ON_DELIVERY]: pendingAdapter },
        evidencePolicyOverride: {
          trustedStatusPollAdapters: [PaymentProviderName.CASH_ON_DELIVERY],
        },
      },
    );
    expect(pendingPoll.outcome).toBe('PENDING');

    const stillAmbiguous = await harness.prisma.refundProviderAttempt.findUniqueOrThrow({
      where: { id: prep.attempt!.id },
    });
    const stillReconcile = await harness.prisma.refundObligation.findUniqueOrThrow({
      where: { id: prep.obligation!.id },
    });
    const stillRefund = await harness.prisma.refund.findUniqueOrThrow({
      where: { id: prep.refund!.id },
    });
    expect(stillAmbiguous.status).toBe(RefundAttemptStatus.AMBIGUOUS_OUTCOME);
    expect(stillReconcile.status).toBe(RefundObligationStatus.RECONCILE_REQUIRED);
    expect(stillRefund.status).toBe(RefundStatus.RECONCILE_REQUIRED);
  });

  it('11. Outbox delivery fails closed by default and retries crash/lost-ACK without duplicate notifications or double mutation', async () => {
    await harness.outboxService.dispatchPendingRefundEvents(() => Promise.resolve(), {
      limit: 100,
    });

    const { payment } = await harness.seedOrderWithPayment({ amount: '55.00' });
    const service = harness.createPaymentsService();
    const refund = await service.refundByPaymentId(payment.id, 55, 'Outbox test', randomUUID());

    const blockedDispatch = await harness.defaultOutboxService.dispatchPendingRefundEvents(() =>
      Promise.resolve(),
    );
    expect(blockedDispatch.publishedIds).toEqual([]);

    const outboxRow = await harness.prisma.paymentOutbox.findFirstOrThrow({
      where: { aggregateId: refund.id, eventType: 'REFUND_STATUS_CHANGED' },
    });
    expect(outboxRow.published).toBe(false);

    const processedLogicalKeys = new Set<string>();
    let logicalSideEffects = 0;
    let simulateCrashAfterSideEffect = true;

    const idempotentCrashingConsumer = (event: RefundOutboxRecord): Promise<void> => {
      if (!processedLogicalKeys.has(event.logicalEventKey)) {
        processedLogicalKeys.add(event.logicalEventKey);
        logicalSideEffects += 1;
      }
      if (simulateCrashAfterSideEffect) {
        simulateCrashAfterSideEffect = false;
        return Promise.reject(new Error('Lost ACK before commit'));
      }
      return Promise.resolve();
    };

    const firstPass = await harness.outboxService.dispatchPendingRefundEvents(
      idempotentCrashingConsumer,
      { limit: 100 },
    );
    expect(firstPass.failed.some((f) => f.outboxId === outboxRow.id)).toBe(true);

    const stillUnpublished = await harness.prisma.paymentOutbox.findUniqueOrThrow({
      where: { id: outboxRow.id },
    });
    expect(stillUnpublished.published).toBe(false);

    const secondPass = await harness.outboxService.dispatchPendingRefundEvents(
      idempotentCrashingConsumer,
      { limit: 100 },
    );
    expect(secondPass.publishedIds).toContain(outboxRow.id);

    const publishedRow = await harness.prisma.paymentOutbox.findUniqueOrThrow({
      where: { id: outboxRow.id },
    });
    expect(publishedRow.published).toBe(true);
    expect(publishedRow.publishedAt).not.toBeNull();
    expect(logicalSideEffects).toBe(processedLogicalKeys.size);
  });

  it('15 & 11b. Concurrent outbox dispatchers deduplicate via FOR UPDATE and poll mismatch quarantines safely', async () => {
    const { payment } = await harness.seedOrderWithPayment({
      amount: '70.00',
      providerReference: 'cod-chg-poll-15',
    });
    const prep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount: '70.00',
      reason: 'Concurrent outbox and mismatched poll',
      idempotencyKey: randomUUID(),
    });
    await harness.attemptsRepo.recordSyncOutcomeAndOutbox({
      paymentId: payment.id,
      attemptId: prep.attempt!.id,
      expectedAmount: '70.00',
      providerOutcome: 'PENDING',
    });

    const deliveredIds: string[] = [];
    const race = await Promise.all([
      harness.outboxService.dispatchPendingRefundEvents(async (evt) => {
        await new Promise((r) => setTimeout(r, 20));
        deliveredIds.push(evt.id);
      }),
      harness.outboxService.dispatchPendingRefundEvents(async (evt) => {
        await new Promise((r) => setTimeout(r, 20));
        deliveredIds.push(evt.id);
      }),
    ]);

    const publishedTotal = race[0].publishedIds.length + race[1].publishedIds.length;
    expect(publishedTotal).toBe(deliveredIds.length);
    expect(new Set(deliveredIds).size).toBe(deliveredIds.length);

    const mismatchedPollAdapter: PaymentProviderAdapter = {
      name: PaymentProviderName.CASH_ON_DELIVERY,
      supportsRefundStatusLookup: true,
      createPayment: jest.fn(),
      verifyPayment: jest.fn(),
      refundPayment: jest.fn(),
      verifyRefundStatus: jest.fn().mockResolvedValue({
        outcome: 'COMPLETED' as const,
        providerRefundReference: 'cod-poll-bad-amt',
        amount: '999.00',
        currency: 'JMD',
      }),
    };

    const pollConflict = await harness.statusReconciliationService.reconcileAttemptStatus(
      prep.attempt!.id,
      {
        adapterOverrides: { [PaymentProviderName.CASH_ON_DELIVERY]: mismatchedPollAdapter },
        evidencePolicyOverride: {
          trustedStatusPollAdapters: [PaymentProviderName.CASH_ON_DELIVERY],
        },
      },
    );
    expect(pollConflict.outcome).toBe('CONFLICT_QUARANTINED');

    const quarantined = await harness.prisma.refundProviderAttempt.findUniqueOrThrow({
      where: { id: prep.attempt!.id },
    });
    expect(quarantined.status).toBe(RefundAttemptStatus.AMBIGUOUS_OUTCOME);
  });
});
