import {
  PaymentProviderName,
  RefundEvidenceDisposition,
  RefundEvidenceProvenance,
} from '@prisma/client';

import { RefundEvidenceRepository } from '../repositories/refund-evidence.repository';
import { computeEvidencePayloadDigest } from '../repositories/refund-locks.helper';
import { RefundEvidenceProcessorService } from './refund-evidence-processor.service';

describe('RefundEvidenceProcessorService (Unit)', () => {
  const buildRepoMock = () => {
    const recordUnauthenticatedOrMalformedReceipt = jest.fn().mockResolvedValue({
      applied: false,
      disposition: RefundEvidenceDisposition.SIGNATURE_REJECTED,
      receiptId: 'rcpt-1',
      quarantined: false,
      message: 'rejected',
    });
    const applyVerifiedEvidence = jest.fn().mockResolvedValue({
      applied: true,
      disposition: RefundEvidenceDisposition.APPLIED,
      receiptId: 'rcpt-2',
      quarantined: false,
      message: 'applied',
    });
    const repo = {
      recordUnauthenticatedOrMalformedReceipt,
      applyVerifiedEvidence,
    } as unknown as RefundEvidenceRepository;
    return { repo, recordUnauthenticatedOrMalformedReceipt, applyVerifiedEvidence };
  };

  const basePayload = { outcome: 'COMPLETED', amount: '50.00' };
  const baseDigest = computeEvidencePayloadDigest(basePayload);

  it('rejects simulated or untrusted provenance by default (allowSimulatedEvidence=false)', async () => {
    const { repo, recordUnauthenticatedOrMalformedReceipt, applyVerifiedEvidence } =
      buildRepoMock();
    const service = new RefundEvidenceProcessorService(repo);

    await service.processEvidence({
      attemptId: 'att-1',
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      providerRefundReference: 'ref-1',
      amount: '50.00',
      currency: 'JMD',
      outcome: 'COMPLETED',
      evidence: {
        provenance: RefundEvidenceProvenance.APPLICATION_SYNC_RESPONSE,
        eventId: 'evt-sim-1',
        rawPayload: basePayload,
        evidenceDigest: baseDigest,
        eventTimestamp: new Date(),
        signatureValid: true,
      },
    });

    expect(recordUnauthenticatedOrMalformedReceipt).toHaveBeenCalledWith(
      expect.anything(),
      RefundEvidenceDisposition.SIGNATURE_REJECTED,
      baseDigest,
      expect.stringContaining('allowSimulatedEvidence=false'),
    );
    expect(applyVerifiedEvidence).not.toHaveBeenCalled();
  });

  it('rejects AUTHENTICATED_WEBHOOK when adapter is not in trustedWebhookAdapters', async () => {
    const { repo, recordUnauthenticatedOrMalformedReceipt, applyVerifiedEvidence } =
      buildRepoMock();
    const service = new RefundEvidenceProcessorService(repo);

    await service.processEvidence({
      attemptId: 'att-1',
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      providerRefundReference: 'ref-1',
      amount: '50.00',
      currency: 'JMD',
      outcome: 'COMPLETED',
      evidence: {
        provenance: RefundEvidenceProvenance.AUTHENTICATED_WEBHOOK,
        eventId: 'evt-untrusted-1',
        rawPayload: basePayload,
        evidenceDigest: baseDigest,
        eventTimestamp: new Date(),
        signatureValid: true,
        verification: {
          verifiedByAdapter: 'ROGUE_ADAPTER',
          adapterVerificationToken: 'tok-1',
          verifiedAt: new Date(),
        },
      },
    });

    expect(recordUnauthenticatedOrMalformedReceipt).toHaveBeenCalledWith(
      expect.anything(),
      RefundEvidenceDisposition.SIGNATURE_REJECTED,
      baseDigest,
      expect.stringContaining('trustedWebhookAdapters'),
    );
    expect(applyVerifiedEvidence).not.toHaveBeenCalled();
  });

  it('rejects digest tampering before hitting repository mutation', async () => {
    const { repo, recordUnauthenticatedOrMalformedReceipt, applyVerifiedEvidence } =
      buildRepoMock();
    const service = new RefundEvidenceProcessorService(repo, {
      trustedWebhookAdapters: ['TRUSTED_HOOK'],
    });

    await service.processEvidence({
      attemptId: 'att-1',
      provider: PaymentProviderName.CASH_ON_DELIVERY,
      merchantAccountId: 'default',
      providerRefundReference: 'ref-1',
      amount: '50.00',
      currency: 'JMD',
      outcome: 'COMPLETED',
      evidence: {
        provenance: RefundEvidenceProvenance.AUTHENTICATED_WEBHOOK,
        eventId: 'evt-tamper-1',
        rawPayload: basePayload,
        evidenceDigest: '0'.repeat(64),
        eventTimestamp: new Date(),
        signatureValid: true,
        verification: {
          verifiedByAdapter: 'TRUSTED_HOOK',
          adapterVerificationToken: 'tok-1',
          verifiedAt: new Date(),
        },
      },
    });

    expect(recordUnauthenticatedOrMalformedReceipt).toHaveBeenCalledWith(
      expect.anything(),
      RefundEvidenceDisposition.CONFLICT_REJECTED,
      baseDigest,
      expect.stringContaining('digest mismatch'),
    );
    expect(applyVerifiedEvidence).not.toHaveBeenCalled();
  });
});
