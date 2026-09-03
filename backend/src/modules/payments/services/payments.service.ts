import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentProviderName, Refund } from '@prisma/client';

import { PaymentConfirmedEvent } from '../../../common/events/payment-confirmed.event';
import { RefundStatusChangedEvent } from '../../../common/events/refund-status-changed.event';
import { PaymentInitiationResponseEntity } from '../entities/payment-initiation-response.entity';
import { PaymentResponseEntity } from '../entities/payment-response.entity';
import { RefundResponseEntity } from '../entities/refund-response.entity';
import {
  PaymentCreateInput,
  PaymentProviderAdapter,
} from '../interfaces/payment-provider.interface';
import { CashOnDeliveryAdapter } from '../providers/cash-on-delivery.adapter';
import { WiPayAdapter } from '../providers/wipay.adapter';
import { PaymentsRepository, PaymentWithOrder } from '../repositories/payments.repository';
import { RefundsRepository } from '../repositories/refunds.repository';

export interface WiPayWebhookPayload {
  transaction_id: string;
  status: 'success' | 'failed';
  message?: string;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly paymentsRepository: PaymentsRepository,
    private readonly refundsRepository: RefundsRepository,
    private readonly wiPayAdapter: WiPayAdapter,
    private readonly cashOnDeliveryAdapter: CashOnDeliveryAdapter,
    private readonly eventEmitter: EventEmitter2,
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

  async handleWiPayWebhook(rawBody: string, signature: string): Promise<void> {
    if (!this.wiPayAdapter.verifyWebhookSignature(rawBody, signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const payload = JSON.parse(rawBody) as WiPayWebhookPayload;
    const payment = await this.paymentsRepository.findByProviderReference(payload.transaction_id);
    if (!payment) {
      return;
    }

    if (payload.status === 'success') {
      const { payment: updated, transitioned } =
        await this.paymentsRepository.transitionToPaid(payment.id);

      if (!updated) {
        throw new Error(
          `Internal consistency error: payment "${payment.id}" disappeared after PAID transition`,
        );
      }

      if (transitioned) {
        await this.emitPaymentConfirmed(updated);
      }
    } else {
      await this.paymentsRepository.transitionToFailed(
        payment.id,
        payload.message ?? 'Payment failed',
      );
    }
  }

  async refundForOrder(orderId: string, amount: number, reason: string): Promise<Refund | null> {
    const payment = await this.paymentsRepository.findByOrderId(orderId);
    if (!payment || (payment.status !== 'PAID' && payment.status !== 'PARTIALLY_REFUNDED')) {
      return null;
    }
    return this.executeRefund(payment, amount, reason);
  }

  async refundByPaymentId(
    paymentId: string,
    amount: number,
    reason: string,
  ): Promise<RefundResponseEntity> {
    const payment = await this.paymentsRepository.findById(paymentId);
    if (!payment) {
      throw new BadRequestException('Payment not found');
    }
    if (payment.status !== 'PAID' && payment.status !== 'PARTIALLY_REFUNDED') {
      throw new BadRequestException('Only a paid payment can be refunded');
    }

    const refund = await this.executeRefund(payment, amount, reason);
    if (!refund) {
      throw new BadRequestException('Refund amount exceeds the remaining refundable balance');
    }
    return PaymentsService.toRefundResponse(refund);
  }

  private async executeRefund(
    payment: PaymentWithOrder,
    amount: number,
    reason: string,
  ): Promise<Refund | null> {
    const alreadyRefunded = await this.refundsRepository.sumCompletedByPaymentId(payment.id);
    const remaining = payment.amount.toNumber() - alreadyRefunded;
    if (amount <= 0 || amount > remaining) {
      return null;
    }

    const adapter = this.getAdapter(payment.provider);
    const result = await adapter.refundPayment(payment.providerReference ?? payment.id, amount, reason);

    const refund = await this.refundsRepository.create({
      paymentId: payment.id,
      amount,
      reason,
      status: result.status,
      providerReference: result.providerReference,
    });

    if (result.status === 'COMPLETED') {
      const totalRefunded = alreadyRefunded + amount;
      const newStatus = totalRefunded >= payment.amount.toNumber() ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      await this.paymentsRepository.update(payment.id, { status: newStatus });
    }

    await this.eventEmitter.emitAsync(
      RefundStatusChangedEvent.eventName,
      new RefundStatusChangedEvent(payment.order.customerId, refund.amount.toString(), refund.status),
    );

    return refund;
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
