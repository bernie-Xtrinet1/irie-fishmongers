import { randomUUID } from 'crypto';

import { ConflictException, NotImplementedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  PaymentProviderName,
  PaymentStatus,
  RefundAttemptEventType,
  RefundAttemptFailureClass,
  RefundAttemptStatus,
  RefundObligationStatus,
  RefundStatus,
} from '@prisma/client';

import { PaymentRefundDispatchContext } from '../interfaces/payment-provider.interface';
import { RefundAttemptsRepository } from '../repositories/refund-attempts.repository';
import { createRefundLedgerHarness, RefundLedgerHarness } from './refund-ledger-fixture.helper';

jest.setTimeout(120_000);

describe('Refund Attempt Ledger & Crash Windows (PostgreSQL Integration Suite)', () => {
  let harness: RefundLedgerHarness;

  beforeAll(async () => {
    harness = await createRefundLedgerHarness();
  });

  afterAll(async () => {
    await harness?.destroy();
  });

  it('1. Deduplicates 10 concurrent identical refund dispatches to exactly 1 provider call', async () => {
    const { payment } = await harness.seedOrderWithPayment({ amount: '100.00' });
    let providerCalls = 0;
    const service = harness.createPaymentsService({
      refundPayment: jest
        .fn()
        .mockImplementation(
          async (_ref: string, _amt: number, _rsn: string, ctx?: PaymentRefundDispatchContext) => {
            providerCalls++;
            await new Promise((r) => setTimeout(r, 40));
            return {
              providerReference: `cod-refund-${ctx?.attemptId ?? randomUUID()}`,
              status: 'COMPLETED' as const,
            };
          },
        ),
    });

    const idemKey = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.refundByPaymentId(payment.id, 100, 'Concurrent click storm', idemKey),
      ),
    );

    expect(providerCalls).toBe(1);
    expect(results).toHaveLength(10);
    const obligations = await harness.prisma.refundObligation.findMany({
      where: { paymentId: payment.id },
    });
    const refunds = await harness.prisma.refund.findMany({ where: { paymentId: payment.id } });
    const attempts = await harness.prisma.refundProviderAttempt.findMany({
      where: { paymentId: payment.id },
    });
    expect(obligations).toHaveLength(1);
    expect(obligations[0]!.status).toBe(RefundObligationStatus.FULFILLED);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe(RefundStatus.COMPLETED);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe(RefundAttemptStatus.COMPLETED);
    const updatedPayment = await harness.prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(updatedPayment.status).toBe(PaymentStatus.REFUNDED);
  });

  it('2. Preserves async PENDING refund without regressing to PROCESSING or re-dispatching', async () => {
    const { payment } = await harness.seedOrderWithPayment({ amount: '100.00' });
    let providerCalls = 0;
    const service = harness.createPaymentsService({
      refundPayment: jest
        .fn()
        .mockImplementation(
          (_ref: string, _amt: number, _rsn: string, ctx?: PaymentRefundDispatchContext) => {
            providerCalls++;
            return Promise.resolve({
              providerReference: `async-pending-${ctx?.attemptId ?? 'ref'}`,
              status: 'PENDING' as const,
            });
          },
        ),
    });

    const idemKey = randomUUID();
    const first = await service.refundByPaymentId(payment.id, 60, 'Async payout', idemKey);
    expect(first.status).toBe(RefundStatus.PENDING);
    expect(providerCalls).toBe(1);

    const retry = await service.refundByPaymentId(payment.id, 60, 'Async payout', idemKey);
    expect(retry.status).toBe(RefundStatus.PENDING);
    expect(providerCalls).toBe(1);

    const reserveRetry = await harness.refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '60.00',
      reason: 'Retry should return IN_FLIGHT',
      idempotencyKey: idemKey,
    });
    expect(reserveRetry.status).toBe('IN_FLIGHT');
    expect(reserveRetry.refund?.status).toBe(RefundStatus.PENDING);
  });

  it('3. Leaves zero state or consumed capacity when TX1 aborts before commit', async () => {
    const { payment } = await harness.seedOrderWithPayment({ amount: '80.00' });
    const failingAttemptsRepo = {
      ...harness.attemptsRepo,
      prepareAndClaimAttempt: jest.fn().mockRejectedValue(new Error('DB TX1 crash before commit')),
    } as unknown as RefundAttemptsRepository;

    let providerCalls = 0;
    const crashingService = harness.createPaymentsService(
      {
        refundPayment: jest.fn().mockImplementation(() => {
          providerCalls++;
          return Promise.resolve({
            providerReference: 'should-never-run',
            status: 'COMPLETED' as const,
          });
        }),
      },
      new EventEmitter2(),
      failingAttemptsRepo,
    );

    const key = randomUUID();
    await expect(
      crashingService.refundByPaymentId(payment.id, 80, 'Pre-TX1 failure', key),
    ).rejects.toThrow('DB TX1 crash before commit');
    expect(providerCalls).toBe(0);

    expect(await harness.prisma.refundObligation.count({ where: { paymentId: payment.id } })).toBe(0);
    expect(await harness.prisma.refund.count({ where: { paymentId: payment.id } })).toBe(0);
    expect(await harness.prisma.refundProviderAttempt.count({ where: { paymentId: payment.id } })).toBe(0);

    const cleanService = harness.createPaymentsService();
    const res = await cleanService.refundByPaymentId(payment.id, 80, 'Clean recovery', key);
    expect(res.status).toBe(RefundStatus.COMPLETED);
  });

  it('4 & 11. Quarantines expired DISPATCHING crash window via sweeper without calling provider', async () => {
    const { payment } = await harness.seedOrderWithPayment({ amount: '120.00' });
    const key = randomUUID();

    const prep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount: '70.00',
      reason: 'Simulated worker crash after TX1',
      idempotencyKey: key,
      leaseDurationMs: 20,
    });
    expect(prep.action).toBe('DISPATCH');
    expect(prep.attempt?.status).toBe(RefundAttemptStatus.DISPATCHING);

    const service = harness.createPaymentsService();
    await expect(
      service.refundByPaymentId(payment.id, 60, 'Cannot steal capacity', randomUUID()),
    ).rejects.toThrow();

    await new Promise((r) => setTimeout(r, 40));
    const quarantinedIds = await harness.inspectionService.quarantineExpiredDispatchingAttempts(
      new Date(),
    );
    expect(quarantinedIds).toContain(prep.attempt!.id);

    const inspected = await harness.inspectionService.inspectByRefundId(prep.refund!.id);
    expect(inspected?.obligation.status).toBe(RefundObligationStatus.RECONCILE_REQUIRED);
    expect(inspected?.refunds[0]?.status).toBe(RefundStatus.RECONCILE_REQUIRED);
    expect(inspected?.attempts[0]?.status).toBe(RefundAttemptStatus.AMBIGUOUS_OUTCOME);
    expect(inspected?.attempts[0]?.failureClassification).toBe(
      RefundAttemptFailureClass.PROCESS_CRASH_SUSPECTED,
    );
    expect(inspected?.attempts[0]?.events.map((e) => e.eventType)).toEqual([
      RefundAttemptEventType.ATTEMPT_PREPARED,
      RefundAttemptEventType.DISPATCH_CLAIMED,
      RefundAttemptEventType.LEASE_EXPIRED_QUARANTINED,
    ]);

    const outbox = await harness.prisma.paymentOutbox.findFirst({
      where: { aggregateId: prep.refund!.id, eventType: 'REFUND_LEASE_EXPIRED_QUARANTINED' },
    });
    expect(outbox).not.toBeNull();

    const adapterSpy = jest.fn();
    const replayService = harness.createPaymentsService({ refundPayment: adapterSpy });
    const replay = await replayService.refundByPaymentId(payment.id, 70, 'Replay after crash', key);
    expect(replay.status).toBe(RefundStatus.RECONCILE_REQUIRED);
    expect(adapterSpy).not.toHaveBeenCalled();
  });

  it('5 & 6. Quarantines transport timeout & contradictory provider echo without re-dispatch', async () => {
    const { payment } = await harness.seedOrderWithPayment({
      amount: '100.00',
      providerReference: 'chg-parent-ref-100',
    });

    let calls = 0;
    const timeoutKey = randomUUID();
    const timeoutService = harness.createPaymentsService({
      refundPayment: jest.fn().mockImplementation(() => {
        calls++;
        return Promise.reject(new Error('ECONNRESET lost gateway HTTP response'));
      }),
    });

    await expect(
      timeoutService.refundByPaymentId(payment.id, 40, 'Lost response', timeoutKey),
    ).rejects.toThrow('ECONNRESET');
    expect(calls).toBe(1);

    const replay = await timeoutService.refundByPaymentId(
      payment.id,
      40,
      'Lost response',
      timeoutKey,
    );
    expect(replay.status).toBe(RefundStatus.RECONCILE_REQUIRED);
    expect(calls).toBe(1);

    const echoKey = randomUUID();
    const echoService = harness.createPaymentsService({
      refundPayment: jest.fn().mockResolvedValue({
        providerReference: 'chg-parent-ref-100',
        status: 'COMPLETED',
      }),
    });
    await expect(
      echoService.refundByPaymentId(payment.id, 30, 'Echoed charge ref', echoKey),
    ).rejects.toBeInstanceOf(ConflictException);

    const echoRefund = await harness.prisma.refund.findUniqueOrThrow({
      where: { idempotencyKey: echoKey },
    });
    expect(echoRefund.status).toBe(RefundStatus.RECONCILE_REQUIRED);
    const echoAttempt = await harness.prisma.refundProviderAttempt.findFirstOrThrow({
      where: { refundId: echoRefund.id },
    });
    expect(echoAttempt.failureClassification).toBe(RefundAttemptFailureClass.EVIDENCE_CONTRADICTION);
  });

  it('7. Keeps TX2 outcome and durable PaymentOutbox committed when in-memory EventEmitter fails', async () => {
    const { payment } = await harness.seedOrderWithPayment({ amount: '50.00' });
    const failingEmitter = {
      emitAsync: jest.fn().mockRejectedValue(new Error('In-memory bus unavailable')),
    } as unknown as EventEmitter2;

    const key = randomUUID();
    const service = harness.createPaymentsService(undefined, failingEmitter);
    const res = await service.refundByPaymentId(payment.id, 50, 'Emitter failure resilience', key);
    expect(res.status).toBe(RefundStatus.COMPLETED);

    const outbox = await harness.prisma.paymentOutbox.findFirst({
      where: { aggregateId: res.id, eventType: 'REFUND_STATUS_CHANGED' },
    });
    expect(outbox).not.toBeNull();
    expect(outbox?.published).toBe(false);
    const updatedPayment = await harness.prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(updatedPayment.status).toBe(PaymentStatus.REFUNDED);
  });

  it('14. Keeps WiPay refunds & webhooks fail-closed with clean pre-send abort (TX2A)', async () => {
    const { payment } = await harness.seedOrderWithPayment({
      amount: '75.00',
      provider: PaymentProviderName.WIPAY,
      providerReference: 'wipay-chg-1',
    });

    const service = harness.createPaymentsService();
    const key = randomUUID();
    await expect(
      service.refundByPaymentId(payment.id, 75, 'WiPay unsupported', key),
    ).rejects.toBeInstanceOf(NotImplementedException);

    const refund = await harness.prisma.refund.findUniqueOrThrow({ where: { idempotencyKey: key } });
    expect(refund.status).toBe(RefundStatus.REQUIRED);
    const inspected = await harness.inspectionService.inspectByRefundId(refund.id);
    expect(inspected?.obligation.status).toBe(RefundObligationStatus.OPEN);
    expect(inspected?.attempts[0]?.status).toBe(RefundAttemptStatus.CANCELLED_BEFORE_DISPATCH);
    expect(inspected?.attempts[0]?.failureClassification).toBe(
      RefundAttemptFailureClass.UNSUPPORTED_OPERATION,
    );

    await expect(service.handleWiPayWebhook('{}', 'sig')).rejects.toBeInstanceOf(
      NotImplementedException,
    );
  });
});
