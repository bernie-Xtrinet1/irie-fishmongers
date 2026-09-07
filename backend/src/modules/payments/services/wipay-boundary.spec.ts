import { createHash } from 'crypto';

import { NotImplementedException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { CashOnDeliveryAdapter } from '../providers/cash-on-delivery.adapter';
import { WiPayAdapter, WIPAY_SANDBOX_API_URL } from '../providers/wipay.adapter';
import { PaymentsRepository, PaymentWithOrder } from '../repositories/payments.repository';
import { RefundsRepository } from '../repositories/refunds.repository';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentsService } from './payments.service';

describe('WiPay service boundary with the real adapter', () => {
  const originalFetch = global.fetch;
  let payment: PaymentWithOrder;
  let repository: {
    createOrGetByOrderId: jest.Mock;
    claimInitiation: jest.Mock;
    update: jest.Mock;
    findCustomerEmailForOrder: jest.Mock;
    findById: jest.Mock;
    findByOrderId: jest.Mock;
    findByProviderReference: jest.Mock;
    transitionToPaid: jest.Mock;
    transitionToFailed: jest.Mock;
    claimForRecovery: jest.Mock;
    releaseRecoveryClaimIfCurrent: jest.Mock;
    applyRecoveryVerificationIfCurrent: jest.Mock;
  };
  let refunds: { create: jest.Mock; sumCompletedByPaymentId: jest.Mock };
  let events: { emitAsync: jest.Mock };
  let service: PaymentsService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    payment = {
      id: 'payment-1',
      orderId: 'order-1',
      provider: 'WIPAY',
      status: 'PENDING',
      initiationStatus: 'NOT_STARTED',
      amount: new Prisma.Decimal('1000.00'),
      currency: 'JMD',
      providerReference: null,
      failureReason: null,
      paidAt: null,
      recoveryAttemptCount: 1,
      recoveryStartedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      order: { customerId: 'customer-1' },
    };
    repository = {
      createOrGetByOrderId: jest
        .fn()
        .mockImplementation(() => Promise.resolve({ payment, created: false })),
      claimInitiation: jest.fn().mockResolvedValue(true),
      update: jest.fn().mockImplementation((_id: string, changes: Partial<PaymentWithOrder>) => {
        payment = { ...payment, ...changes };
        return Promise.resolve(payment);
      }),
      findCustomerEmailForOrder: jest.fn().mockResolvedValue('stored@example.com'),
      findById: jest.fn().mockImplementation(() => Promise.resolve(payment)),
      findByOrderId: jest.fn().mockImplementation(() => Promise.resolve(payment)),
      findByProviderReference: jest.fn().mockImplementation(() => Promise.resolve(payment)),
      transitionToPaid: jest.fn(),
      transitionToFailed: jest.fn(),
      claimForRecovery: jest.fn().mockImplementation(() => Promise.resolve(payment)),
      releaseRecoveryClaimIfCurrent: jest.fn().mockResolvedValue(true),
      applyRecoveryVerificationIfCurrent: jest.fn(),
    };
    refunds = { create: jest.fn(), sumCompletedByPaymentId: jest.fn().mockResolvedValue(0) };
    events = { emitAsync: jest.fn().mockResolvedValue([]) };
    const config = new ConfigService({
      WIPAY_API_URL: WIPAY_SANDBOX_API_URL,
      WIPAY_ACCOUNT_NUMBER: '1234567890',
      WIPAY_API_KEY: 'server-key',
      WIPAY_FEE_STRUCTURE: 'merchant_absorb',
      APP_BASE_URL: 'http://localhost:3001',
      API_PREFIX: 'api/v1',
    });
    service = new PaymentsService(
      repository as unknown as PaymentsRepository,
      refunds as unknown as RefundsRepository,
      new WiPayAdapter(config),
      new CashOnDeliveryAdapter(),
      events as unknown as EventEmitter2,
    );
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it.each(['timeout', 'malformed bootstrap'])(
    'keeps %s reconciliation-required and never recreates or refunds on replay',
    async (failure) => {
      if (failure === 'timeout') fetchMock.mockRejectedValue(new Error('timeout'));
      else fetchMock.mockResolvedValue(new Response('{broken'));
      const input = {
        orderId: 'order-1',
        amount: 1,
        currency: 'USD',
        provider: 'WIPAY' as const,
        customerEmail: 'attacker@example.com',
      };
      await expect(service.initiatePayment(input)).rejects.toThrow();
      expect(payment.initiationStatus).toBe('RECONCILE_REQUIRED');
      await service.initiatePayment(input);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
      const form = new URLSearchParams(request.body as string);
      expect(form.get('total')).toBe('1000.00');
      expect(form.get('currency')).toBe('JMD');
      expect(form.get('email')).toBe('stored@example.com');
      expect(repository.findCustomerEmailForOrder).toHaveBeenCalledWith('order-1');
      await expect(service.refundForOrder('order-1', 1, 'ambiguous')).resolves.toBeNull();
      expect(refunds.create).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('releases the reconciliation claim without network calls or payment mutations when lookup is unsupported', async () => {
    payment.providerReference = 'txn-1';
    payment.initiationStatus = 'ESTABLISHED';
    const recovery = new PaymentReconciliationService(
      repository as unknown as PaymentsRepository,
      service,
    );
    await expect(
      recovery.reconcilePayment(
        'payment-1',
        new Date('2026-09-06T12:00:00Z'),
        new Date('2026-09-06T11:55:00Z'),
      ),
    ).rejects.toBeInstanceOf(NotImplementedException);
    expect(repository.releaseRecoveryClaimIfCurrent).toHaveBeenCalledWith('payment-1', 1);
    expect(repository.applyRecoveryVerificationIfCurrent).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    expect(events.emitAsync).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not persist a refund or change a paid payment when refunds are unsupported', async () => {
    payment.status = 'PAID';
    payment.providerReference = 'txn-1';
    await expect(service.refundByPaymentId('payment-1', 500, 'reason')).rejects.toBeInstanceOf(
      NotImplementedException,
    );
    expect(refunds.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    expect(events.emitAsync).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a hash made from the untrusted return total before any paid transition', async () => {
    payment.providerReference = 'txn-1';
    const query = {
      transaction_id: 'txn-1',
      status: 'success',
      total: '1.00',
      hash: createHash('md5')
        .update('txn-1' + '1.00' + 'server-key')
        .digest('hex'),
    };
    await expect(service.handleWiPayReturn(query)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repository.transitionToPaid).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    expect(events.emitAsync).not.toHaveBeenCalled();
  });
});
