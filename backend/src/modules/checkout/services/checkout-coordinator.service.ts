import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { sanitizeErrorMessage } from '../../../common/utils/sanitize-error-message.util';
import { OrderPlacedEvent } from '../../../common/events/order-placed.event';
import { CheckoutAttemptService } from '../../checkout-attempt/services/checkout-attempt.service';
import { CheckoutDto } from '../../orders/dto/checkout.dto';
import { OrdersService } from '../../orders/services/orders.service';
import { OrderWithDetails } from '../../orders/repositories/orders.repository';
import { PreparedCheckout } from '../../orders/types/checkout-preparation.types';
import { getReservationKeySegmentValidationError, CHECKOUT_PENDING_INITIAL_LEASE_SECONDS } from '../../inventory/constants/inventory.constants';
import { CheckoutReservationStateService } from '../../inventory/services/checkout-reservation-state.service';
import { CheckoutReservationRecoveryService } from '../../inventory/services/checkout-reservation-recovery.service';
import { PriceLockService } from '../../price-lock/services/price-lock.service';
import { PaymentsService } from '../../payments/services/payments.service';
import { PrismaService } from '../../../database/prisma.service';
import { mapCheckoutMarkFailureCode } from './checkout-mark-failure-mapper';
import {
  reconcileCheckoutPlan,
  toCheckoutMarkItems,
  toOrderPricingSnapshot,
} from './checkout-plan-reconciliation';
import { CanonicalCheckoutPlan } from '../types/canonical-checkout-plan.types';
import { CheckoutCoordinatorResult } from '../types/checkout-coordinator.types';

const MAX_LOG_MESSAGE_LENGTH = 500;

// Phase 16A.0-D, Unit D.2 (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md).
// Orchestrates the durable checkout saga: CheckoutAttempt idempotency,
// checkoutMark, the order transaction, and post-commit finalize/payment.
// Additive and unwired - no controller, no CheckoutModule, no AppModule
// wiring exists yet. Deliberately depends on nothing beyond what this saga
// itself needs: no ReservationGateway (checkoutMark already validates
// reservation existence/quantity/version/owner/expiry - a separate
// admission recheck would be redundant), no CheckoutLeaseStateService/
// CheckoutPendingReconciliationService (lease inspection/extension and
// stale-attempt reconciliation are Phase F's heartbeat-recovery concern,
// not synchronous checkout), no ReservationEngineModeService or
// mirror-compensation service (unrelated to this saga).
@Injectable()
export class CheckoutCoordinatorService {
  private readonly logger = new Logger(CheckoutCoordinatorService.name);

