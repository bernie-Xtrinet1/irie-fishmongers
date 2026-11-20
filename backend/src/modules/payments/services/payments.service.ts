import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotImplementedException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentProviderName, Prisma, Refund } from '@prisma/client';

import { PaymentConfirmedEvent } from '../../../common/events/payment-confirmed.event';
import { PaymentInitiationResponseEntity } from '../entities/payment-initiation-response.entity';
import { PaymentResponseEntity } from '../entities/payment-response.entity';
import { RefundResponseEntity } from '../entities/refund-response.entity';
import {
  PaymentCreateInput,
  PaymentProviderAdapter,
  PaymentVerifyResult,
} from '../interfaces/payment-provider.interface';
import { CashOnDeliveryAdapter } from '../providers/cash-on-delivery.adapter';
import { WiPayAdapter } from '../providers/wipay.adapter';
import { PaymentsRepository, PaymentWithOrder } from '../repositories/payments.repository';
import { RefundAttemptsRepository } from '../repositories/refund-attempts.repository';
import { normalizeManualIdempotencyKey } from '../repositories/refund-locks.helper';
import { RefundsRepository } from '../repositories/refunds.repository';
import {
  executeTwoPhaseRefundDispatch,
  RefundExecutionOptions,
  resolveAttemptsRepository,
} from './payments-refund-dispatch.helper';

export { RefundExecutionOptions };

@Injectable()
export class PaymentsService {
  private fallbackAttemptsRepository?: RefundAttemptsRepository;

  constructor(
    private readonly paymentsRepository: PaymentsRepository,
    private readonly refundsRepository: RefundsRepository,
    private readonly wiPayAdapter: WiPayAdapter,
    private readonly cashOnDeliveryAdapter: CashOnDeliveryAdapter,
    private readonly eventEmitter: EventEmitter2,
    @Optional() private readonly refundAttemptsRepository?: RefundAttemptsRepository,
  ) {}

  async initiatePayment(
    input: PaymentCreateInput & { provider: PaymentProviderName },
  ): Promise<PaymentInitiationResponseEntity> {
    const { payment } = await this.paymentsRepository.createOrGetByOrderId({
      orderId: input.orderId,
      provider: input.provider,
      amount: input.amount,
      currency: input.currency,
    });

    if (payment.status === 'PAID') {
      throw new ConflictException('This order has already been paid');
    }
    if (payment.provider !== input.provider) {
      throw new ConflictException('This order already has a payment using a different provider');
    }
    if (payment.initiationStatus !== 'NOT_STARTED') {
      return { payment: PaymentsService.toPaymentResponse(payment) };
    }

    const claimed = await this.paymentsRepository.claimInitiation(payment.id);
    if (!claimed) {
      const current = await this.paymentsRepository.findById(payment.id);
      if (!current) {
        throw new Error(
          `Internal consistency error: payment "${payment.id}" disappeared after initiation claim`,
        );
      }
      return { payment: PaymentsService.toPaymentResponse(current) };
    }

    const adapter = this.getAdapter(payment.provider);

    let result;
    try {
      result = await adapter.createPayment({
        orderId: payment.orderId,
        amount: payment.amount.toNumber(),
        currency: payment.currency,
        ...(payment.provider === 'WIPAY'
          ? {
              customerEmail: await this.paymentsRepository.findCustomerEmailForOrder(
                payment.orderId,
              ),
            }
          : {}),
      });
    } catch (error) {
      await this.paymentsRepository.update(payment.id, {
        initiationStatus: 'RECONCILE_REQUIRED',
      });
      throw error;
    }

    const isPaid = result.status === 'PAID';
    const finalPayment = await this.paymentsRepository.update(payment.id, {
      initiationStatus: 'ESTABLISHED',
      status: isPaid ? 'PAID' : 'PENDING',
      providerReference: result.providerReference,
      ...(isPaid ? { paidAt: new Date() } : {}),
    });

    if (isPaid) {
      await this.emitPaymentConfirmed(finalPayment);
    }

    return {
      payment: PaymentsService.toPaymentResponse(finalPayment),
      redirectUrl: result.redirectUrl,
    };
  }

  async getByOrderId(orderId: string): Promise<PaymentResponseEntity | null> {
    const payment = await this.paymentsRepository.findByOrderId(orderId);
    return payment ? PaymentsService.toPaymentResponse(payment) : null;
  }

  async assertReadyForFulfillment(orderId: string): Promise<void> {
    const payment = await this.paymentsRepository.findByOrderId(orderId);
    if (!payment || payment.provider === 'CASH_ON_DELIVERY') {
      return;
    }
    if (payment.status !== 'PAID') {
      throw new ForbiddenException(
        'Payment must be completed before the vendor can accept this order',
      );
    }
  }

  async markCashOnDeliveryPaid(paymentId: string): Promise<PaymentResponseEntity> {
    const payment = await this.paymentsRepository.findById(paymentId);
    if (!payment) {
      throw new BadRequestException('Payment not found');
    }
    if (payment.provider !== 'CASH_ON_DELIVERY') {
      throw new BadRequestException('Only cash-on-delivery payments can be confirmed manually');
    }

    const { payment: updated, transitioned } =
      await this.paymentsRepository.transitionToPaid(paymentId);

    if (!updated) {
      throw new Error(
        `Internal consistency error: payment "${paymentId}" disappeared after PAID transition`,
      );
    }
    if (transitioned) {
      await this.emitPaymentConfirmed(updated);
    }

    return PaymentsService.toPaymentResponse(updated);
  }

