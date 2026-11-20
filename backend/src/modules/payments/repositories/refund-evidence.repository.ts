import { Injectable } from '@nestjs/common';
import {
  Prisma,
  RefundAttemptStatus,
  RefundEvidenceDisposition,
  RefundObligation,
  RefundObligationStatus,
  RefundProviderAttempt,
  RefundStatus,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  ProcessRefundEvidenceInput,
  ProcessRefundEvidenceResult,
} from '../types/refund-reconciliation.types';
import {
  applyPendingEvidenceTx,
  applyTerminalResolutionTx,
} from './refund-evidence-outcomes.helper';
import { recordConflictAndQuarantineTx } from './refund-evidence-quarantine.helper';
import {
  detectExternalEventReplayTx,
  persistEvidenceReceipt,
  resolveAttemptCandidate,
  validateEvidenceFieldsTx,
} from './refund-evidence-validation.helper';
import {
  lockPaymentObligationsAndRefunds,
  lockRefundFinancialHierarchy,
  LockedRefundPaymentRow,
} from './refund-locks.helper';

@Injectable()
export class RefundEvidenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async recordUnauthenticatedOrMalformedReceipt(
    input: ProcessRefundEvidenceInput,
    disposition: RefundEvidenceDisposition,
    normalizedDigest: string,
    rejectionReason: string,
  ): Promise<ProcessRefundEvidenceResult> {
    const receipt = await persistEvidenceReceipt(this.prisma, {
      provider: input.provider,
      merchantAccountId: input.merchantAccountId,
      eventId: input.evidence.eventId,
      providerRefundReference: input.providerRefundReference?.trim() || null,
      attemptId: null,
      refundId: null,
      obligationId: null,
      provenance: input.evidence.provenance,
      disposition,
      signatureValid: false,
      evidenceDigest: normalizedDigest,
      sourceIp: input.evidence.sourceIp ?? null,
      rejectionReason,
    });

    return {
      applied: false,
      disposition,
      attemptId: null,
      refundId: null,
      obligationId: null,
      receiptId: receipt.id,
      quarantined: false,
      message: rejectionReason,
    };
  }

  async applyVerifiedEvidence(
    input: ProcessRefundEvidenceInput,
    normalizedDigest: string,
  ): Promise<ProcessRefundEvidenceResult> {
    const candidate = await resolveAttemptCandidate(this.prisma, input);
    if (!candidate) {
      return this.recordUnmatchedReceipt(input, normalizedDigest);
    }

    return this.prisma.$transaction(
      async (tx) => {
        const payment = await lockRefundFinancialHierarchy(tx, candidate.paymentId);
        if (!payment) {
          return this.recordUnmatchedReceipt(input, normalizedDigest, tx);
        }
        await lockPaymentObligationsAndRefunds(tx, candidate.paymentId);

        const attempt = await tx.refundProviderAttempt.findUnique({
          where: { id: candidate.id },
        });
        if (!attempt) {
          return this.recordUnmatchedReceipt(input, normalizedDigest, tx);
        }

        const refund = await tx.refund.findUniqueOrThrow({ where: { id: attempt.refundId } });
        const obligation = await tx.refundObligation.findUniqueOrThrow({
          where: { id: attempt.obligationId },
        });
        const trimmedRef = input.providerRefundReference?.trim() || null;

        const replayCheck = await detectExternalEventReplayTx(
          tx,
          input,
          attempt,
          normalizedDigest,
          trimmedRef,
        );
        if (replayCheck?.kind === 'DUPLICATE_EXACT') {
          return this.recordDuplicateResultTx(
            tx,
            input,
            attempt,
            refund.status,
            obligation.status,
            normalizedDigest,
            trimmedRef,
            replayCheck.reason,
          );
        }
        if (replayCheck?.kind === 'CONFLICT_EVENT_REUSE') {
          return recordConflictAndQuarantineTx(tx, {
            input,
            attempt,
            refundStatus: refund.status,
            obligation,
            payment,
            normalizedDigest,
            normalizedRef: trimmedRef,
            reason: replayCheck.reason,
            recordExternalEventId: false,
          });
        }

        const fieldCheck = await validateEvidenceFieldsTx(tx, input, attempt, payment);
        if (!fieldCheck.valid) {
          return recordConflictAndQuarantineTx(tx, {
            input,
            attempt,
            refundStatus: refund.status,
            obligation,
            payment,
            normalizedDigest,
            normalizedRef: trimmedRef,
            reason: fieldCheck.reason,
            recordExternalEventId: false,
          });
        }

        return this.routeValidEvidenceByStateTx(
          tx,
          input,
          attempt,
          refund.status,
          obligation,
          payment,
          normalizedDigest,
          fieldCheck.normalizedRef,
        );
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 15_000,
        timeout: 15_000,
      },
    );
  }

  private async recordUnmatchedReceipt(
    input: ProcessRefundEvidenceInput,
    normalizedDigest: string,
    txClient?: Prisma.TransactionClient,
  ): Promise<ProcessRefundEvidenceResult> {
    const client = txClient ?? this.prisma;
    const reason = 'No matching refund provider attempt found for supplied evidence identifiers';
    const receipt = await persistEvidenceReceipt(client, {
      provider: input.provider,
      merchantAccountId: input.merchantAccountId,
      eventId: input.evidence.eventId,
      providerRefundReference: input.providerRefundReference?.trim() || null,
      attemptId: null,
      refundId: null,
      obligationId: null,
      provenance: input.evidence.provenance,
      disposition: RefundEvidenceDisposition.UNMATCHED_IGNORED,
      signatureValid: Boolean(input.evidence.signatureValid),
      evidenceDigest: normalizedDigest,
      sourceIp: input.evidence.sourceIp ?? null,
      rejectionReason: reason,
    });

    return {
      applied: false,
      disposition: RefundEvidenceDisposition.UNMATCHED_IGNORED,
      attemptId: null,
      refundId: null,
      obligationId: null,
      receiptId: receipt.id,
      quarantined: false,
      message: reason,
    };
  }

  private async recordDuplicateResultTx(
    tx: Prisma.TransactionClient,
    input: ProcessRefundEvidenceInput,
    attempt: RefundProviderAttempt,
    refundStatus: RefundStatus,
    obligationStatus: RefundObligationStatus,
    normalizedDigest: string,
    normalizedRef: string | null,
    reason: string,
  ): Promise<ProcessRefundEvidenceResult> {
    const receipt = await persistEvidenceReceipt(tx, {
      provider: input.provider,
      merchantAccountId: input.merchantAccountId,
      eventId: input.evidence.eventId,
      providerRefundReference: normalizedRef ?? attempt.providerRefundReference,
      attemptId: attempt.id,
      refundId: attempt.refundId,
      obligationId: attempt.obligationId,
      provenance: input.evidence.provenance,
      disposition: RefundEvidenceDisposition.DUPLICATE_IGNORED,
      signatureValid: Boolean(input.evidence.signatureValid),
      evidenceDigest: normalizedDigest,
      sourceIp: input.evidence.sourceIp ?? null,
      rejectionReason: reason,
    });

    return {
      applied: false,
      disposition: RefundEvidenceDisposition.DUPLICATE_IGNORED,
      attemptId: attempt.id,
      refundId: attempt.refundId,
      obligationId: attempt.obligationId,
      resultingAttemptStatus: attempt.status,
      resultingRefundStatus: refundStatus,
      resultingObligationStatus: obligationStatus,
      receiptId: receipt.id,
      quarantined: false,
      message: reason,
    };
  }

  private async routeValidEvidenceByStateTx(
    tx: Prisma.TransactionClient,
    input: ProcessRefundEvidenceInput,
    attempt: RefundProviderAttempt,
    refundStatus: RefundStatus,
    obligation: RefundObligation,
    payment: LockedRefundPaymentRow,
    normalizedDigest: string,
    normalizedRef: string | null,
  ): Promise<ProcessRefundEvidenceResult> {
    if (attempt.status === RefundAttemptStatus.COMPLETED) {
      if (input.outcome === 'FAILED') {
        return recordConflictAndQuarantineTx(tx, {
          input,
          attempt,
          refundStatus,
          obligation,
          payment,
          normalizedDigest,
          normalizedRef,
          reason: `Contradictory terminal FAILED evidence received for already COMPLETED attempt "${attempt.id}"`,
          recordExternalEventId: true,
        });
      }
      return this.recordDuplicateResultTx(
        tx,
        input,
        attempt,
        refundStatus,
        obligation.status,
        normalizedDigest,
        normalizedRef,
        `Attempt "${attempt.id}" is already COMPLETED; ignored non-contradictory ${input.outcome} evidence`,
      );
    }

    if (
      attempt.status === RefundAttemptStatus.FAILED ||
      attempt.status === RefundAttemptStatus.CANCELLED_BEFORE_DISPATCH
    ) {
      if (input.outcome === 'COMPLETED') {
        return recordConflictAndQuarantineTx(tx, {
          input,
          attempt,
          refundStatus,
          obligation,
          payment,
          normalizedDigest,
          normalizedRef,
          reason: `Contradictory COMPLETED evidence received for terminal ${attempt.status} attempt "${attempt.id}"`,
          recordExternalEventId: true,
        });
      }
      return this.recordDuplicateResultTx(
        tx,
        input,
        attempt,
        refundStatus,
        obligation.status,
        normalizedDigest,
        normalizedRef,
        `Attempt "${attempt.id}" is already ${attempt.status}; ignored ${input.outcome} evidence`,
      );
    }

    if (input.outcome === 'PENDING') {
      return applyPendingEvidenceTx(
        tx,
        input,
        attempt,
        refundStatus,
        obligation,
        payment,
        normalizedDigest,
        normalizedRef,
      );
    }

    return applyTerminalResolutionTx(
      tx,
      input,
      attempt,
      obligation,
      payment,
      normalizedDigest,
      normalizedRef,
    );
  }
}
