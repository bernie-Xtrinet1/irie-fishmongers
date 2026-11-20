import { createHash, randomUUID } from 'crypto';

import {
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  RefundAttemptStatus,
  RefundObligationStatus,
  RefundReconciliationActionType,
  RefundReconciliationApprovalStatus,
  RefundStatus,
  RoleName,
  SettlementDisposition,
  SettlementEvidenceProvenance,
  UserStatus,
  VendorOrderStatus,
} from '@prisma/client';

import { createOrPreserveRefundObligation } from '../../orders/utils/order-cancellation-refund.util';
import { createRefundLedgerHarness, RefundLedgerHarness } from './refund-ledger-fixture.helper';

jest.setTimeout(120_000);

describe('Refund Obligation Capacity, Supersession & Deadlock-Free Concurrency (PG Suite)', () => {
  let harness: RefundLedgerHarness;

  beforeAll(async () => {
    harness = await createRefundLedgerHarness();
  });

  afterAll(async () => {
    await harness?.destroy();
  });

  it('8. Retains capacity across FAILED R1, supports correlated R2 supersession, and prevents capacity theft', async () => {
    const { payment } = await harness.seedOrderWithPayment({ amount: '100.00' });
    const declineService = harness.createPaymentsService({
      refundPayment: jest.fn().mockResolvedValue({
        providerReference: 'gw-declined-attempt-1',
        status: 'FAILED',
      }),
    });

    const oblKey = randomUUID();
    const r1Res = await declineService.refundByPaymentId(payment.id, 100, 'Declined payout', oblKey);
    expect(r1Res.status).toBe(RefundStatus.FAILED);

    // Obligation stays OPEN retaining $100 so an unrelated request gets blocked
    await expect(
      declineService.refundByPaymentId(payment.id, 10, 'Unrelated capacity grab', randomUUID()),
    ).rejects.toThrow('Refund amount exceeds the remaining refundable balance');

    // Approved replacement retry on the same obligation supersedes R1 and creates R2
    const recoveryService = harness.createPaymentsService();
    const r2Res = await recoveryService.refundByPaymentId(
      payment.id,
      100,
      'Retry payout on same obligation',
      oblKey,
      { allowReplacementRetry: true },
    );
    expect(r2Res.status).toBe(RefundStatus.COMPLETED);
    expect(r2Res.id).not.toBe(r1Res.id);

    const r2Row = await harness.prisma.refund.findUniqueOrThrow({ where: { id: r2Res.id } });
    expect(r2Row.supersedesRefundId).toBe(r1Res.id);
    expect(r2Row.obligationId).not.toBeNull();

    const inspected = await harness.inspectionService.inspectByObligationId(r2Row.obligationId!);
    expect(inspected?.obligation.status).toBe(RefundObligationStatus.FULFILLED);
    expect(inspected?.obligation.fulfilledRefundId).toBe(r2Row.id);
    expect(inspected?.attempts.map((a) => [a.attemptSequence, a.status])).toEqual([
      [1, RefundAttemptStatus.FAILED],
      [2, RefundAttemptStatus.COMPLETED],
    ]);
  });

  it('8B. Releases capacity ONLY after dual-control VOID_OBLIGATION approval', async () => {
    const adminRole = await harness.prisma.role.upsert({
      where: { name: RoleName.ADMINISTRATOR },
      update: {},
      create: { name: RoleName.ADMINISTRATOR },
    });
    const seedAdmin = (tag: string) =>
      harness.prisma.user.create({
        data: {
          email: `cap_${tag}_${randomUUID().slice(0, 8)}@example.com`,
          passwordHash: 'hash',
          firstName: 'Admin',
          lastName: tag,
          phone: '+18765551999',
          status: UserStatus.ACTIVE,
          roles: { create: { roleId: adminRole.id } },
        },
      });
    const [adminRequester, adminApprover] = await Promise.all([
      seedAdmin('req'),
      seedAdmin('app'),
    ]);

    const { payment } = await harness.seedOrderWithPayment({ amount: '90.00' });
    const declineService = harness.createPaymentsService({
      refundPayment: jest.fn().mockResolvedValue({
        providerReference: 'gw-declined-void-test',
        status: 'FAILED',
      }),
    });
    const key = randomUUID();
    const failed = await declineService.refundByPaymentId(payment.id, 90, 'Declined before void', key);
    const refundRow = await harness.prisma.refund.findUniqueOrThrow({ where: { id: failed.id } });

    const approval = await harness.reconciliationRepo.requestApproval({
      obligationId: refundRow.obligationId!,
      refundId: refundRow.id,
      actionType: RefundReconciliationActionType.VOID_OBLIGATION,
      evidenceType: 'CUSTOMER_DECLINED_REMITTANCE',
      rawEvidence: { ticket: 'SUP-901' },
      rationale: 'Customer requested store credit instead of retrying refund',
      requestedByActorId: adminRequester.id,
    });

    // Self-approval blocked
    await expect(
      harness.reconciliationRepo.approveApproval({
        approvalId: approval.id,
        approvedByActorId: adminRequester.id,
      }),
    ).rejects.toThrow('Dual control violation');

    // Independent approver approves & voids obligation
    await harness.reconciliationRepo.approveApproval({
      approvalId: approval.id,
      approvedByActorId: adminApprover.id,
    });
    const voided = await harness.reconciliationRepo.voidObligationWithApproval({
      obligationId: refundRow.obligationId!,
      approvalId: approval.id,
      actor: { actorId: adminApprover.id, actorRole: 'ADMINISTRATOR' },
    });
    expect(voided.obligation?.status).toBe(RefundObligationStatus.CANCELLED_VOIDED);
    expect(voided.approval.status).toBe(RefundReconciliationApprovalStatus.APPLIED);

    // Unrelated refund can now claim the released $90 capacity cleanly
    const cleanService = harness.createPaymentsService();
    const rNew = await cleanService.refundByPaymentId(
      payment.id,
      90,
      'Post-void refund',
      randomUUID(),
    );
    expect(rNew.status).toBe(RefundStatus.COMPLETED);
  });

  it('9. Enforces cross-channel capacity competition and keeps cancelled late-settlement refund ref null', async () => {
    const { order, vendorOrders, payment } = await harness.seedOrderWithPayment({
      amount: '100.00',
      subtotals: ['60.00', '40.00'],
    });

    // Channel 1: Partial cancellation creates a $60 OPEN RefundObligation + REQUIRED refund
    await harness.prisma.$transaction(async (tx) => {
      const created = await createOrPreserveRefundObligation(
        tx,
        {
          id: payment.id,
          orderId: order.id,
          status: payment.status,
          amount: payment.amount,
          provider: payment.provider,
          currency: payment.currency,
        },
        [vendorOrders[0]!],
        `refund_vendor_order_cancel_${payment.id}_${vendorOrders[0]!.id}`,
        'Partial vendor order cancellation',
      );
      expect(created?.obligation?.authorizedAmount.toFixed(2)).toBe('60.00');
      expect(created?.refund.status).toBe(RefundStatus.REQUIRED);
    });

    // Channel 2: Manual admin request for $50 exceeds remaining $40 capacity
    const service = harness.createPaymentsService();
    await expect(
      service.refundByPaymentId(payment.id, 50, 'Over capacity vs cancel', randomUUID()),
    ).rejects.toThrow('Refund amount exceeds the remaining refundable balance');

    // Manual admin request for remaining $40 succeeds
    const r40 = await service.refundByPaymentId(payment.id, 40, 'Fits $40 remainder', randomUUID());
    expect(r40.status).toBe(RefundStatus.COMPLETED);

    // Channel 3: Late settlement for cancelled order MUST NOT store charge txn ID in refund.providerReference
    const cancelled = await harness.seedOrderWithPayment({
      amount: '55.00',
      paymentStatus: PaymentStatus.PENDING,
      providerReference: null,
    });
    await harness.prisma.vendorOrder.update({
      where: { id: cancelled.vendorOrders[0]!.id },
      data: { status: VendorOrderStatus.CANCELLED },
    });
    const chargeTxnId = `wipay-charge-${randomUUID()}`;
    const lateResult = await harness.settlementRepo.executeSettlementTransaction({
      orderId: cancelled.order.id,
      paymentId: cancelled.payment.id,
      provider: PaymentProviderName.CASH_ON_DELIVERY,
      merchantAccountId: 'default',
      eventId: `evt_${randomUUID()}`,
      gatewayTxnId: chargeTxnId,
      amount: new Prisma.Decimal('55.00'),
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        evidenceDigest: createHash('sha256').update(chargeTxnId).digest('hex'),
        rawPayload: { txn: chargeTxnId },
        eventTimestamp: new Date(),
      },
    });
    expect(lateResult.disposition).toBe(SettlementDisposition.SETTLED_AFTER_CANCELLATION);
    const lateRefund = await harness.prisma.refund.findUniqueOrThrow({
      where: { id: lateResult.refundId! },
    });
    expect(lateRefund.providerReference).toBeNull();
    expect(lateRefund.obligationId).not.toBeNull();
    const lateObl = await harness.prisma.refundObligation.findUniqueOrThrow({
      where: { id: lateRefund.obligationId! },
    });
    expect(lateObl.status).toBe(RefundObligationStatus.OPEN);
  });

  it('13. Serializes concurrent multi-worker cancellation, dispatch & lease sweep without deadlocks', async () => {
    const service = harness.createPaymentsService();

    for (let round = 0; round < 4; round++) {
      const { order, vendorOrders, payment } = await harness.seedOrderWithPayment({
        amount: '100.00',
        subtotals: ['50.00', '50.00'],
      });

      const outcomes = await Promise.allSettled([
        harness.prisma.$transaction(async (tx) => {
          await createOrPreserveRefundObligation(
            tx,
            {
              id: payment.id,
              orderId: order.id,
              status: payment.status,
              amount: payment.amount,
              provider: payment.provider,
              currency: payment.currency,
            },
            [vendorOrders[0]!],
            `refund_vendor_order_cancel_${payment.id}_${vendorOrders[0]!.id}`,
            'Concurrent cancel',
          );
        }),
        service.refundByPaymentId(payment.id, 60, 'Concurrent admin 60', randomUUID()),
        service.refundByPaymentId(payment.id, 60, 'Concurrent admin 60 B', randomUUID()),
        harness.inspectionService.quarantineExpiredDispatchingAttempts(new Date()),
      ]);

      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect(String(outcome.reason)).not.toContain('40P01');
        }
      }

      const obligations = await harness.prisma.refundObligation.findMany({
        where: { paymentId: payment.id, status: { not: RefundObligationStatus.CANCELLED_VOIDED } },
      });
      const obligatedSum = obligations.reduce(
        (sum, o) => sum.add(o.authorizedAmount),
        new Prisma.Decimal(0),
      );
      expect(obligatedSum.lte(payment.amount)).toBe(true);
    }
  });
});
