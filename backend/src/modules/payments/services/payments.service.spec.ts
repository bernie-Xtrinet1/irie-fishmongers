import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
  NotImplementedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, Refund } from '@prisma/client';

import { CashOnDeliveryAdapter } from '../providers/cash-on-delivery.adapter';
import { WiPayAdapter } from '../providers/wipay.adapter';
import { PaymentsRepository, PaymentWithOrder } from '../repositories/payments.repository';
import { RefundAttemptsRepository } from '../repositories/refund-attempts.repository';
import { RefundsRepository } from '../repositories/refunds.repository';
import { PaymentsService } from './payments.service';

function buildPayment(overrides: Partial<PaymentWithOrder> = {}): PaymentWithOrder {
  return {
    id: 'payment-1',
    orderId: 'order-1',
    provider: 'CASH_ON_DELIVERY',
    merchantAccountId: 'default',
    status: 'PENDING',
    initiationStatus: 'NOT_STARTED',
    amount: new Prisma.Decimal(1000),
    currency: 'JMD',
    providerReference: null,
    failureReason: null,
    paidAt: null,
    recoveryAttemptCount: 0,
    recoveryStartedAt: null,
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
    obligationId: 'obligation-1',
    supersedesRefundId: null,
    amount: new Prisma.Decimal(500),
    reason: 'Vendor rejected order',
    status: 'COMPLETED',
    providerReference: 'cod-refund-1',
    idempotencyKey: null,
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
      | 'findCustomerEmailForOrder'
      | 'claimInitiation'
      | 'findById'
      | 'findByOrderId'
      | 'findByProviderReference'
      | 'transitionToPaid'
      | 'transitionToFailed'
      | 'update'
    >
  >;
  let refundsRepository: jest.Mocked<Pick<RefundsRepository, 'sumCompletedByPaymentId' | 'create'>>;
  let refundAttemptsRepository: jest.Mocked<
    Pick<
      RefundAttemptsRepository,
      | 'prepareAndClaimAttempt'
      | 'recordPreSendAbort'
      | 'recordSyncOutcomeAndOutbox'
      | 'quarantineAttemptOutcome'
    >
  >;
  let wiPayAdapter: jest.Mocked<
    Pick<WiPayAdapter, 'createPayment' | 'refundPayment' | 'verifyTransactionResponse'>
  >;
  let cashOnDeliveryAdapter: jest.Mocked<
    Pick<CashOnDeliveryAdapter, 'createPayment' | 'refundPayment'>
  >;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emitAsync'>>;
  let service: PaymentsService;

  beforeEach(() => {
    paymentsRepository = {
      createOrGetByOrderId: jest.fn(),
      findCustomerEmailForOrder: jest.fn().mockResolvedValue('stored@example.com'),
      claimInitiation: jest.fn(),
      findById: jest.fn(),
      findByOrderId: jest.fn(),
      findByProviderReference: jest.fn(),
      transitionToPaid: jest.fn(),
      transitionToFailed: jest.fn(),
      update: jest.fn(),
    };
    refundsRepository = { sumCompletedByPaymentId: jest.fn(), create: jest.fn() };
    refundAttemptsRepository = {
      prepareAndClaimAttempt: jest.fn(),
      recordPreSendAbort: jest.fn(),
      recordSyncOutcomeAndOutbox: jest.fn(),
      quarantineAttemptOutcome: jest.fn(),
    };
    wiPayAdapter = {
      createPayment: jest.fn(),
      refundPayment: jest.fn(),
      verifyTransactionResponse: jest.fn(),
    };
    cashOnDeliveryAdapter = { createPayment: jest.fn(), refundPayment: jest.fn() };
    eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) };

    service = new PaymentsService(
      paymentsRepository as unknown as PaymentsRepository,
      refundsRepository as unknown as RefundsRepository,
      wiPayAdapter as unknown as WiPayAdapter,
      cashOnDeliveryAdapter as unknown as CashOnDeliveryAdapter,
      eventEmitter as unknown as EventEmitter2,
      refundAttemptsRepository as unknown as RefundAttemptsRepository,
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
      expect(result?.initiationStatus).toBe('NOT_STARTED');
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
    it('emits payment.confirmed when this caller transitions COD to PAID', async () => {
      const pending = buildPayment();
      const paid = buildPayment({
        status: 'PAID',
        paidAt: new Date('2026-09-03T01:00:00.000Z'),
      });

      paymentsRepository.findById.mockResolvedValue(pending);
      paymentsRepository.transitionToPaid.mockResolvedValue({
        payment: paid,
        transitioned: true,
      });

      const result = await service.markCashOnDeliveryPaid('payment-1');

      expect(paymentsRepository.transitionToPaid).toHaveBeenCalledWith('payment-1');
      expect(result.status).toBe('PAID');
      expect(eventEmitter.emitAsync).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'payment.confirmed',
        expect.objectContaining({ customerId: 'user-1', orderId: 'order-1' }),
      );
    });

    it('does not emit again when COD is already PAID', async () => {
      const paid = buildPayment({
        status: 'PAID',
        paidAt: new Date('2026-09-03T01:00:00.000Z'),
      });

      paymentsRepository.findById.mockResolvedValue(paid);
      paymentsRepository.transitionToPaid.mockResolvedValue({
        payment: paid,
        transitioned: false,
      });

      const result = await service.markCashOnDeliveryPaid('payment-1');

      expect(result.status).toBe('PAID');
      expect(paymentsRepository.transitionToPaid).toHaveBeenCalledWith('payment-1');
      expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
    });

    it('throws when the payment does not exist', async () => {
      paymentsRepository.findById.mockResolvedValue(null);

      await expect(
        service.markCashOnDeliveryPaid('missing'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(paymentsRepository.transitionToPaid).not.toHaveBeenCalled();
    });

    it('throws when the payment is not cash on delivery', async () => {
      paymentsRepository.findById.mockResolvedValue(
        buildPayment({ provider: 'WIPAY' }),
      );

      await expect(
        service.markCashOnDeliveryPaid('payment-1'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(paymentsRepository.transitionToPaid).not.toHaveBeenCalled();
    });

    it('throws an internal consistency error when the payment disappears after transition', async () => {
      paymentsRepository.findById.mockResolvedValue(buildPayment());
      paymentsRepository.transitionToPaid.mockResolvedValue({
        payment: null,
        transitioned: true,
      });

      await expect(
        service.markCashOnDeliveryPaid('payment-1'),
      ).rejects.toThrow('Internal consistency error');

      expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
    });
  });

  describe('WiPay browser return', () => {
    const payload = { transaction_id: 'txn-1', status: 'success', hash: 'provider-hash' };
    beforeEach(() => {
      paymentsRepository.findByProviderReference.mockResolvedValue(
        buildPayment({ provider: 'WIPAY', providerReference: 'txn-1' }),
      );
      wiPayAdapter.verifyTransactionResponse.mockReturnValue(true);
      paymentsRepository.transitionToPaid.mockResolvedValue({
        payment: buildPayment({ provider: 'WIPAY', providerReference: 'txn-1', status: 'PAID' }),
        transitioned: true,
      });
    });

    it('verifies against stored values and emits only authoritative payment/order/customer fields', async () => {
      const hostile = {
        ...payload,
        total: '1.00',
        amount: 1,
        currency: 'USD',
        order_id: 'other-order',
        orderId: 'other-order',
        customerId: 'other-user',
        provider: 'CASH_ON_DELIVERY',
      };
      await expect(service.handleWiPayReturn(hostile)).resolves.toEqual({ status: 'VERIFIED' });
      expect(wiPayAdapter.verifyTransactionResponse).toHaveBeenCalledWith(
        hostile,
        'txn-1',
        '1000.00',
      );
      expect(paymentsRepository.transitionToPaid).toHaveBeenCalledWith('payment-1');
      expect(paymentsRepository.update).not.toHaveBeenCalled();
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'payment.confirmed',
        expect.objectContaining({
          customerId: 'user-1',
          orderId: 'order-1',
          amount: '1000',
          currency: 'JMD',
        }),
      );
    });

    it('emits once for duplicate success returns', async () => {
      paymentsRepository.transitionToPaid
        .mockResolvedValueOnce({ payment: buildPayment({ status: 'PAID' }), transitioned: true })
        .mockResolvedValueOnce({ payment: buildPayment({ status: 'PAID' }), transitioned: false });
      await service.handleWiPayReturn(payload);
      await service.handleWiPayReturn(payload);
      expect(eventEmitter.emitAsync).toHaveBeenCalledTimes(1);
    });

    it.each(['PENDING', 'PAID', 'FAILED'] as const)(
      'duplicate unsigned failure/error cannot mutate %s or cause side effects',
      async (status) => {
        paymentsRepository.findByProviderReference.mockResolvedValue(
          buildPayment({ provider: 'WIPAY', providerReference: 'txn-1', status }),
        );
        for (const result of ['failed', 'failed', 'error']) {
          await expect(service.handleWiPayReturn({ ...payload, status: result })).resolves.toEqual({
            status: 'UNVERIFIED',
          });
        }
        expect(paymentsRepository.transitionToFailed).not.toHaveBeenCalled();
        expect(paymentsRepository.transitionToPaid).not.toHaveBeenCalled();
        expect(paymentsRepository.update).not.toHaveBeenCalled();
        expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
      },
    );

    it('success followed by failure never downgrades PAID', async () => {
      await service.handleWiPayReturn(payload);
      await service.handleWiPayReturn({ ...payload, status: 'failed' });
      expect(paymentsRepository.transitionToPaid).toHaveBeenCalledTimes(1);
      expect(paymentsRepository.transitionToFailed).not.toHaveBeenCalled();
      expect(eventEmitter.emitAsync).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid hash before any mutation', async () => {
      wiPayAdapter.verifyTransactionResponse.mockReturnValue(false);
      await expect(service.handleWiPayReturn(payload)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(paymentsRepository.transitionToPaid).not.toHaveBeenCalled();
      expect(paymentsRepository.update).not.toHaveBeenCalled();
      expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
    });

    it.each([
      {},
      { transaction_id: ['txn-1'], status: 'success' },
      { transaction_id: 'txn-1', status: ['success'] },
      { transaction_id: 'txn-1', status: 'unknown' },
    ])('rejects malformed return %j', async (query) => {
      await expect(service.handleWiPayReturn(query)).rejects.toBeInstanceOf(BadRequestException);
      expect(paymentsRepository.findByProviderReference).not.toHaveBeenCalled();
    });

    it.each([
      null,
      buildPayment({ provider: 'CASH_ON_DELIVERY', providerReference: 'txn-1' }),
      buildPayment({ provider: 'WIPAY', providerReference: 'other' }),
    ])('rejects unknown or mismatched provider references', async (payment) => {
      paymentsRepository.findByProviderReference.mockResolvedValue(payment);
      await expect(service.handleWiPayReturn(payload)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(paymentsRepository.createOrGetByOrderId).not.toHaveBeenCalled();
      expect(paymentsRepository.transitionToPaid).not.toHaveBeenCalled();
    });

    it('fails on a disappeared payment without emitting', async () => {
      paymentsRepository.transitionToPaid.mockResolvedValue({ payment: null, transitioned: true });
      await expect(service.handleWiPayReturn(payload)).rejects.toThrow(
        'Internal consistency error',
      );
      expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
    });

    it('disables the former invented webhook scheme even for well-formed input', async () => {
      await expect(
        service.handleWiPayWebhook(JSON.stringify(payload), 'signature'),
      ).rejects.toBeInstanceOf(NotImplementedException);
      expect(paymentsRepository.findByProviderReference).not.toHaveBeenCalled();
      expect(paymentsRepository.transitionToPaid).not.toHaveBeenCalled();
    });
  });
  describe('refundForOrder', () => {
    const buildDispatchPrep = (amount = 500) => ({
      action: 'DISPATCH' as const,
      obligation: { id: 'obligation-1', authorizedAmount: new Prisma.Decimal(amount) } as any,
      refund: buildRefund({ status: 'PROCESSING', amount: new Prisma.Decimal(amount) }),
      attempt: {
        id: 'attempt-1',
        providerIdempotencyKey: 'refund:obligation-1:att:1',
        attemptSequence: 1,
      } as any,
      parentPaymentReference: 'cod-order-1',
      remainingBalance: new Prisma.Decimal(1000 - amount),
    });

    it('returns null when the order has no payment', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(null);
      await expect(service.refundForOrder('order-1', 500, 'Vendor rejected order')).resolves.toBeNull();
    });

    it('returns null when the payment has not been paid', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(buildPayment({ status: 'PENDING' }));
      await expect(service.refundForOrder('order-1', 500, 'Vendor rejected order')).resolves.toBeNull();
    });

    it('dispatches a partial refund via two-transaction boundary and emits event', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(
        buildPayment({ status: 'PAID', providerReference: 'cod-order-1' }),
      );
      refundAttemptsRepository.prepareAndClaimAttempt.mockResolvedValue(buildDispatchPrep(500));
      cashOnDeliveryAdapter.refundPayment.mockResolvedValue({
        providerReference: 'cod-refund-attempt-1',
        status: 'COMPLETED',
      });
      const completedRefund = buildRefund({ status: 'COMPLETED' });
      refundAttemptsRepository.recordSyncOutcomeAndOutbox.mockResolvedValue({
        obligation: { id: 'obligation-1', status: 'FULFILLED' } as any,
        refund: completedRefund,
        attempt: { id: 'attempt-1', status: 'COMPLETED' } as any,
        outboxEventId: 'outbox-1',
      });

      const refund = await service.refundForOrder('order-1', 500, 'Vendor rejected order', 'idem-500-key');

      expect(refund).toEqual(completedRefund);
      expect(refundAttemptsRepository.recordSyncOutcomeAndOutbox).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptId: 'attempt-1',
          providerOutcome: 'COMPLETED',
          providerRefundReference: 'cod-refund-attempt-1',
        }),
      );
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'refund.status_changed',
        expect.objectContaining({ customerId: 'user-1', status: 'COMPLETED' }),
      );
    });

    it('returns existing refund without calling provider adapter when RETURN_EXISTING', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(buildPayment({ status: 'PAID' }));
      const pendingRefund = buildRefund({ status: 'PENDING' });
      refundAttemptsRepository.prepareAndClaimAttempt.mockResolvedValue({
        action: 'RETURN_EXISTING',
        refund: pendingRefund,
        remainingBalance: new Prisma.Decimal(0),
      });

      const refund = await service.refundForOrder('order-1', 500, 'Vendor rejected order', 'idem-pending');
      expect(refund).toEqual(pendingRefund);
      expect(cashOnDeliveryAdapter.refundPayment).not.toHaveBeenCalled();
    });

    it('records pre-send abort on unsupported WiPay refund without calling outbox outcome', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(
        buildPayment({ status: 'PAID', provider: 'WIPAY', providerReference: 'wipay-txn-1' }),
      );
      refundAttemptsRepository.prepareAndClaimAttempt.mockResolvedValue(buildDispatchPrep(500));
      wiPayAdapter.refundPayment.mockRejectedValue(new NotImplementedException('WiPay unsupported'));
      refundAttemptsRepository.recordPreSendAbort.mockResolvedValue({} as any);

      await expect(
        service.refundForOrder('order-1', 500, 'Vendor rejected order', 'idem-wipay-1'),
      ).rejects.toBeInstanceOf(NotImplementedException);
      expect(refundAttemptsRepository.recordPreSendAbort).toHaveBeenCalledTimes(1);
      expect(refundAttemptsRepository.recordSyncOutcomeAndOutbox).not.toHaveBeenCalled();
    });

    it('quarantines ambiguous attempt on transport failure without releasing capacity', async () => {
      paymentsRepository.findByOrderId.mockResolvedValue(
        buildPayment({ status: 'PAID', providerReference: 'cod-order-1' }),
      );
      refundAttemptsRepository.prepareAndClaimAttempt.mockResolvedValue(buildDispatchPrep(500));
      cashOnDeliveryAdapter.refundPayment.mockRejectedValue(new Error('ETIMEDOUT'));
      refundAttemptsRepository.quarantineAttemptOutcome.mockResolvedValue({} as any);

      await expect(
        service.refundForOrder('order-1', 500, 'Vendor rejected order', 'idem-timeout-1'),
      ).rejects.toThrow('ETIMEDOUT');
      expect(refundAttemptsRepository.quarantineAttemptOutcome).toHaveBeenCalledTimes(1);
      expect(refundAttemptsRepository.recordSyncOutcomeAndOutbox).not.toHaveBeenCalled();
    });
  });

  describe('refundByPaymentId', () => {
    const validKey = '11111111-1111-4111-8111-111111111111';

    it('rejects missing or invalid idempotency keys', async () => {
      await expect(
        service.refundByPaymentId('payment-1', 500, 'Admin adjustment'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the payment does not exist', async () => {
      paymentsRepository.findById.mockResolvedValue(null);
      await expect(
        service.refundByPaymentId('missing', 500, 'Admin adjustment', validKey),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the payment has not been paid', async () => {
      paymentsRepository.findById.mockResolvedValue(buildPayment({ status: 'PENDING' }));
      await expect(
        service.refundByPaymentId('payment-1', 500, 'Admin adjustment', validKey),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the refund amount exceeds remaining obligated balance', async () => {
      paymentsRepository.findById.mockResolvedValue(buildPayment({ status: 'PAID' }));
      refundAttemptsRepository.prepareAndClaimAttempt.mockResolvedValue({
        action: 'EXCEEDS_BALANCE',
        remainingBalance: new Prisma.Decimal(200),
      });

      await expect(
        service.refundByPaymentId('payment-1', 500, 'Admin adjustment', validKey),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('issues a refund within the remaining balance via two-transaction dispatch', async () => {
      paymentsRepository.findById.mockResolvedValue(
        buildPayment({ status: 'PAID', providerReference: 'cod-order-1' }),
      );
      refundAttemptsRepository.prepareAndClaimAttempt.mockResolvedValue({
        action: 'DISPATCH',
        obligation: { id: 'obligation-1', authorizedAmount: new Prisma.Decimal(500) } as any,
        refund: buildRefund({ status: 'PROCESSING' }),
        attempt: {
          id: 'attempt-1',
          providerIdempotencyKey: 'refund:obligation-1:att:1',
          attemptSequence: 1,
        } as any,
        parentPaymentReference: 'cod-order-1',
        remainingBalance: new Prisma.Decimal(500),
      });
      cashOnDeliveryAdapter.refundPayment.mockResolvedValue({
        providerReference: 'cod-refund-attempt-1',
        status: 'COMPLETED',
      });
      refundAttemptsRepository.recordSyncOutcomeAndOutbox.mockResolvedValue({
        obligation: { id: 'obligation-1', status: 'FULFILLED' } as any,
        refund: buildRefund({ status: 'COMPLETED' }),
        attempt: { id: 'attempt-1', status: 'COMPLETED' } as any,
        outboxEventId: 'outbox-1',
      });

      const result = await service.refundByPaymentId('payment-1', 500, 'Admin adjustment', validKey);
      expect(result.status).toBe('COMPLETED');
    });
  });
});
