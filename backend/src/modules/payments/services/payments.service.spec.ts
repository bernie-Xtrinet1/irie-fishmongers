import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, Refund } from '@prisma/client';

import { CashOnDeliveryAdapter } from '../providers/cash-on-delivery.adapter';
import { WiPayAdapter } from '../providers/wipay.adapter';
import { PaymentsRepository, PaymentWithOrder } from '../repositories/payments.repository';
import { RefundsRepository } from '../repositories/refunds.repository';
import { PaymentsService } from './payments.service';

function buildPayment(overrides: Partial<PaymentWithOrder> = {}): PaymentWithOrder {
  return {
    id: 'payment-1',
    orderId: 'order-1',
    provider: 'CASH_ON_DELIVERY',
    status: 'PENDING',
    initiationStatus: 'NOT_STARTED',
    amount: new Prisma.Decimal(1000),
    currency: 'JMD',
    providerReference: null,
    failureReason: null,
    paidAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    order: { customerId: 'user-1' },
    ...overrides,
  };
}

function buildRefund(overrides: Partial<Refund> = {}): Refund {
  return {
    id: 'refund-1',
    paymentId: 'payment-1',
    amount: new Prisma.Decimal(500),
    reason: 'Vendor rejected order',
    status: 'COMPLETED',
    providerReference: 'wipay-refund-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('PaymentsService', () => {
  let paymentsRepository: jest.Mocked<
    Pick<
      PaymentsRepository,
      | 'createOrGetByOrderId'
      | 'claimInitiation'
      | 'findById'
      | 'findByOrderId'
      | 'findByProviderReference'
      | 'update'
    >
  >;
  let refundsRepository: jest.Mocked<Pick<RefundsRepository, 'sumCompletedByPaymentId' | 'create'>>;
  let wiPayAdapter: jest.Mocked<Pick<WiPayAdapter, 'createPayment' | 'refundPayment' | 'verifyWebhookSignature'>>;
  let cashOnDeliveryAdapter: jest.Mocked<Pick<CashOnDeliveryAdapter, 'createPayment' | 'refundPayment'>>;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emitAsync'>>;
  let service: PaymentsService;

  beforeEach(() => {
    paymentsRepository = {
      createOrGetByOrderId: jest.fn(),
      claimInitiation: jest.fn(),
      findById: jest.fn(),
      findByOrderId: jest.fn(),
      findByProviderReference: jest.fn(),
      update: jest.fn(),
    };
    refundsRepository = { sumCompletedByPaymentId: jest.fn(), create: jest.fn() };
    wiPayAdapter = {
      createPayment: jest.fn(),
      refundPayment: jest.fn(),
      verifyWebhookSignature: jest.fn(),
    };
    cashOnDeliveryAdapter = { createPayment: jest.fn(), refundPayment: jest.fn() };
    eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) };

    service = new PaymentsService(
      paymentsRepository as unknown as PaymentsRepository,
      refundsRepository as unknown as RefundsRepository,
      wiPayAdapter as unknown as WiPayAdapter,
      cashOnDeliveryAdapter as unknown as CashOnDeliveryAdapter,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('initiatePayment', () => {
    it('creates the durable payment before claiming provider initiation', async () => {
      const payment = buildPayment();

      paymentsRepository.createOrGetByOrderId.mockResolvedValue({
        payment,
        created: true,
      });
      paymentsRepository.claimInitiation.mockResolvedValue(true);
      cashOnDeliveryAdapter.createPayment.mockResolvedValue({
        providerReference: 'cod-order-1',
        status: 'PENDING',
      });
      paymentsRepository.update.mockResolvedValue(
        buildPayment({
          initiationStatus: 'ESTABLISHED',
          providerReference: 'cod-order-1',
        }),
      );

      await service.initiatePayment({
        orderId: 'order-1',
        amount: 1000,
        currency: 'JMD',
        provider: 'CASH_ON_DELIVERY',
      });

      expect(paymentsRepository.createOrGetByOrderId).toHaveBeenCalledWith({
        orderId: 'order-1',
        provider: 'CASH_ON_DELIVERY',
        amount: 1000,
        currency: 'JMD',
      });
      expect(paymentsRepository.claimInitiation).toHaveBeenCalledWith(payment.id);
      expect(cashOnDeliveryAdapter.createPayment).toHaveBeenCalledTimes(1);
    });

    it('persists ESTABLISHED after the provider successfully creates a pending payment', async () => {
      const payment = buildPayment();

      paymentsRepository.createOrGetByOrderId.mockResolvedValue({
        payment,
        created: true,
      });
      paymentsRepository.claimInitiation.mockResolvedValue(true);
      cashOnDeliveryAdapter.createPayment.mockResolvedValue({
        providerReference: 'cod-order-1',
        status: 'PENDING',
      });
      paymentsRepository.update.mockResolvedValue(
        buildPayment({
          initiationStatus: 'ESTABLISHED',
          providerReference: 'cod-order-1',
        }),
      );

      const result = await service.initiatePayment({
        orderId: 'order-1',
        amount: 1000,
        currency: 'JMD',
        provider: 'CASH_ON_DELIVERY',
      });

      expect(paymentsRepository.update).toHaveBeenCalledWith(payment.id, {
        initiationStatus: 'ESTABLISHED',
        status: 'PENDING',
        providerReference: 'cod-order-1',
      });
      expect(result.payment.status).toBe('PENDING');
    });

    it('uses the durable payment values for the provider request', async () => {
      const payment = buildPayment({
        amount: new Prisma.Decimal(1250),
        currency: 'JMD',
      });

      paymentsRepository.createOrGetByOrderId.mockResolvedValue({
        payment,
        created: false,
      });
      paymentsRepository.claimInitiation.mockResolvedValue(true);
      cashOnDeliveryAdapter.createPayment.mockResolvedValue({
        providerReference: 'cod-order-1',
        status: 'PENDING',
      });
      paymentsRepository.update.mockResolvedValue(
        buildPayment({
          amount: new Prisma.Decimal(1250),
          initiationStatus: 'ESTABLISHED',
          providerReference: 'cod-order-1',
        }),
      );

      await service.initiatePayment({
        orderId: 'order-1',
        amount: 9999,
        currency: 'JMD',
        provider: 'CASH_ON_DELIVERY',
      });

      expect(cashOnDeliveryAdapter.createPayment).toHaveBeenCalledWith({
        orderId: 'order-1',
        amount: 1250,
        currency: 'JMD',
      });
    });

    it('returns the hosted checkout redirect to the winning caller', async () => {
      const payment = buildPayment({ provider: 'WIPAY' });

      paymentsRepository.createOrGetByOrderId.mockResolvedValue({
        payment,
        created: true,
      });
      paymentsRepository.claimInitiation.mockResolvedValue(true);
      wiPayAdapter.createPayment.mockResolvedValue({
        providerReference: 'txn-1',
        redirectUrl: 'https://tx.wipayfinancial.com/checkout/txn-1',
        status: 'PENDING',
      });
      paymentsRepository.update.mockResolvedValue(
        buildPayment({
          provider: 'WIPAY',
          initiationStatus: 'ESTABLISHED',
          providerReference: 'txn-1',
        }),
      );

      const result = await service.initiatePayment({
        orderId: 'order-1',
        amount: 1000,
        currency: 'JMD',
        provider: 'WIPAY',
      });

      expect(result.redirectUrl).toBe('https://tx.wipayfinancial.com/checkout/txn-1');
    });

    it('does not call the provider again for an ESTABLISHED payment', async () => {
      const payment = buildPayment({
        initiationStatus: 'ESTABLISHED',
        providerReference: 'cod-order-1',
      });

      paymentsRepository.createOrGetByOrderId.mockResolvedValue({
        payment,
        created: false,
      });

      const result = await service.initiatePayment({
        orderId: 'order-1',
        amount: 1000,
        currency: 'JMD',
        provider: 'CASH_ON_DELIVERY',
      });

      expect(result.payment.id).toBe(payment.id);
      expect(paymentsRepository.claimInitiation).not.toHaveBeenCalled();
      expect(cashOnDeliveryAdapter.createPayment).not.toHaveBeenCalled();
    });

    it.each(['INITIATING', 'RECONCILE_REQUIRED'] as const)(
      'does not call the provider again when initiation is %s',
      async (initiationStatus) => {
        const payment = buildPayment({ initiationStatus });

        paymentsRepository.createOrGetByOrderId.mockResolvedValue({
          payment,
          created: false,
        });

        await service.initiatePayment({
          orderId: 'order-1',
          amount: 1000,
          currency: 'JMD',
          provider: 'CASH_ON_DELIVERY',
        });

        expect(paymentsRepository.claimInitiation).not.toHaveBeenCalled();
        expect(cashOnDeliveryAdapter.createPayment).not.toHaveBeenCalled();
      },
    );

    it('re-reads the authoritative payment when another caller wins the initiation claim', async () => {
      const payment = buildPayment();
      const current = buildPayment({ initiationStatus: 'INITIATING' });

      paymentsRepository.createOrGetByOrderId.mockResolvedValue({
        payment,
        created: false,
      });
      paymentsRepository.claimInitiation.mockResolvedValue(false);
      paymentsRepository.findById.mockResolvedValue(current);

      const result = await service.initiatePayment({
        orderId: 'order-1',
        amount: 1000,
        currency: 'JMD',
        provider: 'CASH_ON_DELIVERY',
      });

      expect(paymentsRepository.findById).toHaveBeenCalledWith(payment.id);
      expect(result.payment.id).toBe(current.id);
      expect(cashOnDeliveryAdapter.createPayment).not.toHaveBeenCalled();
    });

    it('throws an internal consistency error if the payment disappears after a lost claim', async () => {
      const payment = buildPayment();

      paymentsRepository.createOrGetByOrderId.mockResolvedValue({
        payment,
        created: false,
      });
      paymentsRepository.claimInitiation.mockResolvedValue(false);
      paymentsRepository.findById.mockResolvedValue(null);

      await expect(
        service.initiatePayment({
          orderId: 'order-1',
          amount: 1000,
          currency: 'JMD',
          provider: 'CASH_ON_DELIVERY',
        }),
      ).rejects.toThrow('Internal consistency error');

      expect(cashOnDeliveryAdapter.createPayment).not.toHaveBeenCalled();
    });

    it('rejects an attempt to switch providers for an existing payment', async () => {
      const payment = buildPayment({ provider: 'WIPAY' });

      paymentsRepository.createOrGetByOrderId.mockResolvedValue({
        payment,
        created: false,
      });

      await expect(
        service.initiatePayment({
          orderId: 'order-1',
          amount: 1000,
          currency: 'JMD',
          provider: 'CASH_ON_DELIVERY',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(paymentsRepository.claimInitiation).not.toHaveBeenCalled();
      expect(cashOnDeliveryAdapter.createPayment).not.toHaveBeenCalled();
      expect(wiPayAdapter.createPayment).not.toHaveBeenCalled();
    });

    it('throws when the durable payment has already been paid', async () => {
      const payment = buildPayment({ status: 'PAID' });

      paymentsRepository.createOrGetByOrderId.mockResolvedValue({
        payment,
        created: false,
      });

      await expect(
        service.initiatePayment({
          orderId: 'order-1',
          amount: 1000,
          currency: 'JMD',
          provider: 'CASH_ON_DELIVERY',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(paymentsRepository.claimInitiation).not.toHaveBeenCalled();
      expect(cashOnDeliveryAdapter.createPayment).not.toHaveBeenCalled();
    });

    it('does not mark RECONCILE_REQUIRED when persistence fails after provider success', async () => {
      const payment = buildPayment({ provider: 'WIPAY' });
      const persistenceError = new Error('database write failed');

      paymentsRepository.createOrGetByOrderId.mockResolvedValue({
        payment,
        created: true,
      });
      paymentsRepository.claimInitiation.mockResolvedValue(true);
      wiPayAdapter.createPayment.mockResolvedValue({
        providerReference: 'txn-1',
        redirectUrl: 'https://tx.wipayfinancial.com/checkout/txn-1',
        status: 'PENDING',
      });
      paymentsRepository.update.mockRejectedValue(persistenceError);

      await expect(
        service.initiatePayment({
          orderId: 'order-1',
          amount: 1000,
          currency: 'JMD',
          provider: 'WIPAY',
        }),
      ).rejects.toBe(persistenceError);

      expect(paymentsRepository.update).toHaveBeenCalledTimes(1);
      expect(paymentsRepository.update).toHaveBeenCalledWith(payment.id, {
        initiationStatus: 'ESTABLISHED',
        status: 'PENDING',
        providerReference: 'txn-1',
      });

      expect(paymentsRepository.update).not.toHaveBeenCalledWith(
        payment.id,
        expect.objectContaining({
          initiationStatus: 'RECONCILE_REQUIRED',
        }),
      );
    });

    it('marks initiation RECONCILE_REQUIRED and rethrows when provider creation throws', async () => {
      const payment = buildPayment({ provider: 'WIPAY' });
      const providerError = new Error('provider request timed out');

      paymentsRepository.createOrGetByOrderId.mockResolvedValue({
        payment,
        created: true,
      });
      paymentsRepository.claimInitiation.mockResolvedValue(true);
      wiPayAdapter.createPayment.mockRejectedValue(providerError);
      paymentsRepository.update.mockResolvedValue(
        buildPayment({
          provider: 'WIPAY',
          initiationStatus: 'RECONCILE_REQUIRED',
        }),
      );

      await expect(
        service.initiatePayment({
          orderId: 'order-1',
          amount: 1000,
          currency: 'JMD',
          provider: 'WIPAY',
        }),
      ).rejects.toBe(providerError);

      expect(paymentsRepository.update).toHaveBeenCalledWith(payment.id, {
        initiationStatus: 'RECONCILE_REQUIRED',
      });
    });

    it('persists PAID and emits payment.confirmed when the provider reports paid', async () => {
      const payment = buildPayment();

      paymentsRepository.createOrGetByOrderId.mockResolvedValue({
        payment,
        created: true,
      });
      paymentsRepository.claimInitiation.mockResolvedValue(true);
      cashOnDeliveryAdapter.createPayment.mockResolvedValue({
        providerReference: 'cod-order-1',
        status: 'PAID',
      });
      paymentsRepository.update.mockResolvedValue(
        buildPayment({
          initiationStatus: 'ESTABLISHED',
          providerReference: 'cod-order-1',
          status: 'PAID',
          paidAt: new Date(),
        }),
      );

      await service.initiatePayment({
        orderId: 'order-1',
        amount: 1000,
        currency: 'JMD',
        provider: 'CASH_ON_DELIVERY',
      });

      expect(paymentsRepository.update).toHaveBeenCalledWith(payment.id, {
        initiationStatus: 'ESTABLISHED',
        status: 'PAID',
        providerReference: 'cod-order-1',
        paidAt: expect.any(Date) as Date,
      });
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'payment.confirmed',
        expect.objectContaining({
          customerId: 'user-1',
          orderId: 'order-1',
        }),
      );
    });
  });

  describe('getByOrderId', () => {
    it('returns a mapped payment when one exists', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(buildPayment());
      const result = await service.getByOrderId('order-1');
      expect(result?.id).toBe('payment-1');
    });

    it('returns null when no payment exists for the order', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(null);
      await expect(service.getByOrderId('order-1')).resolves.toBeNull();
    });
  });

  describe('assertReadyForFulfillment', () => {
    it('allows fulfillment when no payment record exists', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(null);
      await expect(service.assertReadyForFulfillment('order-1')).resolves.toBeUndefined();
    });

    it('allows fulfillment for cash on delivery regardless of payment status', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(
        buildPayment({ provider: 'CASH_ON_DELIVERY', status: 'PENDING' }),
      );
      await expect(service.assertReadyForFulfillment('order-1')).resolves.toBeUndefined();
    });

    it('blocks fulfillment for an unpaid online payment', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(
        buildPayment({ provider: 'WIPAY', status: 'PENDING' }),
      );
      await expect(service.assertReadyForFulfillment('order-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('allows fulfillment once an online payment is paid', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(
        buildPayment({ provider: 'WIPAY', status: 'PAID' }),
      );
      await expect(service.assertReadyForFulfillment('order-1')).resolves.toBeUndefined();
    });
  });

  describe('markCashOnDeliveryPaid', () => {
    it('marks a cash-on-delivery payment as paid', async () => {
      paymentsRepository.findById.mockResolvedValue(buildPayment());
      paymentsRepository.update.mockResolvedValue(buildPayment({ status: 'PAID', paidAt: new Date() }));

      const result = await service.markCashOnDeliveryPaid('payment-1');
      expect(result.status).toBe('PAID');
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'payment.confirmed',
        expect.objectContaining({ customerId: 'user-1', orderId: 'order-1' }),
      );
    });

    it('throws when the payment does not exist', async () => {
      paymentsRepository.findById.mockResolvedValue(null);
      await expect(service.markCashOnDeliveryPaid('missing')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws when the payment is not cash on delivery', async () => {
      paymentsRepository.findById.mockResolvedValue(buildPayment({ provider: 'WIPAY' }));
      await expect(service.markCashOnDeliveryPaid('payment-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('handleWiPayWebhook', () => {
    it('throws when the signature is invalid', async () => {
      wiPayAdapter.verifyWebhookSignature.mockReturnValue(false);
      await expect(service.handleWiPayWebhook('{}', 'bad-signature')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('marks the payment paid on a successful webhook', async () => {
      wiPayAdapter.verifyWebhookSignature.mockReturnValue(true);
      paymentsRepository.findByProviderReference.mockResolvedValue(buildPayment({ provider: 'WIPAY' }));
      paymentsRepository.update.mockResolvedValue(
        buildPayment({ provider: 'WIPAY', status: 'PAID', paidAt: new Date() }),
      );

      await service.handleWiPayWebhook(
        JSON.stringify({ transaction_id: 'txn-1', status: 'success' }),
        'good-signature',
      );

      expect(paymentsRepository.update).toHaveBeenCalledWith('payment-1', {
        status: 'PAID',
        paidAt: expect.any(Date) as Date,
      });
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'payment.confirmed',
        expect.objectContaining({ customerId: 'user-1', orderId: 'order-1' }),
      );
    });

    it('marks the payment failed on a failed webhook', async () => {
      wiPayAdapter.verifyWebhookSignature.mockReturnValue(true);
      paymentsRepository.findByProviderReference.mockResolvedValue(buildPayment({ provider: 'WIPAY' }));

      await service.handleWiPayWebhook(
        JSON.stringify({ transaction_id: 'txn-1', status: 'failed', message: 'Card declined' }),
        'good-signature',
      );

      expect(paymentsRepository.update).toHaveBeenCalledWith('payment-1', {
        status: 'FAILED',
        failureReason: 'Card declined',
      });
    });

    it('does nothing when no payment matches the webhook transaction id', async () => {
      wiPayAdapter.verifyWebhookSignature.mockReturnValue(true);
      paymentsRepository.findByProviderReference.mockResolvedValue(null);

      await service.handleWiPayWebhook(
        JSON.stringify({ transaction_id: 'txn-unknown', status: 'success' }),
        'good-signature',
      );

      expect(paymentsRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('refundForOrder', () => {
    it('returns null when the order has no payment', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(null);
      await expect(service.refundForOrder('order-1', 500, 'Vendor rejected order')).resolves.toBeNull();
    });

    it('returns null when the payment has not been paid', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(buildPayment({ status: 'PENDING' }));
      await expect(service.refundForOrder('order-1', 500, 'Vendor rejected order')).resolves.toBeNull();
    });

    it('issues a partial refund for a paid order', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(buildPayment({ status: 'PAID' }));
      refundsRepository.sumCompletedByPaymentId.mockResolvedValue(0);
      cashOnDeliveryAdapter.refundPayment.mockResolvedValue({
        providerReference: 'cod-refund-1',
        status: 'COMPLETED',
      });
      refundsRepository.create.mockResolvedValue(buildRefund());

      const refund = await service.refundForOrder('order-1', 500, 'Vendor rejected order');

      expect(refund).not.toBeNull();
      expect(paymentsRepository.update).toHaveBeenCalledWith('payment-1', {
        status: 'PARTIALLY_REFUNDED',
      });
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'refund.status_changed',
        expect.objectContaining({ customerId: 'user-1', status: 'COMPLETED' }),
      );
    });

    it('marks the payment fully refunded once the whole amount is refunded', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(buildPayment({ status: 'PAID' }));
      refundsRepository.sumCompletedByPaymentId.mockResolvedValue(0);
      cashOnDeliveryAdapter.refundPayment.mockResolvedValue({
        providerReference: 'cod-refund-1',
        status: 'COMPLETED',
      });
      refundsRepository.create.mockResolvedValue(buildRefund({ amount: new Prisma.Decimal(1000) }));

      await service.refundForOrder('order-1', 1000, 'Vendor rejected order');

      expect(paymentsRepository.update).toHaveBeenCalledWith('payment-1', { status: 'REFUNDED' });
    });
  });

  describe('refundByPaymentId', () => {
    it('throws when the payment does not exist', async () => {
      paymentsRepository.findById.mockResolvedValue(null);
      await expect(
        service.refundByPaymentId('missing', 500, 'Admin adjustment'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the payment has not been paid', async () => {
      paymentsRepository.findById.mockResolvedValue(buildPayment({ status: 'PENDING' }));
      await expect(
        service.refundByPaymentId('payment-1', 500, 'Admin adjustment'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the refund amount exceeds the refundable balance', async () => {
      paymentsRepository.findById.mockResolvedValue(buildPayment({ status: 'PAID' }));
      refundsRepository.sumCompletedByPaymentId.mockResolvedValue(800);

      await expect(
        service.refundByPaymentId('payment-1', 500, 'Admin adjustment'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('issues a refund within the remaining balance', async () => {
      paymentsRepository.findById.mockResolvedValue(buildPayment({ status: 'PAID' }));
      refundsRepository.sumCompletedByPaymentId.mockResolvedValue(0);
      cashOnDeliveryAdapter.refundPayment.mockResolvedValue({
        providerReference: 'cod-refund-1',
        status: 'COMPLETED',
      });
      refundsRepository.create.mockResolvedValue(buildRefund());

      const result = await service.refundByPaymentId('payment-1', 500, 'Admin adjustment');
      expect(result.status).toBe('COMPLETED');
    });
  });
});
