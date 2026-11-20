import { randomUUID } from 'crypto';

import {
  PaymentStatus,
  RefundEvidenceDisposition,
  RefundEvidenceProvenance,
} from '@prisma/client';

import { createRefundLedgerHarness, RefundLedgerHarness } from './refund-ledger-fixture.helper';

jest.setTimeout(120_000);

describe('Refund Attempt Ledger SQL Bypass & Trigger Guards (PG Suite)', () => {
  let harness: RefundLedgerHarness;

  beforeAll(async () => {
    harness = await createRefundLedgerHarness();
  });

  afterAll(async () => {
    await harness?.destroy();
  });

  it('12A. Blocks UPDATE/DELETE on append-only events and receipts, and DELETE on obligations/attempts', async () => {
    const { payment } = await harness.seedOrderWithPayment({ amount: '100.00' });
    const service = harness.createPaymentsService();
    const res = await service.refundByPaymentId(payment.id, 100, 'Immutability test', randomUUID());
    const refund = await harness.prisma.refund.findUniqueOrThrow({ where: { id: res.id } });
    const attempt = await harness.prisma.refundProviderAttempt.findFirstOrThrow({
      where: { refundId: refund.id },
    });
    const event = await harness.prisma.refundProviderAttemptEvent.findFirstOrThrow({
      where: { attemptId: attempt.id },
    });
    const receipt = await harness.reconciliationRepo.recordExternalEvidenceReceipt({
      provider: payment.provider,
      merchantAccountId: 'default',
      eventId: `ev_${randomUUID()}`,
      provenance: RefundEvidenceProvenance.AUTHENTICATED_WEBHOOK,
      disposition: RefundEvidenceDisposition.UNMATCHED_IGNORED,
      signatureValid: false,
      rawEvidence: { raw: true },
    });

    await expect(
      harness.prisma.$executeRawUnsafe(
        `UPDATE "refund_provider_attempt_events" SET "httpStatusCode" = 500 WHERE "id" = '${event.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      harness.prisma.$executeRawUnsafe(
        `DELETE FROM "refund_provider_attempt_events" WHERE "id" = '${event.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      harness.prisma.$executeRawUnsafe(
        `UPDATE "refund_evidence_receipts" SET "signatureValid" = true WHERE "id" = '${receipt.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      harness.prisma.$executeRawUnsafe(
        `DELETE FROM "refund_evidence_receipts" WHERE "id" = '${receipt.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      harness.prisma.$executeRawUnsafe(
        `DELETE FROM "refund_provider_attempts" WHERE "id" = '${attempt.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      harness.prisma.$executeRawUnsafe(
        `DELETE FROM "refund_obligations" WHERE "id" = '${refund.obligationId!}'`,
      ),
    ).rejects.toThrow();
  });

  it('12B. Enforces immutable digests/amounts and blocks over-obligation via raw SQL', async () => {
    const { order, payment } = await harness.seedOrderWithPayment({ amount: '100.00' });
    const prep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount: '60.00',
      reason: 'SQL bypass probe',
      idempotencyKey: randomUUID(),
    });
    const oblId = prep.obligation!.id;
    const attId = prep.attempt!.id;

    await expect(
      harness.prisma.$executeRawUnsafe(
        `UPDATE "refund_provider_attempts" SET "requestDigest" = repeat('0', 64) WHERE "id" = '${attId}'`,
      ),
    ).rejects.toThrow();
    await expect(
      harness.prisma.$executeRawUnsafe(
        `UPDATE "refund_obligations" SET "authorizedAmount" = 80.00 WHERE "id" = '${oblId}'`,
      ),
    ).rejects.toThrow();

    await expect(
      harness.prisma.$executeRawUnsafe(`
        INSERT INTO "refund_obligations"
          ("id","paymentId","orderId","obligationKey","obligationType","authorizedAmount","currency","reason","status")
        VALUES
          ('${randomUUID()}','${payment.id}','${order.id}','sql_overdraw_${randomUUID()}','ADMIN_EXCEPTIONAL_ADJUSTMENT',50.00,'JMD','Bypass','OPEN')
      `),
    ).rejects.toThrow();

    await expect(
      harness.prisma.$executeRawUnsafe(`
        UPDATE "refund_provider_attempts"
        SET "providerRefundReference" = '${payment.providerReference}'
        WHERE "id" = '${attId}'
      `),
    ).rejects.toThrow();
  });

  it('12C. Blocks forged quarantine exit, self-approval, unapproved voids, and native refund bypasses', async () => {
    const { payment } = await harness.seedOrderWithPayment({ amount: '100.00' });
    const prep = await harness.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount: '50.00',
      reason: 'Quarantine exit bypass probe',
      idempotencyKey: randomUUID(),
    });
    const attId = prep.attempt!.id;
    const refId = prep.refund!.id;
    const oblId = prep.obligation!.id;

    await harness.attemptsRepo.quarantineAttemptOutcome({
      attemptId: attId,
      paymentId: payment.id,
      failureClass: 'TRANSPORT_AMBIGUOUS',
      errorMessage: 'Lost socket',
    });

    await expect(
      harness.prisma.$executeRawUnsafe(`
        UPDATE "refund_provider_attempts"
        SET "status" = 'COMPLETED', "providerRefundReference" = 'forged-ref-1'
        WHERE "id" = '${attId}'
      `),
    ).rejects.toThrow();

    await expect(
      harness.prisma.$executeRawUnsafe(`
        UPDATE "refunds" SET "status" = 'COMPLETED' WHERE "id" = '${refId}'
      `),
    ).rejects.toThrow();

    await expect(
      harness.prisma.$executeRawUnsafe(`
        INSERT INTO "refund_reconciliation_approvals"
          ("id","obligationId","actionType","evidenceType","evidenceDigest","rationale","requestedByActorId","approvedByActorId","approvedAt","status")
        VALUES
          ('${randomUUID()}','${oblId}','VOID_OBLIGATION','MANUAL_REVIEW',repeat('a',64),'Self-approval bypass attempt','admin-1','admin-1',NOW(),'APPROVED')
      `),
    ).rejects.toThrow();

    await expect(
      harness.prisma.$executeRawUnsafe(`
        UPDATE "refund_obligations" SET "status" = 'CANCELLED_VOIDED' WHERE "id" = '${oblId}'
      `),
    ).rejects.toThrow();

    const { payment: p2 } = await harness.seedOrderWithPayment({ amount: '50.00' });
    const declineService = harness.createPaymentsService({
      refundPayment: jest.fn().mockResolvedValue({
        providerReference: 'gw-declined-sql-61',
        status: 'FAILED',
      }),
    });
    const failedRes = await declineService.refundByPaymentId(
      p2.id,
      50,
      'Preserved #61 terminality check',
      randomUUID(),
    );
    await expect(
      harness.prisma.$executeRawUnsafe(
        `UPDATE "refunds" SET "status" = 'COMPLETED' WHERE "id" = '${failedRes.id}'`,
      ),
    ).rejects.toThrow();
    expect(
      (await harness.prisma.payment.findUniqueOrThrow({ where: { id: p2.id } })).status,
    ).toBe(PaymentStatus.PAID);
  });
});
