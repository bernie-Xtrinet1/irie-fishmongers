import { Injectable, Optional } from '@nestjs/common';
import {
  RefundEvidenceDisposition,
  RefundEvidenceProvenance,
} from '@prisma/client';

import { RefundEvidenceRepository } from '../repositories/refund-evidence.repository';
import { computeEvidencePayloadDigest } from '../repositories/refund-locks.helper';
import {
  ProcessRefundEvidenceInput,
  ProcessRefundEvidenceResult,
  RefundEvidenceProcessingPolicy,
} from '../types/refund-reconciliation.types';

const DEFAULT_REFUND_EVIDENCE_POLICY: RefundEvidenceProcessingPolicy = {
  allowSimulatedEvidence: false,
  trustedWebhookAdapters: [],
  trustedStatusPollAdapters: [],
};

/**
 * Fail-closed processor for external refund evidence (authenticated webhooks
 * and verified read-only provider status polls). Mirrors PaymentSettlementProcessorService
 * provenance, adapter verification, and SHA-256 digest guarantees.
 */
@Injectable()
export class RefundEvidenceProcessorService {
  private readonly policy: RefundEvidenceProcessingPolicy;

  constructor(
    private readonly refundEvidenceRepository: RefundEvidenceRepository,
    @Optional() policy?: Partial<RefundEvidenceProcessingPolicy>,
  ) {
    this.policy = {
      allowSimulatedEvidence:
        policy?.allowSimulatedEvidence ?? DEFAULT_REFUND_EVIDENCE_POLICY.allowSimulatedEvidence,
      trustedWebhookAdapters:
        policy?.trustedWebhookAdapters ?? DEFAULT_REFUND_EVIDENCE_POLICY.trustedWebhookAdapters,
      trustedStatusPollAdapters:
        policy?.trustedStatusPollAdapters ??
        DEFAULT_REFUND_EVIDENCE_POLICY.trustedStatusPollAdapters,
    };
  }

  async processEvidence(
    input: ProcessRefundEvidenceInput,
    policyOverride?: Partial<RefundEvidenceProcessingPolicy>,
  ): Promise<ProcessRefundEvidenceResult> {
    const activePolicy: RefundEvidenceProcessingPolicy = {
      allowSimulatedEvidence:
        policyOverride?.allowSimulatedEvidence ?? this.policy.allowSimulatedEvidence,
      trustedWebhookAdapters:
        policyOverride?.trustedWebhookAdapters ?? this.policy.trustedWebhookAdapters,
      trustedStatusPollAdapters:
        policyOverride?.trustedStatusPollAdapters ?? this.policy.trustedStatusPollAdapters,
    };

    const computedDigest = computeEvidencePayloadDigest(input.evidence.rawPayload);

    const provenanceRejection = this.validateProvenanceAndTrust(input, activePolicy);
    if (provenanceRejection) {
      return this.refundEvidenceRepository.recordUnauthenticatedOrMalformedReceipt(
        input,
        RefundEvidenceDisposition.SIGNATURE_REJECTED,
        computedDigest,
        provenanceRejection,
      );
    }

    const suppliedDigest = input.evidence.evidenceDigest?.trim().toLowerCase() ?? '';
    if (!/^[0-9a-f]{64}$/.test(suppliedDigest) || suppliedDigest !== computedDigest) {
      return this.refundEvidenceRepository.recordUnauthenticatedOrMalformedReceipt(
        input,
        RefundEvidenceDisposition.CONFLICT_REJECTED,
        computedDigest,
        `Evidence digest mismatch: supplied digest does not match SHA-256 of raw payload`,
      );
    }

    return this.refundEvidenceRepository.applyVerifiedEvidence(input, computedDigest);
  }

  private validateProvenanceAndTrust(
    input: ProcessRefundEvidenceInput,
    policy: RefundEvidenceProcessingPolicy,
  ): string | null {
    const { provenance, signatureValid, verification, eventId } = input.evidence;

    if (!eventId || eventId.trim().length === 0) {
      return 'Missing non-empty external evidence eventId';
    }

    if (
      provenance !== RefundEvidenceProvenance.AUTHENTICATED_WEBHOOK &&
      provenance !== RefundEvidenceProvenance.VERIFIED_STATUS_POLL
    ) {
      if (!policy.allowSimulatedEvidence) {
        return `Rejected non-external provenance "${provenance}" when allowSimulatedEvidence=false`;
      }
      if (signatureValid !== true) {
        return `Simulated evidence with provenance "${provenance}" requires signatureValid=true`;
      }
      return null;
    }

    if (signatureValid !== true) {
      return `Rejected ${provenance} evidence without signatureValid=true`;
    }

    if (!verification || !verification.verifiedByAdapter?.trim()) {
      return `Rejected ${provenance} evidence without adapter verification metadata`;
    }

    const adapterName = verification.verifiedByAdapter.trim();
    const token = verification.adapterVerificationToken?.trim();
    if (!token) {
      return `Rejected ${provenance} evidence missing adapterVerificationToken`;
    }

    if (provenance === RefundEvidenceProvenance.AUTHENTICATED_WEBHOOK) {
      if (!policy.trustedWebhookAdapters.includes(adapterName)) {
        return `Webhook adapter "${adapterName}" is not in trustedWebhookAdapters policy`;
      }
      return null;
    }

    if (!policy.trustedStatusPollAdapters.includes(adapterName)) {
      return `Status poll adapter "${adapterName}" is not in trustedStatusPollAdapters policy`;
    }
    return null;
  }
}
