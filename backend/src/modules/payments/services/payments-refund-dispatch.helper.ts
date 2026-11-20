import { ConflictException, NotImplementedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, Refund, RefundAttemptFailureClass } from '@prisma/client';

import { RefundStatusChangedEvent } from '../../../common/events/refund-status-changed.event';
import {
  PaymentProviderAdapter,
  PaymentRefundResult,
} from '../interfaces/payment-provider.interface';
import { PaymentWithOrder } from '../repositories/payments.repository';
import { RefundAttemptsRepository } from '../repositories/refund-attempts.repository';
import { RefundsRepository } from '../repositories/refunds.repository';
import { RefundDispatchActor } from '../types/refund-ledger.types';

export interface RefundExecutionOptions {
  allowReplacementRetry?: boolean;
  actor?: RefundDispatchActor;
}

export async function executeTwoPhaseRefundDispatch(params: {
  payment: PaymentWithOrder;
  amount: number | Prisma.Decimal;
  reason: string;
  idempotencyKey?: string;
  options?: RefundExecutionOptions;
  attemptsRepo: RefundAttemptsRepository;
  adapter: PaymentProviderAdapter;
  eventEmitter: EventEmitter2;
}): Promise<Refund | null> {
  const { payment, amount, reason, idempotencyKey, options, attemptsRepo, adapter, eventEmitter } =
    params;

  // TX1: Prepare obligation, refund, and leased DISPATCHING attempt before any network I/O
  const prep = await attemptsRepo.prepareAndClaimAttempt({
    paymentId: payment.id,
    amount,
    reason,
    idempotencyKey,
    orderId: payment.orderId,
    allowReplacementRetry: options?.allowReplacementRetry,
    actor: options?.actor,
  });

  if (prep.action === 'EXCEEDS_BALANCE') {
    return null;
  }
  if (prep.action === 'RETURN_EXISTING') {
    return prep.refund ?? null;
  }
  if (prep.action === 'TERMINAL_FAILED') {
    throw new Error(`TERMINAL_FAILED:${prep.errorReason ?? 'Refund reservation rejected'}`);
  }

  const attempt = prep.attempt!;
  const obligation = prep.obligation!;
  const refund = prep.refund!;

  // E1: External provider call strictly outside database transaction locks
  let providerResult: PaymentRefundResult;
  try {
    providerResult = await adapter.refundPayment(
      prep.parentPaymentReference ?? payment.id,
      new Prisma.Decimal(amount).toNumber(),
      reason,
      {
        attemptId: attempt.id,
        obligationId: obligation.id,
        refundId: refund.id,
        providerIdempotencyKey: attempt.providerIdempotencyKey,
        attemptSequence: attempt.attemptSequence,
      },
    );
  } catch (error) {
    if (error instanceof NotImplementedException) {
      await attemptsRepo.recordPreSendAbort({
        attemptId: attempt.id,
        paymentId: payment.id,
        failureClass: RefundAttemptFailureClass.UNSUPPORTED_OPERATION,
        errorReason: error.message,
        rawErrorPayload: { name: error.name, message: error.message },
        actor: options?.actor,
      });
      throw error;
    }

    await attemptsRepo.quarantineAttemptOutcome({
      attemptId: attempt.id,
      paymentId: payment.id,
      failureClass: RefundAttemptFailureClass.TRANSPORT_AMBIGUOUS,
      errorMessage: error instanceof Error ? error.message : String(error),
      rawPayload: { message: error instanceof Error ? error.message : String(error) },
      actor: options?.actor,
    });
    throw error;
  }

  const validStatuses = new Set(['COMPLETED', 'PENDING', 'FAILED']);
  const trimmedRef = providerResult?.providerReference?.trim() ?? '';
  const refCollidesWithCharge =
    Boolean(trimmedRef) &&
    Boolean(prep.parentPaymentReference?.trim()) &&
    trimmedRef === prep.parentPaymentReference?.trim();

  if (
    !providerResult ||
    !validStatuses.has(providerResult.status) ||
    (providerResult.status === 'COMPLETED' && !trimmedRef) ||
    refCollidesWithCharge
  ) {
    await attemptsRepo.quarantineAttemptOutcome({
      attemptId: attempt.id,
      paymentId: payment.id,
      failureClass: RefundAttemptFailureClass.EVIDENCE_CONTRADICTION,
      errorMessage: 'Malformed or contradictory provider refund response',
      rawPayload: providerResult ?? null,
      actor: options?.actor,
    });
    throw new ConflictException('Malformed or contradictory provider refund response quarantined');
  }

  // TX2B: Persist attempt outcome, refund/obligation/payment state, and durable PaymentOutbox
  const outcome = await attemptsRepo.recordSyncOutcomeAndOutbox({
    attemptId: attempt.id,
    paymentId: payment.id,
    providerOutcome: providerResult.status,
    providerRefundReference: trimmedRef || null,
    expectedAmount: amount,
    httpStatusCode: providerResult.httpStatusCode ?? null,
    rawResponsePayload: providerResult.rawPayload ?? providerResult,
    actor: options?.actor,
  });

  if (providerResult.status === 'COMPLETED' || providerResult.status === 'FAILED') {
    try {
      await eventEmitter.emitAsync(
        RefundStatusChangedEvent.eventName,
        new RefundStatusChangedEvent(
          payment.order.customerId,
          outcome.refund.amount.toString(),
          outcome.refund.status,
          payment.orderId,
          payment.id,
          outcome.refund.id,
        ),
      );
    } catch {
      // Durable PaymentOutbox record is already committed; never undo TX2 on listener error.
    }
  }

  return outcome.refund;
}

export function resolveAttemptsRepository(
  injected: RefundAttemptsRepository | undefined,
  refundsRepository: RefundsRepository,
): RefundAttemptsRepository | undefined {
  if (injected) {
    return injected;
  }
  const maybeWithPrisma = refundsRepository as unknown as {
    prisma?: ConstructorParameters<typeof RefundAttemptsRepository>[0];
  };
  return maybeWithPrisma.prisma
    ? new RefundAttemptsRepository(maybeWithPrisma.prisma)
    : undefined;
}
