import { randomUUID } from 'crypto';
import { CheckoutPath } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { PriceLockRepository } from '../../price-lock/repositories/price-lock.repository';
import { PriceLockService } from '../../price-lock/services/price-lock.service';
import { PRICE_LOCK_TTL_SECONDS } from '../../price-lock/constants/price-lock.constants';
import { CheckoutOperationRepository } from '../repositories/checkout-operation.repository';
import { CheckoutOperationService, OperationResult } from './checkout-operation.service';
import {
  setUpCompensationFixture,
  seedCartAndProduct,
  tearDownCompensationFixture,
  CompensationTestFixture,
} from '../../mirror-compensation/repositories/compensation-repository-test-helpers';
import { getReservationKeySegmentValidationError } from '../../inventory/constants/inventory.constants';

describe('G.PR2 operation issuance and price binding (Postgres)', () => {
  const prisma = new PrismaService();
  const other = new PrismaService();
  const repository = new CheckoutOperationRepository(prisma);
  const carts = new CartRepository(prisma);
  const locks = new PriceLockRepository(prisma);
  const prices = new PriceLockService(prisma, carts, new ProductsRepository(prisma), locks);
  const service = new CheckoutOperationService(repository, carts, locks, prices);
  const secondService = new CheckoutOperationService(
    new CheckoutOperationRepository(other),
    new CartRepository(other),
    new PriceLockRepository(other),
    new PriceLockService(
      other,
      new CartRepository(other),
      new ProductsRepository(other),
      new PriceLockRepository(other),
    ),
  );
  let fixture: CompensationTestFixture;
  let customerId: string;
  let cartId: string;
  let productId: string;
  let itemId: string;
  let retryKey: string;
  beforeAll(async () => {
    await Promise.all([prisma.$connect(), other.$connect()]);
    fixture = await setUpCompensationFixture(prisma);
  });
  beforeEach(async () => {
    ({ customerId, cartId, productId } = await seedCartAndProduct(fixture));
    itemId = (await carts.addOrIncrementItem(cartId, productId, 2)).id;
    retryKey = randomUUID();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await prisma.checkoutOperation.deleteMany({ where: { customerId: { in: fixture.userIds } } });
    await tearDownCompensationFixture(fixture);
    await Promise.all([prisma.$disconnect(), other.$disconnect()]);
  });
  function success(result: OperationResult) {
    if (!result.ok) throw new Error(result.code);
    return result.operation;
  }
  async function issue() {
    return success(await service.issue({ customerId, cartId, retryKey }));
  }
  async function prepared() {
    const operation = await issue();
    return success(await service.prepare(customerId, operation.id, new Date()));
  }

  it('response loss resolves the same durable server identity in a new service; compatible with coordinator keys', async () => {
    const first = await issue();
    const replay = success(await secondService.issue({ customerId, cartId, retryKey }));
    expect(replay).toEqual(first);
    expect(first.operationKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.operationKey).not.toBe(retryKey);
    expect(first.retryKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(first)).not.toContain(retryKey);
    expect(
      getReservationKeySegmentValidationError(first.operationKey, 'idempotencyKey'),
    ).toBeNull();
    expect(first.selectedPath).toBeNull();
    expect(first.priceLockFingerprint).toBeNull();
    expect(await prisma.checkoutAttempt.count({ where: { customerId } })).toBe(0);
    expect(await prisma.order.count({ where: { customerId } })).toBe(0);
  });
  it('concurrent independent connections issue exactly one operation', async () => {
    const results = await Promise.all([
      service.issue({ customerId, cartId, retryKey }),
      secondService.issue({ customerId, cartId, retryKey }),
    ]);
    expect(success(results[0])).toEqual(success(results[1]));
    expect(await prisma.checkoutOperation.count({ where: { customerId } })).toBe(1);
  });
  it('same retry text is customer-scoped, while another cart/customer cannot claim the operation', async () => {
    const first = await issue();
    const second = await seedCartAndProduct(fixture);
    expect(await service.issue({ customerId, cartId: second.cartId, retryKey })).toEqual({
      ok: false,
      code: 'OWNERSHIP_MISMATCH',
    });
    const separate = success(
      await service.issue({ customerId: second.customerId, cartId: second.cartId, retryKey }),
    );
    expect(separate.operationKey).not.toBe(first.operationKey);
    expect(await service.prepare(second.customerId, first.id, new Date())).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(await service.assignPath(second.customerId, first.id, 'LEGACY')).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
  });
  it.each(['LEGACY', 'CART_SCOPED'] as const)(
    'assigns %s once and rejects replacement',
    async (path) => {
      const operation = await issue();
      expect(success(await service.assignPath(customerId, operation.id, path)).selectedPath).toBe(
        path,
      );
      expect(success(await service.assignPath(customerId, operation.id, path)).selectedPath).toBe(
        path,
      );
      expect(
        await service.assignPath(
          customerId,
          operation.id,
          path === 'LEGACY' ? 'CART_SCOPED' : 'LEGACY',
        ),
      ).toEqual({ ok: false, code: 'PATH_CONFLICT' });
      expect(await service.assignPath(customerId, operation.id, 'SHADOW' as CheckoutPath)).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
      });
    },
  );
  it('concurrent conflicting path assignments choose exactly one immutable winner', async () => {
    const operation = await issue();
    const results = await Promise.all([
      service.assignPath(customerId, operation.id, 'LEGACY'),
      secondService.assignPath(customerId, operation.id, 'CART_SCOPED'),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: 'PATH_CONFLICT' }]);
  });
  it('first preparation creates complete locks and persists fingerprint; response-loss replay preserves both', async () => {
    const operation = await prepared();
    const snapshot = await prisma.cartItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(operation.priceLockFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.lockedUnitPrice!.toString()).toBe('850');
    expect(success(await secondService.prepare(customerId, operation.id, new Date()))).toEqual(
      operation,
    );
    expect(await prisma.cartItem.findUnique({ where: { id: itemId } })).toEqual(snapshot);
  });
  it('locks committed before interruption can be bound on retry without repricing', async () => {
    const operation = await issue();
    await prices.createPriceLock({ customerId, cartId, cartItemId: itemId, now: new Date() });
    const snapshot = await prisma.cartItem.findUniqueOrThrow({ where: { id: itemId } });
    await prisma.product.update({ where: { id: productId }, data: { price: 999 } });
    expect(
      success(await secondService.prepare(customerId, operation.id, new Date()))
        .priceLockFingerprint,
    ).not.toBeNull();
    expect(await prisma.cartItem.findUnique({ where: { id: itemId } })).toEqual(snapshot);
  });
  it('transaction interruption before binding rolls back newly created locks and safely retries', async () => {
    const operation = await issue();
    jest
      .spyOn(repository, 'bindFingerprint')
      .mockRejectedValueOnce(new Error('simulated interruption'));
    await expect(service.prepare(customerId, operation.id, new Date())).rejects.toThrow(
      'simulated interruption',
    );
    expect(
      (await prisma.cartItem.findUniqueOrThrow({ where: { id: itemId } })).priceLockedAt,
    ).toBeNull();
    expect(
      success(await service.prepare(customerId, operation.id, new Date())).priceLockFingerprint,
    ).not.toBeNull();
  });
  it.each([
    'quantity',
    'price',
    'currency',
    'missing',
    'partial',
    'timestamp',
    'removed',
    'added',
  ] as const)(
    'prepared %s mutation requires reconfirmation and never overwrites fingerprint or repairs locks',
    async (mutation) => {
      const operation = await prepared();
      if (mutation === 'quantity') await carts.updateItemQuantity(itemId, 3);
      if (mutation === 'price')
        await prisma.cartItem.update({ where: { id: itemId }, data: { lockedUnitPrice: 900 } });
      if (mutation === 'currency')
        await prisma.cart.update({ where: { id: cartId }, data: { currency: 'USD' } });
      if (mutation === 'missing')
        await prisma.cartItem.update({
          where: { id: itemId },
          data: { lockedUnitPrice: null, lockedCurrency: null, priceLockedAt: null },
        });
      if (mutation === 'partial')
        await prisma.cartItem.update({ where: { id: itemId }, data: { lockedCurrency: null } });
      if (mutation === 'timestamp')
        await prisma.cartItem.update({
          where: { id: itemId },
          data: { priceLockedAt: new Date(Date.now() + 1000) },
        });
      if (mutation === 'removed') await carts.removeItem(itemId);
      if (mutation === 'added') {
        const extra = await seedCartAndProduct(fixture);
        await carts.addOrIncrementItem(cartId, extra.productId, 1);
      }
      const before = await prisma.cartItem.findMany({ where: { cartId }, orderBy: { id: 'asc' } });
      expect(await service.prepare(customerId, operation.id, new Date())).toEqual({
        ok: false,
        code: 'RECONFIRM_REQUIRED',
      });
      expect(await prisma.cartItem.findMany({ where: { cartId }, orderBy: { id: 'asc' } })).toEqual(
        before,
      );
      expect(
        (await prisma.checkoutOperation.findUniqueOrThrow({ where: { id: operation.id } }))
          .priceLockFingerprint,
      ).toBe(operation.priceLockFingerprint);
    },
  );
  it('expired prepared locks require reconfirmation without refreshing', async () => {
    const now = new Date();
    const operation = await issue();
    const bound = success(await service.prepare(customerId, operation.id, now));
    expect(
      await service.prepare(
        customerId,
        operation.id,
        new Date(now.getTime() + PRICE_LOCK_TTL_SECONDS * 1000),
      ),
    ).toEqual({ ok: false, code: 'RECONFIRM_REQUIRED' });
    expect(
      (await prisma.checkoutOperation.findUniqueOrThrow({ where: { id: operation.id } }))
        .priceLockFingerprint,
    ).toBe(bound.priceLockFingerprint);
  });
  it('concurrent preparation persists one fingerprint', async () => {
    const operation = await issue();
    const now = new Date();
    const results = await Promise.all([
      service.prepare(customerId, operation.id, now),
      secondService.prepare(customerId, operation.id, now),
    ]);
    expect(success(results[0])).toEqual(success(results[1]));
  });
  it('quantity changed and changed back still requires reconfirmation through mutationVersion', async () => {
    const operation = await prepared();
    await carts.updateItemQuantity(itemId, 3);
    await carts.updateItemQuantity(itemId, 2);
    expect(await service.prepare(customerId, operation.id, new Date())).toEqual({
      ok: false,
      code: 'RECONFIRM_REQUIRED',
    });
  });
  it.each(['operationKey', 'selectedPath', 'priceLockFingerprint', 'cohort'])(
    'issuance rejects caller-controlled %s',
    async (field) => {
      expect(await service.issue({ customerId, cartId, retryKey, [field]: 'forged' })).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
      });
      expect(await prisma.checkoutOperation.count({ where: { customerId } })).toBe(0);
    },
  );
  it.each(['', ' contains-space', 'a\nb', 'a'.repeat(129), 'é'])(
    'rejects invalid retry input %#',
    async (value) => {
      expect(await service.issue({ customerId, cartId, retryKey: value })).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
      });
    },
  );
});
