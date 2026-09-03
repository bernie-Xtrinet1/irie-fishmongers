import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { PaymentsRepository, PaymentWithOrder } from './payments.repository';

describe('PaymentsRepository', () => {
  let prisma: {
    payment: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let repository: PaymentsRepository;

  beforeEach(() => {
    prisma = {
      payment: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    repository = new PaymentsRepository(prisma as unknown as PrismaService);
  });

  function p2002(target: string[]): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '6.19.3',
      meta: { target },
    });
  }

  function buildPayment(overrides: Partial<PaymentWithOrder> = {}): PaymentWithOrder {
    return {
      id: 'payment-1',
      orderId: 'order-1',
      provider: 'WIPAY',
      status: 'PENDING',
      initiationStatus: 'NOT_STARTED',
      amount: new Prisma.Decimal(1000),
      currency: 'JMD',
      providerReference: null,
      failureReason: null,
      paidAt: null,
      createdAt: new Date('2026-09-03T00:00:00.000Z'),
      updatedAt: new Date('2026-09-03T00:00:00.000Z'),
      order: { customerId: 'customer-1' },
      ...overrides,
    };
  }

  const input = {
    orderId: 'order-1',
    provider: 'WIPAY' as const,
    amount: 1000,
    currency: 'JMD',
  };

  it('returns the newly created payment when this caller wins', async () => {
    const payment = buildPayment();
    prisma.payment.create.mockResolvedValue(payment);

    await expect(repository.createOrGetByOrderId(input)).resolves.toEqual({
      payment,
      created: true,
    });

    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
  });

  it('re-reads the winner after a concurrent orderId P2002', async () => {
    const payment = buildPayment();
    prisma.payment.create.mockRejectedValue(p2002(['orderId']));
    prisma.payment.findUnique.mockResolvedValue(payment);

    await expect(repository.createOrGetByOrderId(input)).resolves.toEqual({
      payment,
      created: false,
    });

    expect(prisma.payment.findUnique).toHaveBeenCalledWith({
      where: { orderId: 'order-1' },
      include: { order: { select: { customerId: true } } },
    });
  });

  it('rethrows a P2002 for an unrelated unique constraint', async () => {
    const error = p2002(['providerReference']);
    prisma.payment.create.mockRejectedValue(error);

    await expect(repository.createOrGetByOrderId(input)).rejects.toBe(error);
    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
  });

  it('rethrows non-P2002 errors unchanged', async () => {
    const error = new Error('connection reset');
    prisma.payment.create.mockRejectedValue(error);

    await expect(repository.createOrGetByOrderId(input)).rejects.toBe(error);
  });

  it('throws an internal consistency error when the winner cannot be re-read', async () => {
    prisma.payment.create.mockRejectedValue(p2002(['orderId']));
    prisma.payment.findUnique.mockResolvedValue(null);

    await expect(repository.createOrGetByOrderId(input)).rejects.toThrow(
      'Internal consistency error',
    );
  });

  describe('findRecoveryCandidates', () => {
    it('finds only stale WiPay initiation-recovery candidates in oldest-first order', async () => {
      const staleBefore = new Date('2026-09-03T01:00:00.000Z');
      const candidates = [
        buildPayment({
          id: 'payment-oldest',
          initiationStatus: 'INITIATING',
          updatedAt: new Date('2026-09-02T23:00:00.000Z'),
        }),
        buildPayment({
          id: 'payment-newer',
          initiationStatus: 'RECONCILE_REQUIRED',
          updatedAt: new Date('2026-09-03T00:30:00.000Z'),
        }),
      ];

      prisma.payment.findMany.mockResolvedValue(candidates);

      await expect(repository.findRecoveryCandidates(staleBefore, 25)).resolves.toEqual(candidates);

      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        where: {
          provider: 'WIPAY',
          initiationStatus: { in: ['INITIATING', 'RECONCILE_REQUIRED'] },
          updatedAt: { lte: staleBefore },
        },
        orderBy: { updatedAt: 'asc' },
        take: 25,
        include: { order: { select: { customerId: true } } },
      });
    });

    it('is read-only and does not mutate candidate state', async () => {
      prisma.payment.findMany.mockResolvedValue([]);

      await repository.findRecoveryCandidates(
        new Date('2026-09-03T01:00:00.000Z'),
        10,
      );

      expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('transitionToPaid', () => {
    it('atomically transitions an eligible payment to PAID', async () => {
      const paidAt = new Date('2026-09-03T01:00:00.000Z');
      const payment = buildPayment({ status: 'PAID', paidAt });

      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValue(payment);

      await expect(repository.transitionToPaid('payment-1')).resolves.toEqual({
        payment,
        transitioned: true,
      });

      expect(prisma.payment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'payment-1',
          status: { in: ['PENDING', 'FAILED'] },
        },
        data: {
          status: 'PAID',
          paidAt: expect.any(Date) as Date,
          failureReason: null,
        },
      });
    });

    it('permits FAILED to be recovered by an authoritative PAID transition', async () => {
      const payment = buildPayment({
        status: 'PAID',
        failureReason: null,
        paidAt: new Date('2026-09-03T01:00:00.000Z'),
      });

      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValue(payment);

      const result = await repository.transitionToPaid('payment-1');

      expect(result.transitioned).toBe(true);
      expect(prisma.payment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'payment-1',
            status: { in: ['PENDING', 'FAILED'] },
          },
        }),
      );
    });

    it('returns transitioned false when the payment is already PAID', async () => {
      const payment = buildPayment({
        status: 'PAID',
        paidAt: new Date('2026-09-03T01:00:00.000Z'),
      });

      prisma.payment.updateMany.mockResolvedValue({ count: 0 });
      prisma.payment.findUnique.mockResolvedValue(payment);

      await expect(repository.transitionToPaid('payment-1')).resolves.toEqual({
        payment,
        transitioned: false,
      });
    });
  });

  describe('transitionToFailed', () => {
    it('atomically transitions PENDING to FAILED', async () => {
      const payment = buildPayment({
        status: 'FAILED',
        failureReason: 'Card declined',
      });

      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValue(payment);

      await expect(
        repository.transitionToFailed('payment-1', 'Card declined'),
      ).resolves.toEqual({
        payment,
        transitioned: true,
      });

      expect(prisma.payment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'payment-1',
          status: 'PENDING',
        },
        data: {
          status: 'FAILED',
          failureReason: 'Card declined',
        },
      });
    });

    it.each(['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const)(
      'does not downgrade %s to FAILED',
      async (status) => {
        const payment = buildPayment({ status });

        prisma.payment.updateMany.mockResolvedValue({ count: 0 });
        prisma.payment.findUnique.mockResolvedValue(payment);

        await expect(
          repository.transitionToFailed('payment-1', 'Late failure'),
        ).resolves.toEqual({
          payment,
          transitioned: false,
        });

        expect(prisma.payment.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'payment-1',
            status: 'PENDING',
          },
          data: {
            status: 'FAILED',
            failureReason: 'Late failure',
          },
        });
      },
    );
  });
});
