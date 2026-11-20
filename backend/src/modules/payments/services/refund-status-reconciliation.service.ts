import { Inject, Injectable, NotImplementedException, Optional } from '@nestjs/common';
import {
  PaymentProviderName,
  RefundAttemptStatus,
  RefundEvidenceProvenance,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { PaymentProviderAdapter } from '../interfaces/payment-provider.interface';
import { CashOnDeliveryAdapter } from '../providers/cash-on-delivery.adapter';
import { WiPayAdapter } from '../providers/wipay.adapter';
import { computeEvidencePayloadDigest } from '../repositories/refund-locks.helper';
import {
  ProcessRefundEvidenceResult,
  ReconcileRefundAttemptStatusResult,
  RefundEvidenceProcessingPolicy,
} from '../types/refund-reconciliation.types';
import { RefundEvidenceProcessorService } from './refund-evidence-processor.service';

export interface RefundStatusReconciliationOptions {
  lockDurationMs?: number;
  adapterOverrides?: Partial<Record<PaymentProviderName, PaymentProviderAdapter>>;
  evidencePolicyOverride?: Partial<RefundEvidenceProcessingPolicy>;
  referenceTime?: Date;
}

const DEFAULT_POLL_LOCK_MS = 30_000;

/**
 * Internal read-only reconciliation service for polling provider refund status.
 * Strictly prohibits issuing new refundPayment calls, enforces bounded poll
 * leases via pollLockUntil CAS, and fails closed for unsupported providers (WiPay).
 */
@Injectable()
export class RefundStatusReconciliationService {
  private readonly defaultAdapters: Map<PaymentProviderName, PaymentProviderAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly evidenceProcessor: RefundEvidenceProcessorService,
    @Optional() @Inject(WiPayAdapter) wiPayAdapter?: WiPayAdapter,
    @Optional() @Inject(CashOnDeliveryAdapter) codAdapter?: CashOnDeliveryAdapter,
  ) {
    this.defaultAdapters = new Map<PaymentProviderName, PaymentProviderAdapter>();
    if (wiPayAdapter) {
      this.defaultAdapters.set(PaymentProviderName.WIPAY, wiPayAdapter);
    }
    if (codAdapter) {
      this.defaultAdapters.set(PaymentProviderName.CASH_ON_DELIVERY, codAdapter);
    }
  }

  async reconcileAttemptStatus(
    attemptId: string,
    options?: RefundStatusReconciliationOptions,
  ): Promise<ReconcileRefundAttemptStatusResult> {
    const now = options?.referenceTime ?? new Date();
    const lockDurationMs = options?.lockDurationMs ?? DEFAULT_POLL_LOCK_MS;

    const current = await this.prisma.refundProviderAttempt.findUnique({
      where: { id: attemptId },
      include: { payment: { select: { providerReference: true } } },
    });

    if (!current) {
      return {
        attemptId,
        outcome: 'SKIPPED_LEASED_OR_INELIGIBLE',
        message: `Refund attempt "${attemptId}" not found`,
      };
    }

    if (
      current.status !== RefundAttemptStatus.PROVIDER_PENDING &&
      current.status !== RefundAttemptStatus.AMBIGUOUS_OUTCOME
    ) {
      return {
        attemptId,
        outcome: 'SKIPPED_LEASED_OR_INELIGIBLE',
        message: `Attempt "${attemptId}" is in status ${current.status} and does not require polling`,
      };
    }

    const adapter =
      options?.adapterOverrides?.[current.provider] ?? this.defaultAdapters.get(current.provider);
    if (!adapter || !adapter.supportsRefundStatusLookup || typeof adapter.verifyRefundStatus !== 'function') {
      throw new NotImplementedException(
        `Refund status lookup is unsupported for provider ${current.provider}`,
      );
    }

    const leaseUntil = new Date(now.getTime() + lockDurationMs);
    const claimed = await this.prisma.refundProviderAttempt.updateMany({
      where: {
        id: current.id,
        status: current.status,
        version: current.version,
        OR: [{ pollLockUntil: null }, { pollLockUntil: { lte: now } }],
      },
      data: {
        pollLockUntil: leaseUntil,
        pollAttemptCount: { increment: 1 },
        version: { increment: 1 },
      },
    });

    if (claimed.count !== 1) {
      return {
        attemptId: current.id,
        outcome: 'SKIPPED_LEASED_OR_INELIGIBLE',
        message: `Attempt "${current.id}" is already poll-locked or modified concurrently`,
      };
    }

    const leasedAttempt = await this.prisma.refundProviderAttempt.findUniqueOrThrow({
      where: { id: current.id },
      include: { payment: { select: { providerReference: true } } },
    });

    try {
      const pollResult = await adapter.verifyRefundStatus({
        attemptId: leasedAttempt.id,
        providerIdempotencyKey: leasedAttempt.providerIdempotencyKey,
        providerRefundReference: leasedAttempt.providerRefundReference,
        parentPaymentReference:
          leasedAttempt.parentPaymentReference ?? leasedAttempt.payment.providerReference,
        amount: Number(leasedAttempt.amount),
        currency: leasedAttempt.currency,
        merchantAccountId: leasedAttempt.merchantAccountId,
      });

      const pollTimestamp = pollResult.occurredAt ?? new Date();
      const rawPayload: Record<string, unknown> = {
        outcome: pollResult.outcome,
        providerRefundReference: pollResult.providerRefundReference ?? null,
        providerEventId: pollResult.providerEventId ?? null,
        amount: pollResult.amount ?? leasedAttempt.amount.toString(),
        currency: pollResult.currency ?? leasedAttempt.currency,
        merchantAccountId: pollResult.merchantAccountId ?? leasedAttempt.merchantAccountId,
        parentPaymentReference:
          pollResult.parentPaymentReference ??
          leasedAttempt.parentPaymentReference ??
          leasedAttempt.payment.providerReference,
        queriedAttemptId: leasedAttempt.id,
        pollAttemptCount: leasedAttempt.pollAttemptCount,
        ...(pollResult.rawPayload !== undefined ? { rawPayload: pollResult.rawPayload } : {}),
      };

      const evidenceDigest = computeEvidencePayloadDigest(rawPayload);
      const eventId =
        pollResult.providerEventId?.trim() ||
        `status-poll:${leasedAttempt.id}:${leasedAttempt.pollAttemptCount}:${evidenceDigest.slice(0, 16)}`;

      const evidenceResult = await this.evidenceProcessor.processEvidence(
        {
          attemptId: leasedAttempt.id,
          obligationId: leasedAttempt.obligationId,
          provider: leasedAttempt.provider,
          merchantAccountId: pollResult.merchantAccountId ?? leasedAttempt.merchantAccountId,
          parentPaymentReference: pollResult.parentPaymentReference ?? null,
          providerRefundReference: pollResult.providerRefundReference ?? null,
          providerIdempotencyKey:
            pollResult.providerIdempotencyKey ?? leasedAttempt.providerIdempotencyKey,
          amount: pollResult.amount ?? leasedAttempt.amount,
          currency: pollResult.currency ?? leasedAttempt.currency,
          outcome: pollResult.outcome,
          httpStatusCode: pollResult.httpStatusCode ?? 200,
          evidence: {
            provenance: RefundEvidenceProvenance.VERIFIED_STATUS_POLL,
            eventId,
            rawPayload,
            evidenceDigest,
            eventTimestamp: pollTimestamp,
            signatureValid: true,
            verification: {
              verifiedByAdapter: adapter.name,
              adapterVerificationToken:
                pollResult.verificationToken ?? `poll-verified:${leasedAttempt.id}:${leasedAttempt.pollAttemptCount}`,
              verifiedAt: pollTimestamp,
            },
          },
        },
        options?.evidencePolicyOverride,
      );

      await this.releasePollLockIfHeld(leasedAttempt.id, leaseUntil);
      return this.mapEvidenceResultToPollResult(leasedAttempt.id, evidenceResult);
    } catch (error) {
      await this.releasePollLockIfHeld(leasedAttempt.id, leaseUntil);
      throw error;
    }
  }

  async reconcileEligibleAttempts(
    limit = 25,
    options?: RefundStatusReconciliationOptions,
  ): Promise<ReconcileRefundAttemptStatusResult[]> {
    const now = options?.referenceTime ?? new Date();
    const candidates = await this.prisma.refundProviderAttempt.findMany({
      where: {
        status: {
          in: [RefundAttemptStatus.PROVIDER_PENDING, RefundAttemptStatus.AMBIGUOUS_OUTCOME],
        },
        OR: [{ pollLockUntil: null }, { pollLockUntil: { lte: now } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, provider: true },
    });

    const results: ReconcileRefundAttemptStatusResult[] = [];
    for (const candidate of candidates) {
      const adapter =
        options?.adapterOverrides?.[candidate.provider] ??
        this.defaultAdapters.get(candidate.provider);
      if (!adapter || !adapter.supportsRefundStatusLookup) {
        results.push({
          attemptId: candidate.id,
          outcome: 'SKIPPED_LEASED_OR_INELIGIBLE',
          message: `Skipped unsupported provider ${candidate.provider} (fail-closed)`,
        });
        continue;
      }

      results.push(await this.reconcileAttemptStatus(candidate.id, options));
    }

    return results;
  }

  private async releasePollLockIfHeld(attemptId: string, expectedLockUntil: Date): Promise<void> {
    await this.prisma.refundProviderAttempt.updateMany({
      where: {
        id: attemptId,
        pollLockUntil: expectedLockUntil,
      },
      data: {
        pollLockUntil: null,
        version: { increment: 1 },
      },
    });
  }

  private mapEvidenceResultToPollResult(
    attemptId: string,
    evidenceResult: ProcessRefundEvidenceResult,
  ): ReconcileRefundAttemptStatusResult {
    if (evidenceResult.disposition === 'DUPLICATE_IGNORED') {
      return {
        attemptId,
        outcome: 'DUPLICATE_IGNORED',
        evidenceResult,
        message: evidenceResult.message,
      };
    }

    if (
      evidenceResult.disposition === 'CONFLICT_REJECTED' ||
      evidenceResult.disposition === 'SIGNATURE_REJECTED' ||
      evidenceResult.disposition === 'UNMATCHED_IGNORED'
    ) {
      return {
        attemptId,
        outcome: 'CONFLICT_QUARANTINED',
        evidenceResult,
        message: evidenceResult.message,
      };
    }

    if (evidenceResult.resultingAttemptStatus === RefundAttemptStatus.COMPLETED) {
      return {
        attemptId,
        outcome: 'COMPLETED',
        evidenceResult,
        message: evidenceResult.message,
      };
    }

    if (evidenceResult.resultingAttemptStatus === RefundAttemptStatus.FAILED) {
      return {
        attemptId,
        outcome: 'FAILED',
        evidenceResult,
        message: evidenceResult.message,
      };
    }

    return {
      attemptId,
      outcome: 'PENDING',
      evidenceResult,
      message: evidenceResult.message,
    };
  }
}
