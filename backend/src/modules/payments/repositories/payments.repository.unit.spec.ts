import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { PaymentsRepository, PaymentWithOrder } from './payments.repository';

describe('PaymentsRepository createOrGetByOrderId', () => {
  let prisma: { payment: { create: jest.Mock; findUnique: jest.Mock } };
  let repository: PaymentsRepository;

  beforeEach(() => {
    prisma = {
      payment: {
        create: jest.fn(),
        findUnique: jest.fn(),
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

  function buildPayment(): PaymentWithOrder {
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
});
