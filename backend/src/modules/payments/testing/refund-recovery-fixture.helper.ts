import { randomUUID } from 'crypto';

import {
  PaymentProviderName,
  RefundEvidenceProvenance,
} from '@prisma/client';

import { CashOnDeliveryAdapter } from '../providers/cash-on-delivery.adapter';
import { WiPayAdapter } from '../providers/wipay.adapter';
import { RefundEvidenceRepository } from '../repositories/refund-evidence.repository';
import { computeEvidencePayloadDigest } from '../repositories/refund-locks.helper';
import { RefundRecoveryRepository } from '../repositories/refund-recovery.repository';
import { RefundEvidenceProcessorService } from '../services/refund-evidence-processor.service';
import { RefundOutboxService } from '../services/refund-outbox.service';
import { RefundRecoveryService } from '../services/refund-recovery.service';
import { RefundStatusReconciliationService } from '../services/refund-status-reconciliation.service';
import { ProcessRefundEvidenceInput } from '../types/refund-reconciliation.types';
import { createRefundLedgerHarness, RefundLedgerHarness } from './refund-ledger-fixture.helper';

export interface RefundRecoveryHarness extends RefundLedgerHarness {
  recoveryRepo: RefundRecoveryRepository;
  recoveryService: RefundRecoveryService;
  evidenceRepo: RefundEvidenceRepository;
  evidenceProcessor: RefundEvidenceProcessorService;
  statusReconciliationService: RefundStatusReconciliationService;
  outboxService: RefundOutboxService;
  defaultEvidenceProcessor: RefundEvidenceProcessorService;
  defaultOutboxService: RefundOutboxService;
  buildWebhookEvidenceInput: (params: {
    attemptId?: string | null;
    obligationId?: string | null;
    provider?: PaymentProviderName;
    merchantAccountId?: string;
    parentPaymentReference?: string | null;
    providerRefundReference?: string | null;
    providerIdempotencyKey?: string | null;
    amount: string | number;
    currency?: string;
    outcome: 'COMPLETED' | 'PENDING' | 'FAILED';
    eventId?: string;
    signatureValid?: boolean;
    provenance?: RefundEvidenceProvenance;
    verifiedByAdapter?: string;
    adapterVerificationToken?: string;
    overrideDigest?: string;
    rawPayloadExtra?: Record<string, unknown>;
  }) => ProcessRefundEvidenceInput;
}

export async function createRefundRecoveryHarness(): Promise<RefundRecoveryHarness> {
  const base = await createRefundLedgerHarness();
  const recoveryRepo = new RefundRecoveryRepository(base.prisma);
  const recoveryService = new RefundRecoveryService(recoveryRepo);
  const evidenceRepo = new RefundEvidenceRepository(base.prisma);

  const evidenceProcessor = new RefundEvidenceProcessorService(evidenceRepo, {
    allowSimulatedEvidence: false,
    trustedWebhookAdapters: ['WEBHOOK_GATEWAY_ADAPTER'],
    trustedStatusPollAdapters: ['MOCK_STATUS_ADAPTER', 'CASH_ON_DELIVERY'],
  });
  const defaultEvidenceProcessor = new RefundEvidenceProcessorService(evidenceRepo);

  const statusReconciliationService = new RefundStatusReconciliationService(
    base.prisma,
    evidenceProcessor,
    new WiPayAdapter(null as never),
    new CashOnDeliveryAdapter(),
  );
  const outboxService = new RefundOutboxService(base.prisma, { allowNotificationDispatch: true });
  const defaultOutboxService = new RefundOutboxService(base.prisma);

  const buildWebhookEvidenceInput: RefundRecoveryHarness['buildWebhookEvidenceInput'] = (
    params,
  ) => {
    const eventId = params.eventId ?? `evt-${randomUUID()}`;
    const rawPayload: Record<string, unknown> = {
      eventId,
      attemptId: params.attemptId ?? null,
      providerRefundReference: params.providerRefundReference ?? null,
      outcome: params.outcome,
      amount: String(params.amount),
      currency: params.currency ?? 'JMD',
      ...(params.rawPayloadExtra ?? {}),
    };
    const evidenceDigest = params.overrideDigest ?? computeEvidencePayloadDigest(rawPayload);

    return {
      attemptId: params.attemptId,
      obligationId: params.obligationId,
      provider: params.provider ?? PaymentProviderName.CASH_ON_DELIVERY,
      merchantAccountId: params.merchantAccountId ?? 'default',
      parentPaymentReference: params.parentPaymentReference,
      providerRefundReference: params.providerRefundReference,
      providerIdempotencyKey: params.providerIdempotencyKey,
      amount: params.amount,
      currency: params.currency ?? 'JMD',
      outcome: params.outcome,
      httpStatusCode: 200,
      evidence: {
        provenance: params.provenance ?? RefundEvidenceProvenance.AUTHENTICATED_WEBHOOK,
        eventId,
        rawPayload,
        evidenceDigest,
        eventTimestamp: new Date(),
        sourceIp: '10.0.0.10',
        signatureValid: params.signatureValid ?? true,
        verification: {
          verifiedByAdapter: params.verifiedByAdapter ?? 'WEBHOOK_GATEWAY_ADAPTER',
          adapterVerificationToken: params.adapterVerificationToken ?? `sig-${eventId}`,
          verifiedAt: new Date(),
        },
      },
    };
  };

  return {
    ...base,
    recoveryRepo,
    recoveryService,
    evidenceRepo,
    evidenceProcessor,
    statusReconciliationService,
    outboxService,
    defaultEvidenceProcessor,
    defaultOutboxService,
    buildWebhookEvidenceInput,
  };
}