  constructor(
    private readonly checkoutAttempt: CheckoutAttemptService,
    private readonly priceLock: PriceLockService,
    private readonly checkoutReservationState: CheckoutReservationStateService,
    private readonly checkoutReservationRecovery: CheckoutReservationRecoveryService,
    private readonly ordersService: OrdersService,
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async checkout(
    customerId: string,
    idempotencyKey: string,
    dto: CheckoutDto,
    now: Date,
  ): Promise<CheckoutCoordinatorResult> {
    const keyError = getReservationKeySegmentValidationError(idempotencyKey, 'idempotencyKey');
    if (keyError) {
      return { ok: false, code: 'INVALID_INPUT', field: 'idempotencyKey', reason: keyError };
    }

    const prepareResult = await this.ordersService.prepareCheckout(customerId, dto);
    if (!prepareResult.ok) {
      return { ok: false, code: 'PREPARE_FAILED', prepareFailure: prepareResult };
    }
    const { prepared } = prepareResult;

    const priceLockResult = await this.priceLock.validateCartPriceLocks(prepared.cart.id, customerId, now);
    if (!priceLockResult.ok) {
      return { ok: false, code: 'PRICE_LOCK_INVALID', priceLockFailure: priceLockResult };
    }

    const reconciliation = reconcileCheckoutPlan(prepared.cart, priceLockResult);
    if (!reconciliation.ok) {
      return {
        ok: false,
        code: 'CHECKOUT_PLAN_MISMATCH',
        missingFromPriceLock: reconciliation.missingFromPriceLock,
        extraInPriceLock: reconciliation.extraInPriceLock,
        quantityMismatchProductIds: reconciliation.quantityMismatchProductIds,
      };
    }
    const { plan } = reconciliation;

    const attemptResult = await this.checkoutAttempt.createOrResume({
      idempotencyKey,
      cartId: prepared.cart.id,
      customerId,
      now,
    });
    if (!attemptResult.ok) {
      return { ok: false, code: 'IDEMPOTENCY_KEY_CONFLICT' };
    }

    if (attemptResult.action === 'RESUMED_PROCESSING') {
      return { ok: false, code: 'CHECKOUT_ALREADY_IN_PROGRESS' };
    }
    if (attemptResult.action === 'ALREADY_FAILED') {
      return { ok: false, code: 'CHECKOUT_ALREADY_FAILED', failureCode: attemptResult.attempt.failureCode };
    }
    if (attemptResult.action === 'ALREADY_COMMITTED') {
      return this.replayCommitted(customerId, attemptResult.attempt.id, attemptResult.attempt.orderId);
    }

    return this.executeCreatedCheckout(customerId, idempotencyKey, dto, now, prepared, plan, attemptResult.attempt.id);
  }

  private async replayCommitted(
    customerId: string,
    attemptId: string,
    orderId: string | null,
  ): Promise<CheckoutCoordinatorResult> {
    if (!orderId) {
      throw new Error(`Internal consistency error: checkout attempt ${attemptId} is COMMITTED with no orderId`);
    }
    const order = await this.ordersService.getCustomerOrderById(customerId, orderId);
    return { ok: true, order };
  }

  private async executeCreatedCheckout(
    customerId: string,
    idempotencyKey: string,
    dto: CheckoutDto,
    now: Date,
    prepared: PreparedCheckout,
    plan: CanonicalCheckoutPlan,
    attemptId: string,
  ): Promise<CheckoutCoordinatorResult> {
    const nowMs = now.getTime();
    const markResult = await this.checkoutReservationState.checkoutMark(
      prepared.cart.id,
      customerId,
      idempotencyKey,
      toCheckoutMarkItems(plan),
      nowMs,
      CHECKOUT_PENDING_INITIAL_LEASE_SECONDS,
    );
    if (!markResult.ok) {
      const markFailureCode = mapCheckoutMarkFailureCode(markResult);
      await this.markAttemptFailed(attemptId, customerId, markFailureCode, JSON.stringify(markResult), now);
      return { ok: false, code: 'CHECKOUT_MARK_FAILED', markFailureCode };
    }

    let order: OrderWithDetails;
    try {
      order = await this.prisma.$transaction((tx) => this.runOrderTransaction(tx, prepared, plan, attemptId, customerId, now));
    } catch (transactionError) {
      const failureCode = await this.recoverFromTransactionFailure(
        prepared.cart.id,
        idempotencyKey,
        nowMs,
        attemptId,
        customerId,
        now,
        transactionError,
      );
      return { ok: false, code: failureCode };
    }

    await this.finalizeAfterCommit(prepared.cart.id, idempotencyKey);

    return this.completeWithPayment(customerId, dto, plan, order);
  }

  private async runOrderTransaction(
    tx: Prisma.TransactionClient,
    prepared: PreparedCheckout,
    plan: CanonicalCheckoutPlan,
    attemptId: string,
    customerId: string,
    now: Date,
  ): Promise<OrderWithDetails> {
    const created = await this.ordersService.createOrderInTransaction(tx, prepared, toOrderPricingSnapshot(plan));
    const commitResult = await this.checkoutAttempt.markCommittedInTransaction(
      tx,
      attemptId,
      customerId,
      created.id,
      now,
    );
    if (!commitResult.ok) {
      throw new Error(
        `Internal consistency error: could not commit checkout attempt ${attemptId}: ${commitResult.code}`,
      );
    }
    return created;
  }

  private async recoverFromTransactionFailure(
    cartId: string,
    idempotencyKey: string,
    nowMs: number,
    attemptId: string,
    customerId: string,
    now: Date,
    transactionError: unknown,
  ): Promise<'ORDER_TRANSACTION_FAILED' | 'ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE'> {
    let revertIncomplete = false;
    try {
      const revertResult = await this.checkoutReservationRecovery.checkoutRevert(cartId, idempotencyKey, nowMs);
      if (!revertResult.ok) {
        revertIncomplete = true;
      }
    } catch (revertError) {
      revertIncomplete = true;
      this.logger.error('checkoutRevert failed while recovering from a durable transaction failure', {
        message: sanitizeErrorMessage(CheckoutCoordinatorService.errorMessage(revertError), MAX_LOG_MESSAGE_LENGTH),
      });
    }

    const failureCode = revertIncomplete
      ? 'ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE'
      : 'ORDER_TRANSACTION_FAILED';
    await this.markAttemptFailed(
      attemptId,
      customerId,
      failureCode,
      CheckoutCoordinatorService.errorMessage(transactionError),
      now,
    );
    return failureCode;
  }

  private async finalizeAfterCommit(cartId: string, idempotencyKey: string): Promise<void> {
    try {
      const finalizeResult = await this.checkoutReservationRecovery.finalizeCheckoutConsumption(
        cartId,
        idempotencyKey,
      );
      if (!finalizeResult.ok) {
        this.logger.warn('finalizeCheckoutConsumption returned a non-success result after a committed checkout', {
          code: finalizeResult.code,
        });
      }
    } catch (finalizeError) {
      // Order remains successful - deferred recovery (Phase F) owns any
      // stray Redis cleanup this leaves behind.
      this.logger.error('finalizeCheckoutConsumption threw after a committed checkout', {
        message: sanitizeErrorMessage(CheckoutCoordinatorService.errorMessage(finalizeError), MAX_LOG_MESSAGE_LENGTH),
      });
    }
  }

  private async completeWithPayment(
    customerId: string,
    dto: CheckoutDto,
    plan: CanonicalCheckoutPlan,
    order: OrderWithDetails,
  ): Promise<CheckoutCoordinatorResult> {
    const total = order.vendorOrders.reduce((sum, vendorOrder) => sum + vendorOrder.subtotal.toNumber(), 0);
    const itemCount = order.vendorOrders.reduce((count, vendorOrder) => count + vendorOrder.items.length, 0);
    await this.eventEmitter.emitAsync(
      OrderPlacedEvent.eventName,
      new OrderPlacedEvent(customerId, order.id, total.toFixed(2), itemCount),
    );

    const { payment, redirectUrl } = await this.paymentsService.initiatePayment({
      orderId: order.id,
      amount: total,
      currency: plan.currency,
      provider: dto.paymentMethod,
    });

    return { ok: true, order: this.ordersService.toOrderResponseWithPayment(order, payment, redirectUrl) };
  }

  private async markAttemptFailed(
    attemptId: string,
    customerId: string,
    failureCode: string,
    failureMessage: string,
    now: Date,
  ): Promise<void> {
    const result = await this.checkoutAttempt.markFailed(attemptId, customerId, failureCode, failureMessage, now);
    if (!result.ok) {
      throw new Error(
        `Internal consistency error: could not mark checkout attempt ${attemptId} FAILED: ${result.code}`,
      );
    }
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
