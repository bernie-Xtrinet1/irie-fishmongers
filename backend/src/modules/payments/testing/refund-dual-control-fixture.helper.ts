import { randomUUID } from 'crypto';

import {
  PaymentProviderName,
  RefundAttemptFailureClass,
  RefundAttemptStatus,
  RefundEvidenceDisposition,
  RefundEvidenceProvenance,
  RefundObligationStatus,
  RefundStatus,
  RoleName,
  User,
  UserStatus,
} from '@prisma/client';

import { RefundDualControlRepository } from '../repositories/refund-dual-control.repository';
import { sha256Hex } from '../repositories/refund-locks.helper';
import { RefundDualControlReconciliationService } from '../services/refund-dual-control-reconciliation.service';
import {
  createRefundLedgerHarness,
  RefundLedgerHarness,
} from './refund-ledger-fixture.helper';

export interface DualControlTestFixture {
  ledger: RefundLedgerHarness;
  dualControlRepo: RefundDualControlRepository;
  service: RefundDualControlReconciliationService;
  adminA: User;
  adminB: User;
  adminC: User;
  seedAdminUser: (tag: string, opts?: { status?: UserStatus; role?: RoleName }) => Promise<User>;
  seedQuarantinedCase: (opts?: {
    amount?: string;
    attemptStatus?: RefundAttemptStatus;
    obligationStatus?: RefundObligationStatus;
    refundStatus?: RefundStatus;
    provider?: PaymentProviderName;
    merchantAccountId?: string;
    providerReference?: string;
  }) => Promise<{
    paymentId: string;
    obligationId: string;
    refundId: string;
    attemptId: string;
    merchantAccountId: string;
    providerReference: string;
  }>;
  seedEvidenceReceipt: (params: {
    obligationId: string;
    attemptId?: string | null;
    refundId?: string | null;
    provider?: PaymentProviderName;
    merchantAccountId?: string;
    disposition?: RefundEvidenceDisposition;
    provenance?: RefundEvidenceProvenance;
    signatureValid?: boolean;
    providerRefundReference?: string | null;
    rawEvidence?: Record<string, unknown>;
    receivedAt?: Date;
  }) => Promise<{ id: string; evidenceDigest: string }>;
  destroy: () => Promise<void>;
}

export async function createDualControlTestFixture(): Promise<DualControlTestFixture> {
  const ledger = await createRefundLedgerHarness();
  const dualControlRepo = new RefundDualControlRepository(ledger.prisma);
  const service = new RefundDualControlReconciliationService(dualControlRepo);

  const roles = await Promise.all([
    ledger.prisma.role.upsert({
      where: { name: RoleName.ADMINISTRATOR },
      update: {},
      create: { name: RoleName.ADMINISTRATOR },
    }),
    ledger.prisma.role.upsert({
      where: { name: RoleName.CUSTOMER },
      update: {},
      create: { name: RoleName.CUSTOMER },
    }),
  ]);
  const roleMap = new Map<RoleName, string>(roles.map((r) => [r.name, r.id]));

  const seedAdminUser: DualControlTestFixture['seedAdminUser'] = async (tag, opts = {}) => {
    const roleName = opts.role ?? RoleName.ADMINISTRATOR;
    const roleId = roleMap.get(roleName)!;
    return ledger.prisma.user.create({
      data: {
        email: `dc_${tag}_${randomUUID().slice(0, 8)}@example.com`,
        passwordHash: '$2b$10$fixedtesthashfixedtesthashfixedtesthashfixedtesthas',
        firstName: 'DualControl',
        lastName: tag,
        phone: '+18765558800',
        status: opts.status ?? UserStatus.ACTIVE,
        roles: { create: { roleId } },
      },
    });
  };

  const [adminA, adminB, adminC] = await Promise.all([
    seedAdminUser('adminA'),
    seedAdminUser('adminB'),
    seedAdminUser('adminC'),
  ]);

  const seedQuarantinedCase: DualControlTestFixture['seedQuarantinedCase'] = async (opts = {}) => {
    const amount = opts.amount ?? '80.00';
    const provider = opts.provider ?? PaymentProviderName.CASH_ON_DELIVERY;
    const providerReference = opts.providerReference ?? `chg-${randomUUID().slice(0, 8)}`;
    const { payment } = await ledger.seedOrderWithPayment({
      amount,
      provider,
      providerReference,
    });
    const paymentRow = await ledger.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });

    const prep = await ledger.attemptsRepo.prepareAndClaimAttempt({
      paymentId: payment.id,
      amount,
      reason: 'Dual-control quarantine scenario',
      idempotencyKey: randomUUID(),
    });

    const attStatus = opts.attemptStatus ?? RefundAttemptStatus.AMBIGUOUS_OUTCOME;
    if (attStatus === RefundAttemptStatus.AMBIGUOUS_OUTCOME) {
      await ledger.attemptsRepo.quarantineAttemptOutcome({
        attemptId: prep.attempt!.id,
        paymentId: payment.id,
        failureClass: RefundAttemptFailureClass.TRANSPORT_AMBIGUOUS,
        errorMessage: 'Gateway timeout during refund',
      });
    } else if (attStatus !== RefundAttemptStatus.DISPATCHING) {
      await ledger.prisma.refundProviderAttempt.update({
        where: { id: prep.attempt!.id },
        data: { status: attStatus },
      });
    }

    if (opts.obligationStatus) {
      await ledger.prisma.refundObligation.update({
        where: { id: prep.obligation!.id },
        data: { status: opts.obligationStatus },
      });
    }
    if (opts.refundStatus) {
      await ledger.prisma.refund.update({
        where: { id: prep.refund!.id },
        data: { status: opts.refundStatus },
      });
    }

    return {
      paymentId: payment.id,
      obligationId: prep.obligation!.id,
      refundId: prep.refund!.id,
      attemptId: prep.attempt!.id,
      merchantAccountId: paymentRow.merchantAccountId,
      providerReference,
    };
  };

  const seedEvidenceReceipt: DualControlTestFixture['seedEvidenceReceipt'] = async (params) => {
    const raw = params.rawEvidence ?? { portalTicket: `PORTAL-${randomUUID().slice(0, 8)}` };
    const digest = sha256Hex(raw);
    const created = await ledger.prisma.refundEvidenceReceipt.create({
      data: {
        id: randomUUID(),
        provider: params.provider ?? PaymentProviderName.CASH_ON_DELIVERY,
        merchantAccountId: params.merchantAccountId ?? 'cash-on-delivery-local',
        eventId: `evt-${randomUUID()}`,
        providerRefundReference: params.providerRefundReference ?? null,
        attemptId: params.attemptId ?? null,
        refundId: params.refundId ?? null,
        obligationId: params.obligationId,
        provenance: params.provenance ?? RefundEvidenceProvenance.DUAL_CONTROL_ADMIN_RECONCILIATION,
        disposition: params.disposition ?? RefundEvidenceDisposition.APPLIED,
        signatureValid: params.signatureValid ?? true,
        evidenceDigest: digest,
        receivedAt: params.receivedAt ?? new Date(),
      },
    });
    return { id: created.id, evidenceDigest: created.evidenceDigest };
  };

  return {
    ledger,
    dualControlRepo,
    service,
    adminA,
    adminB,
    adminC,
    seedAdminUser,
    seedQuarantinedCase,
    seedEvidenceReceipt,
    destroy: () => ledger.destroy(),
  };
}
