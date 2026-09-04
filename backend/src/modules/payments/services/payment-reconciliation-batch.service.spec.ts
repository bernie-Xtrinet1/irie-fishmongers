import { Prisma } from '@prisma/client';

import {
  PaymentsRepository,
  PaymentWithOrder,
} from '../repositories/payments.repository';
import {
  PaymentReconciliationBatchService,
} from './payment-reconciliation-batch.service';
import {
  PaymentReconciliationService,
} from './payment-reconciliation.service';

function buildPayment(id: string): PaymentWithOrder {
  return {
    id,
    orderId: `order-${id}`,
    provider: 'WIPAY',
    status: 'PENDING',
    initiationStatus: 'ESTABLISHED',
    amount: new Prisma.Decimal(1000),
    currency: 'JMD',
    providerReference: `txn-${id}`,
    failureReason: null,
    paidAt: null,
    recoveryAttemptCount: 0,
    recoveryStartedAt: null,
    createdAt: new Date('2026-09-04T03:00:00.000Z'),
    updatedAt: new Date('2026-09-04T04:00:00.000Z'),
    order: { customerId: 'user-1' },
  };
}

describe('PaymentReconciliationBatchService', () => {
  let paymentsRepository: jest.Mocked<
    Pick<PaymentsRepository, 'findAutomaticRecoveryCandidates'>
  >;

  let reconciliationService: jest.Mocked<
    Pick<PaymentReconciliationService, 'reconcilePayment'>
  >;

  let service: PaymentReconciliationBatchService;

  const now = new Date('2026-09-04T05:00:00.000Z');
  const candidateStaleBefore =
    new Date('2026-09-04T04:50:00.000Z');
  const claimStaleBefore =
    new Date('2026-09-04T04:55:00.000Z');

  beforeEach(() => {
    paymentsRepository = {
      findAutomaticRecoveryCandidates: jest.fn(),
    };

    reconciliationService = {
      reconcilePayment: jest.fn(),
    };

    service = new PaymentReconciliationBatchService(
      paymentsRepository as unknown as PaymentsRepository,
      reconciliationService as unknown as PaymentReconciliationService,
    );
  });

  it('discovers a bounded batch using the candidate lifecycle cutoff', async () => {
    paymentsRepository.findAutomaticRecoveryCandidates.mockResolvedValue([]);

    await service.runBatch({
      now,
      candidateStaleBefore,
      claimStaleBefore,
      limit: 25,
    });

    expect(
      paymentsRepository.findAutomaticRecoveryCandidates,
    ).toHaveBeenCalledWith(candidateStaleBefore, 25);
  });

  it('uses the default bounded batch size', async () => {
    paymentsRepository.findAutomaticRecoveryCandidates.mockResolvedValue([]);

    await service.runBatch({
      now,
      candidateStaleBefore,
      claimStaleBefore,
    });

    expect(
      paymentsRepository.findAutomaticRecoveryCandidates,
    ).toHaveBeenCalledWith(candidateStaleBefore, 50);
  });

  it('processes candidates sequentially and tallies outcomes', async () => {
    const candidates = [
      buildPayment('1'),
      buildPayment('2'),
      buildPayment('3'),
    ];

    paymentsRepository.findAutomaticRecoveryCandidates.mockResolvedValue(
      candidates,
    );

    const calls: string[] = [];

    reconciliationService.reconcilePayment.mockImplementation(
      async (paymentId) => {
        await Promise.resolve();
        calls.push(`start-${paymentId}`);

        if (paymentId === '1') {
          calls.push('end-1');
          return { paymentId, outcome: 'PAID' };
        }

        if (paymentId === '2') {
          expect(calls).toEqual([
            'start-1',
            'end-1',
            'start-2',
          ]);
          calls.push('end-2');
          return { paymentId, outcome: 'PENDING' };
        }

        expect(calls).toEqual([
          'start-1',
          'end-1',
          'start-2',
          'end-2',
          'start-3',
        ]);
        calls.push('end-3');
        return { paymentId, outcome: 'FAILED' };
      },
    );

    const result = await service.runBatch({
      now,
      candidateStaleBefore,
      claimStaleBefore,
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error('Expected successful batch result');
    }

    expect(result.result).toEqual(
      expect.objectContaining({
        candidatesFound: 3,
        attempted: 3,
        paid: 1,
        pending: 1,
        failed: 1,
        skipped: 0,
        providerReferenceMismatch: 0,
        staleClaim: 0,
        errors: [],
      }),
    );

    expect(calls).toEqual([
      'start-1',
      'end-1',
      'start-2',
      'end-2',
      'start-3',
      'end-3',
    ]);
  });

  it('passes the explicit now and claim cutoff to each single-row attempt', async () => {
    paymentsRepository.findAutomaticRecoveryCandidates.mockResolvedValue([
      buildPayment('1'),
    ]);

    reconciliationService.reconcilePayment.mockResolvedValue({
      paymentId: '1',
      outcome: 'SKIPPED',
    });

    await service.runBatch({
      now,
      candidateStaleBefore,
      claimStaleBefore,
    });

    expect(
      reconciliationService.reconcilePayment,
    ).toHaveBeenCalledWith('1', now, claimStaleBefore);
  });

  it('isolates one candidate error and continues processing later candidates', async () => {
    paymentsRepository.findAutomaticRecoveryCandidates.mockResolvedValue([
      buildPayment('1'),
      buildPayment('2'),
    ]);

    reconciliationService.reconcilePayment
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({
        paymentId: '2',
        outcome: 'PAID',
      });

    const result = await service.runBatch({
      now,
      candidateStaleBefore,
      claimStaleBefore,
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error('Expected successful batch result');
    }

    expect(
      reconciliationService.reconcilePayment,
    ).toHaveBeenCalledTimes(2);

    expect(result.result.attempted).toBe(2);
    expect(result.result.paid).toBe(1);
    expect(result.result.errors).toEqual([
      {
        paymentId: '1',
        message: 'provider unavailable',
      },
    ]);
  });

  it.each([
    ['SKIPPED', 'skipped'],
    [
      'PROVIDER_REFERENCE_MISMATCH',
      'providerReferenceMismatch',
    ],
    ['STALE_CLAIM', 'staleClaim'],
  ] as const)(
    'tallies %s as %s',
    async (outcome, counter) => {
      paymentsRepository.findAutomaticRecoveryCandidates.mockResolvedValue([
        buildPayment('1'),
      ]);

      reconciliationService.reconcilePayment.mockResolvedValue({
        paymentId: '1',
        outcome,
      });

      const result = await service.runBatch({
        now,
        candidateStaleBefore,
        claimStaleBefore,
      });

      expect(result.ok).toBe(true);

      if (!result.ok) {
        throw new Error('Expected successful batch result');
      }

      expect(result.result[counter]).toBe(1);
    },
  );

  it('rejects an invalid now without querying candidates', async () => {
    const result = await service.runBatch({
      now: new Date('invalid'),
      candidateStaleBefore,
      claimStaleBefore,
    });

    expect(result).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
      field: 'now',
      reason: 'now must be a valid Date',
    });

    expect(
      paymentsRepository.findAutomaticRecoveryCandidates,
    ).not.toHaveBeenCalled();
  });

  it('requires both stale cutoffs to be earlier than now', async () => {
    const result = await service.runBatch({
      now,
      candidateStaleBefore: now,
      claimStaleBefore,
    });

    expect(result).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
      field: 'candidateStaleBefore',
      reason: 'candidateStaleBefore must be earlier than now',
    });
  });

  it('rejects a batch size above the hard maximum', async () => {
    const result = await service.runBatch({
      now,
      candidateStaleBefore,
      claimStaleBefore,
      limit: 201,
    });

    expect(result).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
      field: 'limit',
      reason: 'limit must not exceed 200',
    });
  });
});
