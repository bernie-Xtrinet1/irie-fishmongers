import { CashOnDeliveryAdapter } from './cash-on-delivery.adapter';

describe('CashOnDeliveryAdapter', () => {
  const adapter = new CashOnDeliveryAdapter();

  it('creates a pending payment referencing the order', async () => {
    const result = await adapter.createPayment({ orderId: 'order-1', amount: 1000, currency: 'JMD' });
    expect(result.status).toBe('PENDING');
    expect(result.providerReference).toBe('cod-order-1');
    expect(result.redirectUrl).toBeUndefined();
  });

  it('reports payment verification as still pending', async () => {
    const result = await adapter.verifyPayment('cod-order-1');
    expect(result).toEqual({ providerReference: 'cod-order-1', status: 'PENDING' });
  });

  it('completes a refund immediately since no external gateway is involved', async () => {
    const result = await adapter.refundPayment('cod-order-1', 500);
    expect(result.status).toBe('COMPLETED');
    expect(result.providerReference).toMatch(/^cod-refund-/);
  });
});
