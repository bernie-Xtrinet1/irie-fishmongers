import { randomUUID, createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { CheckoutOperationRepository } from '../repositories/checkout-operation.repository';
import { CheckoutOperationService, priceLockFingerprint } from './checkout-operation.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { PriceLockRepository } from '../../price-lock/repositories/price-lock.repository';
import { PriceLockService } from '../../price-lock/services/price-lock.service';

describe('G.PR2 fingerprint and issuance boundary', () => {
  const line = {
    cartItemId: 'line-a',
    productId: 'product-a',
    quantity: 2,
    mutationVersion: 0,
    lockedUnitPrice: '850',
    lockedCurrency: 'JMD',
    priceLockedAt: new Date('2026-09-08T00:00:00.000Z'),
  };
  afterEach(() => jest.restoreAllMocks());
  it('uses deterministic sorted v1 UTF-8 canonical arrays without mutating input', () => {
    const second = { ...line, cartItemId: 'line-b' };
    const reversed = [second, line];
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          'checkout-price-lock-v1',
          'cart',
          'JMD',
          [
            ['line-a', 'product-a', 2, 0, '850', 'JMD', '2026-09-08T00:00:00.000Z'],
            ['line-b', 'product-a', 2, 0, '850', 'JMD', '2026-09-08T00:00:00.000Z'],
          ],
        ]),
        'utf8',
      )
      .digest('hex');
    expect(priceLockFingerprint('cart', 'JMD', reversed)).toBe(expected);
    expect(priceLockFingerprint('cart', 'JMD', [line, second])).toBe(expected);
    expect(reversed[0]).toBe(second);
  });
  it.each([
    { cartItemId: 'recreated-line' },
    { productId: 'other-product' },
    { quantity: 3 },
    { mutationVersion: 2 },
    { lockedUnitPrice: '851' },
    { lockedCurrency: 'USD' },
    { priceLockedAt: new Date('2026-09-08T00:00:00.001Z') },
  ])('detects changed line field %#', (change) => {
    expect(priceLockFingerprint('cart', 'JMD', [{ ...line, ...change }])).not.toBe(
      priceLockFingerprint('cart', 'JMD', [line]),
    );
  });
  it('detects cart identity and cart currency changes', () => {
    const hash = priceLockFingerprint('cart', 'JMD', [line]);
    expect(priceLockFingerprint('other-cart', 'JMD', [line])).not.toBe(hash);
    expect(priceLockFingerprint('cart', 'USD', [line])).not.toBe(hash);
  });
  it('hashes exact case-sensitive retry bytes without logging and rejects a mapped cart conflict', async () => {
    const customerId = randomUUID();
    const cartId = randomUUID();
    const retryKey = 'Private-Retry-Key';
    const resolve = jest.fn().mockResolvedValue({ cartId: randomUUID() });
    const repository = {
      transaction: <T>(callback: (tx: never) => Promise<T>) => callback({} as never),
      resolve,
    };
    const carts = { findById: jest.fn().mockResolvedValue({ id: cartId, customerId }) };
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = new CheckoutOperationService(
      repository as unknown as CheckoutOperationRepository,
      carts as unknown as CartRepository,
      {} as PriceLockRepository,
      {} as PriceLockService,
    );
    expect(await service.issue({ customerId, cartId, retryKey })).toEqual({
      ok: false,
      code: 'CART_CONFLICT',
    });
    expect(resolve).toHaveBeenCalledWith(
      customerId,
      createHash('sha256').update('checkout-retry-v1\0').update(retryKey).digest('hex'),
      cartId,
      {},
    );
    expect(JSON.stringify(resolve.mock.calls)).not.toContain(retryKey);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
