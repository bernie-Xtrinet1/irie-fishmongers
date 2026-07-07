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
    const existing = await this.paymentsRepository.findByOrderId(input.orderId);
    if (existing && existing.status === 'PAID') {
      throw new ConflictException('This order has already been paid');
    }

    const adapter = this.getAdapter(input.provider);
    const result = await adapter.createPayment(input);
    const isPaid = result.status === 'PAID';

    const payment = existing
      ? await this.paymentsRepository.update(existing.id, {
          status: isPaid ? 'PAID' : 'PENDING',
          providerReference: result.providerReference,
          ...(isPaid ? { paidAt: new Date() } : {}),
        })
      : await this.paymentsRepository.create({
          orderId: input.orderId,
          provider: input.provider,
          amount: input.amount,
          currency: input.currency,
          providerReference: result.providerReference,
        });

    const finalPayment =
      !existing && isPaid
        ? await this.paymentsRepository.update(payment.id, { status: 'PAID', paidAt: new Date() })
        : payment;

    if (isPaid) {
      await this.emitPaymentConfirmed(finalPayment);
    }

    return { payment: PaymentsService.toPaymentResponse(finalPayment), redirectUrl: result.redirectUrl };
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
    const updated = await this.paymentsRepository.update(paymentId, {
      status: 'PAID',
      paidAt: new Date(),
    });
    await this.emitPaymentConfirmed(updated);
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
      const updated = await this.paymentsRepository.update(payment.id, {
        status: 'PAID',
        paidAt: new Date(),
      });
      await this.emitPaymentConfirmed(updated);
    } else {
      await this.paymentsRepository.update(payment.id, {
        status: 'FAILED',
        failureReason: payload.message ?? 'Payment failed',
      });
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
