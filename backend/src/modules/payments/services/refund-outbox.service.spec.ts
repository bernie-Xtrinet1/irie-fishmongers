import { PrismaService } from '../../../database/prisma.service';
import { RefundOutboxService } from './refund-outbox.service';

describe('RefundOutboxService (Unit)', () => {
  it('fails closed by default when allowNotificationDispatch=false without invoking consumer', async () => {
    const transactionMock = jest.fn();
    const prisma = {
      paymentOutbox: {
        findMany: jest.fn().mockResolvedValue([{ id: 'outbox-1' }]),
        update: jest.fn(),
      },
      $transaction: transactionMock,
    } as unknown as PrismaService;

    const consumer = jest.fn();
    const service = new RefundOutboxService(prisma);

    const result = await service.dispatchPendingRefundEvents(consumer);
    expect(result.fetchedCount).toBe(1);
    expect(result.publishedIds).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(consumer).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('derives deterministic logicalEventKey fallback when payload omits logicalEventKey', async () => {
    const prisma = {
      paymentOutbox: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'outbox-legacy-1',
            aggregateId: 'refund-1',
            aggregateType: 'Refund',
            eventType: 'REFUND_STATUS_CHANGED',
            payload: { refundId: 'refund-1' },
            published: false,
            createdAt: new Date('2026-11-19T00:00:00Z'),
          },
        ]),
      },
    } as unknown as PrismaService;

    const service = new RefundOutboxService(prisma);
    const pending = await service.listPendingRefundEvents();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.logicalEventKey).toBe(
      'refund_outbox:REFUND_STATUS_CHANGED:refund-1:outbox-legacy-1',
    );
  });
});
