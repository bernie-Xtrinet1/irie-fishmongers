import { Prisma } from '@prisma/client';

import {
  PaymentsRepository,
  PaymentWithOrder,
} from '../repositories/payments.repository';
import {
  PaymentReconciliationService,
} from './payment-reconciliation.service';
import { PaymentsService } from './payments.service';

function buildPayment(
  overrides: Partial<PaymentWithOrder> = {},
): PaymentWithOrder {
  return {
    id: 'payment-1',
    orderId: 'order-1',
    provider: 'WIPAY',
    status: 'PENDING',
    initiationStatus: 'ESTABLISHED',
    amount: new Prisma.Decimal(1000),
    currency: 'JMD',
    providerReference: 'txn-1',
    failureReason: null,
    paidAt: null,
    recoveryAttemptCount: 1,
    recoveryStartedAt: new Date('2026-09-04T04:00:00.000Z'),
    createdAt: new Date('2026-09-04T03:00:00.000Z'),
    updatedAt: new Date('2026-09-04T04:00:00.000Z'),
    order: { customerId: 'user-1' },
    ...overrides,
  };
}

describe('PaymentReconciliationService', () => {
  let paymentsRepository: jest.Mocked<
    Pick<
      PaymentsRepository,
      | 'claimForRecovery'
      | 'releaseRecoveryClaimIfCurrent'
      | 'applyRecoveryVerificationIfCurrent'
    >
  >;

  let paymentsService: jest.Mocked<
    Pick<
      PaymentsService,
      | 'verifyProviderPayment'
      | 'emitRecoveredPaymentConfirmed'
    >
  >;

  let service: PaymentReconciliationService;

  const now = new Date('2026-09-04T05:00:00.000Z');
  const claimStaleBefore = new Date('2026-09-04T04:55:00.000Z');

  beforeEach(() => {
    paymentsRepository = {
      claimForRecovery: jest.fn(),
      releaseRecoveryClaimIfCurrent: jest.fn(),
      applyRecoveryVerificationIfCurrent: jest.fn(),
    };

    paymentsService = {
      verifyProviderPayment: jest.fn(),
      emitRecoveredPaymentConfirmed: jest.fn(),
    };

    service = new PaymentReconciliationService(
      paymentsRepository as unknown as PaymentsRepository,
      paymentsService as unknown as PaymentsService,
    );
  });

  it('rejects a claim cutoff that is not earlier than now before claiming', async () => {
    await expect(
      service.reconcilePayment('payment-1', now, now),
    ).rejects.toThrow('claimStaleBefore must be earlier than now');

    expect(paymentsRepository.claimForRecovery).not.toHaveBeenCalled();
    expect(paymentsService.verifyProviderPayment).not.toHaveBeenCalled();
  });

  it('returns SKIPPED when another worker wins the recovery claim', async () => {
    paymentsRepository.claimForRecovery.mockResolvedValue(null);

    await expect(
      service.reconcilePayment('payment-1', now, claimStaleBefore),
    ).resolves.toEqual({
      paymentId: 'payment-1',
      outcome: 'SKIPPED',
    });

    expect(paymentsService.verifyProviderPayment).not.toHaveBeenCalled();
  });

  it('verifies the exact claimed provider reference', async () => {
    const claimed = buildPayment();

    paymentsRepository.claimForRecovery.mockResolvedValue(claimed);
    paymentsService.verifyProviderPayment.mockResolvedValue({
      providerReference: 'txn-1',
      status: 'PENDING',
    });
    paymentsRepository.applyRecoveryVerificationIfCurrent.mockResolvedValue({
      payment: buildPayment(),
      applied: true,
      transitionedToPaid: false,
    });

    await service.reconcilePayment('payment-1', now, claimStaleBefore);

    expect(paymentsService.verifyProviderPayment).toHaveBeenCalledWith(
      'WIPAY',
      'txn-1',
    );

    expect(
      paymentsRepository.applyRecoveryVerificationIfCurrent,
    ).toHaveBeenCalledWith(
      'payment-1',
      1,
      'txn-1',
      'PENDING',
      now,
    );
  });

  it('releases the exact claim and rethrows the original verification error', async () => {
    const claimed = buildPayment();
    const providerError = new Error('provider unavailable');

    paymentsRepository.claimForRecovery.mockResolvedValue(claimed);
    paymentsService.verifyProviderPayment.mockRejectedValue(providerError);
    paymentsRepository.releaseRecoveryClaimIfCurrent.mockResolvedValue(true);

    await expect(
      service.reconcilePayment('payment-1', now, claimStaleBefore),
    ).rejects.toBe(providerError);

    expect(
      paymentsRepository.releaseRecoveryClaimIfCurrent,
    ).toHaveBeenCalledWith('payment-1', 1);

    expect(
      paymentsRepository.applyRecoveryVerificationIfCurrent,
    ).not.toHaveBeenCalled();
  });

  it('preserves the provider error even when claim release also fails', async () => {
    const claimed = buildPayment();
    const providerError = new Error('provider unavailable');

    paymentsRepository.claimForRecovery.mockResolvedValue(claimed);
    paymentsService.verifyProviderPayment.mockRejectedValue(providerError);
    paymentsRepository.releaseRecoveryClaimIfCurrent.mockRejectedValue(
      new Error('release failed'),
    );

    await expect(
      service.reconcilePayment('payment-1', now, claimStaleBefore),
    ).rejects.toBe(providerError);
  });

  it('releases without applying when the provider reference mismatches', async () => {
    const claimed = buildPayment();

    paymentsRepository.claimForRecovery.mockResolvedValue(claimed);
    paymentsService.verifyProviderPayment.mockResolvedValue({
      providerReference: 'different-txn',
      status: 'PAID',
    });
    paymentsRepository.releaseRecoveryClaimIfCurrent.mockResolvedValue(true);

    await expect(
      service.reconcilePayment('payment-1', now, claimStaleBefore),
    ).resolves.toEqual({
      paymentId: 'payment-1',
      outcome: 'PROVIDER_REFERENCE_MISMATCH',
    });

    expect(
      paymentsRepository.applyRecoveryVerificationIfCurrent,
    ).not.toHaveBeenCalled();

    expect(
      paymentsRepository.releaseRecoveryClaimIfCurrent,
    ).toHaveBeenCalledWith('payment-1', 1);

    expect(
      paymentsService.emitRecoveredPaymentConfirmed,
    ).not.toHaveBeenCalled();
  });

  it.each(['PENDING', 'FAILED'] as const)(
    'applies authoritative provider %s without emitting payment.confirmed',
    async (status) => {
      const claimed = buildPayment();

      paymentsRepository.claimForRecovery.mockResolvedValue(claimed);
      paymentsService.verifyProviderPayment.mockResolvedValue({
        providerReference: 'txn-1',
        status,
      });
      paymentsRepository.applyRecoveryVerificationIfCurrent.mockResolvedValue({
        payment: buildPayment({ status }),
        applied: true,
        transitionedToPaid: false,
      });

      await expect(
        service.reconcilePayment('payment-1', now, claimStaleBefore),
      ).resolves.toEqual({
        paymentId: 'payment-1',
        outcome: status,
      });

      expect(
        paymentsService.emitRecoveredPaymentConfirmed,
      ).not.toHaveBeenCalled();
    },
  );

  it('emits payment.confirmed only when this fenced worker wins PAID', async () => {
    const claimed = buildPayment();
    const paid = buildPayment({
      status: 'PAID',
      paidAt: now,
      recoveryStartedAt: null,
    });

    paymentsRepository.claimForRecovery.mockResolvedValue(claimed);
    paymentsService.verifyProviderPayment.mockResolvedValue({
      providerReference: 'txn-1',
      status: 'PAID',
    });
    paymentsRepository.applyRecoveryVerificationIfCurrent.mockResolvedValue({
      payment: paid,
      applied: true,
      transitionedToPaid: true,
    });

    await expect(
      service.reconcilePayment('payment-1', now, claimStaleBefore),
    ).resolves.toEqual({
      paymentId: 'payment-1',
      outcome: 'PAID',
    });

    expect(
      paymentsService.emitRecoveredPaymentConfirmed,
    ).toHaveBeenCalledWith(paid);
  });

  it('returns STALE_CLAIM when the fenced verification write loses', async () => {
    const claimed = buildPayment();

    paymentsRepository.claimForRecovery.mockResolvedValue(claimed);
    paymentsService.verifyProviderPayment.mockResolvedValue({
      providerReference: 'txn-1',
      status: 'PAID',
    });
    paymentsRepository.applyRecoveryVerificationIfCurrent.mockResolvedValue({
      payment: buildPayment(),
      applied: false,
      transitionedToPaid: false,
    });

    await expect(
      service.reconcilePayment('payment-1', now, claimStaleBefore),
    ).resolves.toEqual({
      paymentId: 'payment-1',
      outcome: 'STALE_CLAIM',
    });

    expect(
      paymentsService.emitRecoveredPaymentConfirmed,
    ).not.toHaveBeenCalled();
  });

  it('throws if an applied recovery payment disappears on reread', async () => {
    const claimed = buildPayment();

    paymentsRepository.claimForRecovery.mockResolvedValue(claimed);
    paymentsService.verifyProviderPayment.mockResolvedValue({
      providerReference: 'txn-1',
      status: 'PENDING',
    });
    paymentsRepository.applyRecoveryVerificationIfCurrent.mockResolvedValue({
      payment: null,
      applied: true,
      transitionedToPaid: false,
    });

    await expect(
      service.reconcilePayment('payment-1', now, claimStaleBefore),
    ).rejects.toThrow(
      'Internal consistency error: payment "payment-1" disappeared after recovery verification',
    );
  });
});
