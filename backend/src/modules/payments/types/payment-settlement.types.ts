import {
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  RefundStatus,
  SettlementDisposition,
  SettlementEvidenceProvenance,
} from '@prisma/client';

export {
  PaymentProviderName,
  PaymentStatus,
  RefundStatus,
  SettlementDisposition,
  SettlementEvidenceProvenance,
};

export interface SettlementAuthorityVerification {
  verifiedByAdapter: string; // Identifier of the registered trusted verification adapter
  adapterVerificationToken: string; // Cryptographic verification proof emitted by the adapter
  providerSignature?: string; // Raw upstream provider signature/HMAC
  verifiedAt: Date;
}

export interface SettlementEvidence {
  provenance: SettlementEvidenceProvenance;
  rawPayload: Record<string, unknown> | string;
  evidenceDigest: string; // SHA-256 hex digest of the authentic raw payload
  eventTimestamp: Date;
  sourceIp?: string;
  signatureValid?: boolean; // Caller declaration (NOT authoritative without adapter verification)
  verification?: SettlementAuthorityVerification; // Verified adapter proof
  securityToken?: string; // Internal verification token or environment guard
}

export interface ApplyPaymentSettlementCommand {
  provider: PaymentProviderName;
  merchantAccountId: string;
  eventId: string;
  paymentId: string;
  orderId: string;
  checkoutAttemptId?: string | null;
  gatewayTxnId: string;
  amount: number | string | Prisma.Decimal;
  currency: string;
  outcome: PaymentStatus; // Authoritative outcome (PAID or FAILED)
  evidence: SettlementEvidence;
}

export interface SettlementExecutionResult {
  applied: boolean;
  disposition: SettlementDisposition;
  paymentId: string;
  orderId: string;
  resultingPaymentStatus: PaymentStatus;
  settlementEventId?: string;
  receiptId?: string;
  refundId?: string;
  refundStatus?: RefundStatus;
  outboxEventId?: string;
  message: string;
}

export interface SettlementVerificationPolicy {
  allowSimulator: boolean;
  allowAdminOverride: boolean;
}
