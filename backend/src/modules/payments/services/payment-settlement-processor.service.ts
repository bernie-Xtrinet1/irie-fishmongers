import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentStatus,
  SettlementDisposition,
  SettlementEvidenceProvenance,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { PaymentSettlementRepository } from '../repositories/payment-settlement.repository';
import {
  ApplyPaymentSettlementCommand,
  SettlementExecutionResult,
  SettlementVerificationPolicy,
} from '../types/payment-settlement.types';

@Injectable()
export class PaymentSettlementProcessorService {
  private readonly logger = new Logger(PaymentSettlementProcessorService.name);
  private readonly policy: SettlementVerificationPolicy;

  constructor(
    private readonly settlementRepository: PaymentSettlementRepository,
    private readonly prisma: PrismaService,
    policy?: Partial<SettlementVerificationPolicy>,
  ) {
    this.policy = {
      allowSimulator: policy?.allowSimulator ?? false,
      allowAdminOverride: policy?.allowAdminOverride ?? false,
    };
  }

  async applySettlement(command: ApplyPaymentSettlementCommand): Promise<SettlementExecutionResult> {
    const provenance = command.evidence.provenance;

    // 1. Provisional Browser Return
    // Browser return signals return of user, but MUST NOT establish settlement authority
    if (provenance === SettlementEvidenceProvenance.PROVISIONAL_BROWSER_RETURN) {
      const receipt = await this.settlementRepository.recordReceipt({
        provider: command.provider,
        merchantAccountId: command.merchantAccountId,
        eventId: command.eventId,
        gatewayTxnId: command.gatewayTxnId,
        disposition: SettlementDisposition.PROVISIONAL_RECORDED,
        sourceIp: command.evidence.sourceIp,
        signatureValid: command.evidence.signatureValid ?? false,
      });

      const payment = await this.prisma.payment.findUnique({
        where: { id: command.paymentId },
        select: { status: true },
      });

      return {
        applied: false,
        disposition: SettlementDisposition.PROVISIONAL_RECORDED,
        paymentId: command.paymentId,
        orderId: command.orderId,
        resultingPaymentStatus: payment?.status ?? PaymentStatus.PENDING,
        receiptId: receipt.id,
        message:
          'Provisional browser return recorded. Authoritative settlement deferred to provider verification.',
      };
    }

    // 2. Admin Override Fail-Closed Guard
    // Administrative settlement overrides are permanently disabled
    if (provenance === SettlementEvidenceProvenance.ADMIN_OVERRIDE) {
      const receipt = await this.settlementRepository.recordReceipt({
        provider: command.provider,
        merchantAccountId: command.merchantAccountId,
        eventId: command.eventId,
        gatewayTxnId: command.gatewayTxnId,
        disposition: SettlementDisposition.CONFLICT_REJECTED,
        sourceIp: command.evidence.sourceIp,
        signatureValid: false,
      });

      const payment = await this.prisma.payment.findUnique({
        where: { id: command.paymentId },
        select: { status: true },
      });

      return {
        applied: false,
        disposition: SettlementDisposition.CONFLICT_REJECTED,
        paymentId: command.paymentId,
        orderId: command.orderId,
        resultingPaymentStatus: payment?.status ?? PaymentStatus.PENDING,
        receiptId: receipt.id,
        message:
          'Admin override settlement rejected: administrative settlement overrides are permanently disabled.',
      };
    }

    // 3. Simulator Authority Guard
    // Simulator authority may execute ONLY through a demonstrably isolated test-only capability.
    // It is strictly forbidden through production dependency injection or public service entry points.
    if (provenance === SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR) {
      const receipt = await this.settlementRepository.recordReceipt({
        provider: command.provider,
        merchantAccountId: command.merchantAccountId,
        eventId: command.eventId,
        gatewayTxnId: command.gatewayTxnId,
        disposition: SettlementDisposition.CONFLICT_REJECTED,
        sourceIp: command.evidence.sourceIp,
        signatureValid: false,
      });

      const payment = await this.prisma.payment.findUnique({
        where: { id: command.paymentId },
        select: { status: true },
      });

      return {
        applied: false,
        disposition: SettlementDisposition.CONFLICT_REJECTED,
        paymentId: command.paymentId,
        orderId: command.orderId,
        resultingPaymentStatus: payment?.status ?? PaymentStatus.PENDING,
        receiptId: receipt.id,
        message: 'Simulator authority is inaccessible through production service entry points.',
      };
    }

    // 4. Authenticated Webhook & Verified Status Poll Authority Gates
    // F-01 Correction:
    // A. Missing signature verification must fail closed.
    // B. Caller-supplied signatureValid: true must NOT establish authority alone.
    // C. AUTHENTICATED_WEBHOOK requires verification by a registered trusted webhook verification adapter.
    // D. VERIFIED_STATUS_POLL requires verification by a registered trusted provider-status verification adapter.
    // E. Production calls without independently verified authority must fail closed.
    if (provenance === SettlementEvidenceProvenance.AUTHENTICATED_WEBHOOK) {
      const isVerified =
        command.evidence.signatureValid === true &&
        Boolean(command.evidence.verification?.verifiedByAdapter) &&
        this.isTrustedWebhookAdapter(command.evidence.verification!.verifiedByAdapter);

      if (!isVerified) {
        const receipt = await this.settlementRepository.recordReceipt({
          provider: command.provider,
          merchantAccountId: command.merchantAccountId,
          eventId: command.eventId,
          gatewayTxnId: command.gatewayTxnId,
          disposition: SettlementDisposition.CONFLICT_REJECTED,
          sourceIp: command.evidence.sourceIp,
          signatureValid: false,
        });

        const payment = await this.prisma.payment.findUnique({
          where: { id: command.paymentId },
          select: { status: true },
        });

        return {
          applied: false,
          disposition: SettlementDisposition.CONFLICT_REJECTED,
          paymentId: command.paymentId,
          orderId: command.orderId,
          resultingPaymentStatus: payment?.status ?? PaymentStatus.PENDING,
          receiptId: receipt.id,
          message:
            'Authenticated webhook authority rejected: requires verification by a registered trusted webhook verification adapter.',
        };
      }
    }

    if (provenance === SettlementEvidenceProvenance.VERIFIED_STATUS_POLL) {
      const isVerified =
        command.evidence.signatureValid === true &&
        Boolean(command.evidence.verification?.verifiedByAdapter) &&
        this.isTrustedStatusPollAdapter(command.evidence.verification!.verifiedByAdapter);

      if (!isVerified) {
        const receipt = await this.settlementRepository.recordReceipt({
          provider: command.provider,
          merchantAccountId: command.merchantAccountId,
          eventId: command.eventId,
          gatewayTxnId: command.gatewayTxnId,
          disposition: SettlementDisposition.CONFLICT_REJECTED,
          sourceIp: command.evidence.sourceIp,
          signatureValid: false,
        });

        const payment = await this.prisma.payment.findUnique({
          where: { id: command.paymentId },
          select: { status: true },
        });

        return {
          applied: false,
          disposition: SettlementDisposition.CONFLICT_REJECTED,
          paymentId: command.paymentId,
          orderId: command.orderId,
          resultingPaymentStatus: payment?.status ?? PaymentStatus.PENDING,
          receiptId: receipt.id,
          message:
            'Verified status poll authority rejected: requires verification by a registered trusted status verification adapter.',
        };
      }
    }

    // 5. Evidence Digest Verification (Data Integrity Guard)
    const payloadStr =
      typeof command.evidence.rawPayload === 'string'
        ? command.evidence.rawPayload
        : JSON.stringify(command.evidence.rawPayload);
    const computedDigest = createHash('sha256').update(payloadStr, 'utf8').digest('hex');

    if (command.evidence.evidenceDigest !== computedDigest) {
      const receipt = await this.settlementRepository.recordReceipt({
        provider: command.provider,
        merchantAccountId: command.merchantAccountId,
        eventId: command.eventId,
        gatewayTxnId: command.gatewayTxnId,
        disposition: SettlementDisposition.CONFLICT_REJECTED,
        sourceIp: command.evidence.sourceIp,
        signatureValid: false,
      });

      const payment = await this.prisma.payment.findUnique({
        where: { id: command.paymentId },
        select: { status: true },
      });

      return {
        applied: false,
        disposition: SettlementDisposition.CONFLICT_REJECTED,
        paymentId: command.paymentId,
        orderId: command.orderId,
        resultingPaymentStatus: payment?.status ?? PaymentStatus.PENDING,
        receiptId: receipt.id,
        message: 'Settlement evidence digest mismatch: payload has been modified or corrupted.',
      };
    }

    // 6. Delegate to Locked Financial Mutation Repository
    return this.settlementRepository.executeSettlementTransaction(command);
  }

  /**
   * Evaluates whether an adapter name corresponds to a registered trusted webhook verification adapter.
   * In this pre-gateway release, no live external adapters are registered, ensuring complete fail-closed behavior.
   */
  private isTrustedWebhookAdapter(_adapterName: string): boolean {
    return false;
  }

  /**
   * Evaluates whether an adapter name corresponds to a registered trusted status poll adapter.
   * In this pre-gateway release, no live external adapters are registered, ensuring complete fail-closed behavior.
   */
  private isTrustedStatusPollAdapter(_adapterName: string): boolean {
    return false;
  }
}
