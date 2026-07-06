import { BadRequestException, RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';

import { PaymentResponseEntity } from '../entities/payment-response.entity';
import { RefundResponseEntity } from '../entities/refund-response.entity';
import { PaymentsService } from '../services/payments.service';
import { PaymentsController } from './payments.controller';

const payment: PaymentResponseEntity = {
  id: 'payment-1',
  orderId: 'order-1',
  provider: 'CASH_ON_DELIVERY',
  status: 'PAID',
  amount: '1000',
  currency: 'JMD',
  paidAt: new Date(),
  createdAt: new Date(),
};

const refund: RefundResponseEntity = {
  id: 'refund-1',
  paymentId: 'payment-1',
  amount: '500',
  reason: 'Admin adjustment',
  status: 'COMPLETED',
  createdAt: new Date(),
};

function buildWebhookRequest(rawBody?: Buffer, signature?: string): RawBodyRequest<Request> {
  return {
    rawBody,
    headers: signature ? { 'x-wipay-signature': signature } : {},
  } as unknown as RawBodyRequest<Request>;
}

describe('PaymentsController', () => {
  let paymentsService: jest.Mocked<
    Pick<PaymentsService, 'handleWiPayWebhook' | 'markCashOnDeliveryPaid' | 'refundByPaymentId'>
  >;
  let controller: PaymentsController;

  beforeEach(() => {
    paymentsService = {
      handleWiPayWebhook: jest.fn().mockResolvedValue(undefined),
      markCashOnDeliveryPaid: jest.fn().mockResolvedValue(payment),
      refundByPaymentId: jest.fn().mockResolvedValue(refund),
    };
    controller = new PaymentsController(paymentsService as unknown as PaymentsService);
  });

  describe('wiPayWebhook', () => {
    it('forwards the raw body and signature to the service', async () => {
      const rawBody = Buffer.from(JSON.stringify({ transaction_id: 'txn-1', status: 'success' }));
      const req = buildWebhookRequest(rawBody, 'good-signature');

      const result = await controller.wiPayWebhook(req);

      expect(result).toEqual({ received: true });
      expect(paymentsService.handleWiPayWebhook).toHaveBeenCalledWith(
        rawBody.toString('utf8'),
        'good-signature',
      );
    });

    it('rejects a webhook with no raw body', async () => {
      const req = buildWebhookRequest(undefined, 'good-signature');
      await expect(controller.wiPayWebhook(req)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a webhook with no signature header', async () => {
      const rawBody = Buffer.from(JSON.stringify({ transaction_id: 'txn-1', status: 'success' }));
      const req = buildWebhookRequest(rawBody, undefined);
      await expect(controller.wiPayWebhook(req)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('confirms a cash-on-delivery payment', async () => {
    await expect(controller.markCashOnDeliveryPaid('payment-1')).resolves.toEqual(payment);
    expect(paymentsService.markCashOnDeliveryPaid).toHaveBeenCalledWith('payment-1');
  });

  it('issues a refund', async () => {
    const dto = { amount: 500, reason: 'Admin adjustment' };
    await expect(controller.refund('payment-1', dto)).resolves.toEqual(refund);
    expect(paymentsService.refundByPaymentId).toHaveBeenCalledWith('payment-1', 500, 'Admin adjustment');
  });
});