  handleWiPayWebhook(_rawBody: string, _signature: string): Promise<void> {
    return Promise.reject(
      new NotImplementedException('WiPay webhook integration is not implemented'),
    );
  }

  async handleWiPayReturn(
    payload: Record<string, unknown>,
  ): Promise<{ status: 'VERIFIED' | 'UNVERIFIED' }> {
    if (
      typeof payload.transaction_id !== 'string' ||
      !payload.transaction_id.trim() ||
      !['success', 'failed', 'error'].includes(payload.status as string)
    ) {
      throw new BadRequestException('Invalid WiPay transaction response');
    }
    const payment = await this.paymentsRepository.findByProviderReference(payload.transaction_id);
    if (
      !payment ||
      payment.provider !== 'WIPAY' ||
      payment.providerReference !== payload.transaction_id
    ) {
      throw new UnauthorizedException('Unverifiable WiPay transaction response');
    }
    if (payload.status !== 'success') return { status: 'UNVERIFIED' };
    if (
      !this.wiPayAdapter.verifyTransactionResponse(
        payload,
        payment.providerReference,
        payment.amount.toFixed(2),
      )
    ) {
      throw new UnauthorizedException('Invalid WiPay transaction response hash');
    }

    const { payment: updated, transitioned } = await this.paymentsRepository.transitionToPaid(
      payment.id,
    );
    if (!updated) {
      throw new Error(
        `Internal consistency error: payment "${payment.id}" disappeared after PAID transition`,
      );
    }
    if (transitioned) {
      await this.emitPaymentConfirmed(updated);
    }
    return { status: 'VERIFIED' };
  }

  async refundForOrder(
    orderId: string,
    amount: number | Prisma.Decimal,
    reason: string,
    idempotencyKey?: string,
    options?: RefundExecutionOptions,
  ): Promise<Refund | null> {
    const payment = await this.paymentsRepository.findByOrderId(orderId);
    if (!payment || (payment.status !== 'PAID' && payment.status !== 'PARTIALLY_REFUNDED')) {
      return null;
    }
    return this.executeRefund(payment, amount, reason, idempotencyKey, options);
  }

  async refundByPaymentId(
    paymentId: string,
    amount: number | Prisma.Decimal,
    reason: string,
    idempotencyKey?: string,
    options?: RefundExecutionOptions,
  ): Promise<RefundResponseEntity> {
    const validatedKey = normalizeManualIdempotencyKey(idempotencyKey);
    const payment = await this.paymentsRepository.findById(paymentId);
    if (!payment) {
      throw new BadRequestException('Payment not found');
    }
    if (payment.status !== 'PAID' && payment.status !== 'PARTIALLY_REFUNDED') {
      throw new BadRequestException('Only a paid payment can be refunded');
    }

    const refund = await this.executeRefund(payment, amount, reason, validatedKey, options);
    if (!refund) {
      throw new BadRequestException('Refund amount exceeds the remaining refundable balance');
    }
    return PaymentsService.toRefundResponse(refund);
  }

  async verifyProviderPayment(
    provider: PaymentProviderName,
    providerReference: string,
  ): Promise<PaymentVerifyResult> {
    return this.getAdapter(provider).verifyPayment(providerReference);
  }

  async emitRecoveredPaymentConfirmed(payment: PaymentWithOrder): Promise<void> {
    await this.emitPaymentConfirmed(payment);
  }

  private async executeRefund(
    payment: PaymentWithOrder,
    amount: number | Prisma.Decimal,
    reason: string,
    idempotencyKey?: string,
    options?: RefundExecutionOptions,
  ): Promise<Refund | null> {
    const attemptsRepo =
      this.refundAttemptsRepository ??
      (this.fallbackAttemptsRepository ??= resolveAttemptsRepository(
        this.refundAttemptsRepository,
        this.refundsRepository,
      ));
    if (!attemptsRepo) {
      throw new InternalServerErrorException(
        'RefundAttemptsRepository is required for durable two-transaction refund dispatch',
      );
    }

    try {
      return await executeTwoPhaseRefundDispatch({
        payment,
        amount,
        reason,
        idempotencyKey,
        options,
        attemptsRepo,
        adapter: this.getAdapter(payment.provider),
        eventEmitter: this.eventEmitter,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('TERMINAL_FAILED:')) {
        throw new BadRequestException(error.message.slice('TERMINAL_FAILED:'.length));
      }
      throw error;
    }
  }

  private async emitPaymentConfirmed(payment: PaymentWithOrder): Promise<void> {
    await this.eventEmitter.emitAsync(
      PaymentConfirmedEvent.eventName,
      new PaymentConfirmedEvent(
        payment.order.customerId,
        payment.orderId,
        payment.amount.toString(),
        payment.currency,
      ),
    );
  }

  private getAdapter(provider: PaymentProviderName): PaymentProviderAdapter {
    return provider === 'WIPAY' ? this.wiPayAdapter : this.cashOnDeliveryAdapter;
  }

  private static toPaymentResponse(payment: PaymentWithOrder): PaymentResponseEntity {
    return {
      id: payment.id,
      orderId: payment.orderId,
      provider: payment.provider,
      status: payment.status,
      initiationStatus: payment.initiationStatus,
      amount: payment.amount.toString(),
      currency: payment.currency,
      paidAt: payment.paidAt,
      createdAt: payment.createdAt,
    };
  }

  private static toRefundResponse(refund: Refund): RefundResponseEntity {
    return {
      id: refund.id,
      paymentId: refund.paymentId,
      amount: refund.amount.toString(),
      reason: refund.reason,
      status: refund.status,
      createdAt: refund.createdAt,
    };
  }
}
