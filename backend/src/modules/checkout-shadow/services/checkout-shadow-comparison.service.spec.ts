import { Prisma } from '@prisma/client';
import { Redis } from 'ioredis';

import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { PriceLockRepository } from '../../price-lock/repositories/price-lock.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { ReservationEngineModeConfigRepository } from '../../reservation-engine-mode/repositories/reservation-engine-mode-config.repository';
import {
  productSuspectKey,
  productTotalKey,
  reservationKey,
} from '../../inventory/constants/inventory.constants';
import { CheckoutShadowReadService } from './checkout-shadow-read.service';
import { CheckoutShadowComparisonService } from './checkout-shadow-comparison.service';
import { CheckoutRolloutTelemetryService } from './checkout-rollout-telemetry.service';

describe('Checkout shadow comparison and non-mutation contract', () => {
  const context = { authenticatedCustomerId: 'customer', cartId: 'cart' };
  let cart: { id: string; customerId: string; currency: string | null } | null;
  let items: {
    id: string;
    productId: string;
    quantity: number;
    lockedUnitPrice: Prisma.Decimal | null;
    lockedCurrency: string | null;
    priceLockedAt: Date | null;
  }[];
  let product: {
    id: string;
    isActive: boolean;
    quantityAvailable: number;
    price: Prisma.Decimal;
    currency: string;
  } | null;
  let mode: { mode: string } | null;
  let legacy: Record<string, string>;
  let redisState: Record<string, string | null>;
  let service: CheckoutShadowComparisonService;
  let telemetry: jest.Mock;
  let forbidden: jest.Mock;
  let reads: CheckoutShadowReadService;
  let calls: string[];

  // Real repository/RedisService code runs. Anything except explicitly allowed
  // SELECT, GET and HGETALL capabilities fails and records the attempted access.
  function guard<T extends object>(allowed: T, prefix: string): T {
    return new Proxy(allowed, {
      get(target, property, receiver): unknown {
        if (typeof property === 'symbol') return Reflect.get(target, property, receiver);
        if (!(property in target)) {
          forbidden(`${prefix}.${property}`);
          throw new Error('Forbidden dependency access');
        }
        calls.push(`${prefix}.${property}`);
        return Reflect.get(target, property, receiver);
      },
    });
  }
  function own(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      version: 1,
      cartId: 'cart',
      customerId: 'customer',
      quantity: 2,
      expiresAt: Date.now() + 60000,
      status: 'ACTIVE',
      ...overrides,
    });
  }
  beforeEach(() => {
    cart = { id: 'cart', customerId: 'customer', currency: 'JMD' };
    items = [
      {
        id: 'item',
        productId: 'product',
        quantity: 2,
        lockedUnitPrice: new Prisma.Decimal(850),
        lockedCurrency: 'JMD',
        priceLockedAt: new Date(),
      },
    ];
    product = {
      id: 'product',
      isActive: true,
      quantityAvailable: 10,
      price: new Prisma.Decimal(850),
      currency: 'JMD',
    };
    mode = { mode: 'MIRROR' };
    legacy = { other: JSON.stringify({ quantity: 3, expiresAt: Date.now() + 60000 }) };
    redisState = {
      [reservationKey('cart', 'product')]: own(),
      [productTotalKey('product')]: '5',
      [productSuspectKey('product')]: null,
    };
    calls = [];
    forbidden = jest.fn();
    const prisma = guard(
      {
        cart: guard(
          { findUnique: jest.fn().mockImplementation(() => Promise.resolve(cart)) },
          'cart',
        ),
        cartItem: guard(
          { findMany: jest.fn().mockImplementation(() => Promise.resolve(items)) },
          'cartItem',
        ),
        product: guard(
          { findUnique: jest.fn().mockImplementation(() => Promise.resolve(product)) },
          'product',
        ),
        reservationEngineModeConfig: guard(
          { findFirst: jest.fn().mockImplementation(() => Promise.resolve(mode)) },
          'mode',
        ),
      },
      'prisma',
    ) as unknown as PrismaService;
    const redis = guard(
      {
        get: jest
          .fn()
          .mockImplementation((key: string) => Promise.resolve(redisState[key] ?? null)),
        hgetall: jest.fn().mockImplementation(() => Promise.resolve(legacy)),
      },
      'redis',
    ) as unknown as Redis;
    reads = new CheckoutShadowReadService(
      new CartRepository(prisma),
      new PriceLockRepository(prisma),
      new ProductsRepository(prisma),
      new ReservationEngineModeConfigRepository(prisma),
      new RedisService(redis),
    );
    telemetry = jest.fn();
    service = new CheckoutShadowComparisonService(reads, {
      recordShadowComparison: telemetry,
    } as unknown as CheckoutRolloutTelemetryService);
  });
  afterEach(() => {
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('matches equivalent observations using persisted quantities and prices without mutation', async () => {
    const before = JSON.stringify({ cart, items, product, mode, redisState, legacy });
    expect(await service.compare(context)).toEqual({
      status: 'MATCH',
      reasonCode: 'MATCH',
      engineMode: 'MIRROR',
      checkoutEligibility: 'UNAVAILABLE',
      comparisons: [
        {
          line: 0,
          requested: 2,
          stock: 10,
          legacyAvailable: 7,
          cartScopedAvailable: 7,
          legacyAdmissible: true,
          cartScopedAdmissible: true,
          priceEqual: true,
        },
      ],
    });
    expect(JSON.stringify({ cart, items, product, mode, redisState, legacy })).toBe(before);
    expect(new Set(calls)).toEqual(
      new Set([
        'prisma.cart',
        'cart.findUnique',
        'prisma.cartItem',
        'cartItem.findMany',
        'prisma.product',
        'product.findUnique',
        'prisma.reservationEngineModeConfig',
        'mode.findFirst',
        'redis.get',
        'redis.hgetall',
      ]),
    );
    expect(telemetry).toHaveBeenCalledTimes(1);
  });
  it('reports bounded mismatch when only cart-scoped availability rejects the quantity', async () => {
    redisState[productTotalKey('product')] = '11';
    expect(await service.compare(context)).toMatchObject({
      status: 'MISMATCH',
      reasonCode: 'AVAILABILITY_DIFFERS',
      comparisons: [{ legacyAdmissible: true, cartScopedAdmissible: false }],
    });
  });
  it('reports legacy-only insufficient availability', async () => {
    legacy.other = JSON.stringify({ quantity: 9, expiresAt: Date.now() + 60000 });
    expect(await service.compare(context)).toMatchObject({
      status: 'MISMATCH',
      comparisons: [{ legacyAdmissible: false, cartScopedAdmissible: true }],
    });
  });
  it('does not turn a MATCH where both sides reject into an admission grant', async () => {
    items[0]!.quantity = 8;
    expect(await service.compare(context)).toMatchObject({
      status: 'MATCH',
      checkoutEligibility: 'UNAVAILABLE',
      comparisons: [{ legacyAdmissible: false, cartScopedAdmissible: false }],
    });
  });
  it.each(['LEGACY', 'MIRROR', 'CART_SCOPED'])(
    'observes %s without choosing a path',
    async (value) => {
      mode = { mode: value };
      expect(await service.compare(context)).toMatchObject({ status: 'MATCH', engineMode: value });
    },
  );
  it('defaults absent config to legacy and never creates it', async () => {
    mode = null;
    expect(await service.compare(context)).toMatchObject({ status: 'MATCH', engineMode: 'LEGACY' });
  });
  it('does not observe an unowned cart or trust additional client flags', async () => {
    const result = await service.compare({
      ...context,
      authenticatedCustomerId: 'other',
      enabled: true,
      cohort: 'pilot',
    } as typeof context);
    expect(result).toMatchObject({ status: 'UNAVAILABLE', reasonCode: 'OWNERSHIP_MISMATCH' });
    expect(calls).toEqual(['prisma.cart', 'cart.findUnique']);
  });
  it.each([
    ['cart', 'CART_MISSING'],
    ['items', 'CART_EMPTY'],
    ['product', 'PRODUCT_MISSING'],
    ['inactive', 'PRODUCT_INACTIVE'],
    ['quantity', 'MISSING_REQUIRED_READ_DATA'],
    ['draining', 'MODE_NOT_ADMITTING'],
    ['missing-own', 'NO_COMPARABLE_CART_SCOPED_STATE'],
    ['missing-total', 'NO_COMPARABLE_CART_SCOPED_STATE'],
    ['suspect', 'RESERVATION_SUSPECT'],
    ['missing-price', 'PRICE_LOCK_REQUIRED'],
    ['partial-price', 'PRICE_LOCK_INVALID'],
    ['currency', 'PRICE_LOCK_INVALID'],
    ['expired-price', 'PRICE_LOCK_EXPIRED'],
  ])('returns bounded unavailable for %s with no writes', async (scenario, reasonCode) => {
    if (scenario === 'cart') cart = null;
    if (scenario === 'items') items = [];
    if (scenario === 'product') product = null;
    if (scenario === 'inactive') product!.isActive = false;
    if (scenario === 'quantity') items[0]!.quantity = NaN;
    if (scenario === 'draining') mode = { mode: 'DRAINING' };
    if (scenario === 'missing-own') redisState[reservationKey('cart', 'product')] = null;
    if (scenario === 'missing-total') redisState[productTotalKey('product')] = null;
    if (scenario === 'suspect') redisState[productSuspectKey('product')] = '1';
    if (scenario === 'missing-price')
      Object.assign(items[0]!, {
        lockedUnitPrice: null,
        lockedCurrency: null,
        priceLockedAt: null,
      });
    if (scenario === 'partial-price') items[0]!.lockedCurrency = null;
    if (scenario === 'currency') cart!.currency = null;
    if (scenario === 'expired-price') items[0]!.priceLockedAt = new Date(0);
    const before = JSON.stringify({ cart, items, product, mode, redisState, legacy });
    expect(await service.compare(context)).toMatchObject({ status: 'UNAVAILABLE', reasonCode });
    expect(JSON.stringify({ cart, items, product, mode, redisState, legacy })).toBe(before);
  });
  it.each([
    [{ version: 2 }, 'RESERVATION_STATE_INVALID'],
    [{ quantity: -1 }, 'RESERVATION_STATE_INVALID'],
    [{ customerId: 'other' }, 'RESERVATION_STATE_INVALID'],
    [{ cartId: 'other' }, 'RESERVATION_STATE_INVALID'],
    [{ expiresAt: 0 }, 'RESERVATION_EXPIRED'],
    [{ status: 'CHECKOUT_PENDING' }, 'CHECKOUT_PENDING_NOT_COMPARED'],
  ])(
    'never repairs or releases an invalid/expired/pending own entry %j',
    async (overrides, reasonCode) => {
      redisState[reservationKey('cart', 'product')] = own(overrides);
      const before = JSON.stringify(redisState);
      expect(await service.compare(context)).toMatchObject({ status: 'UNAVAILABLE', reasonCode });
      expect(JSON.stringify(redisState)).toBe(before);
    },
  );
  it.each(['{bad', 'null', '[]'])('never flags malformed own JSON %s', async (raw) => {
    redisState[reservationKey('cart', 'product')] = raw;
    expect(await service.compare(context)).toMatchObject({
      reasonCode: 'RESERVATION_STATE_INVALID',
    });
    expect(redisState[reservationKey('cart', 'product')]).toBe(raw);
  });
  it.each(['', 'NaN', '-1', '1', 'Infinity'])('rejects untrustworthy total %s', async (raw) => {
    redisState[productTotalKey('product')] = raw;
    expect(await service.compare(context)).toMatchObject({
      reasonCode: 'RESERVATION_STATE_INVALID',
    });
  });
  it('ignores expired legacy entries without deleting them and excludes own holds', async () => {
    legacy.expired = JSON.stringify({ quantity: 100, expiresAt: 0 });
    legacy.cart = JSON.stringify({ quantity: 20, expiresAt: Date.now() + 60000 });
    expect(await service.compare(context)).toMatchObject({ status: 'MATCH' });
    expect(Object.keys(legacy)).toHaveLength(3);
  });
  it('rejects malformed legacy entries without deleting them', async () => {
    legacy.other = 'secret-invalid-json';
    expect(await service.compare(context)).toMatchObject({
      reasonCode: 'RESERVATION_STATE_INVALID',
    });
  });
  it('compares an existing valid lock to current product price without reissuing', async () => {
    product!.price = new Prisma.Decimal(851);
    expect(await service.compare(context)).toMatchObject({
      status: 'MISMATCH',
      reasonCode: 'PRICE_DIFFERS',
    });
    expect(items[0]!.lockedUnitPrice!.toString()).toBe('850');
  });
  it.each(['cart', 'lines', 'product', 'mode', 'reservations'] as const)(
    'isolates %s read failure without raw exception leaks',
    async (method) => {
      jest.spyOn(reads, method).mockRejectedValue(new Error('api-key=secret customer@example.com'));
      const result = await service.compare(context);
      expect(result).toEqual({
        status: 'ERROR',
        reasonCode: 'READ_FAILURE',
        engineMode: null,
        comparisons: [],
        checkoutEligibility: 'UNAVAILABLE',
      });
      expect(JSON.stringify(result)).not.toContain('secret');
    },
  );
  it('cannot propagate telemetry failure or change the observation', async () => {
    telemetry.mockImplementation(() => {
      throw new Error('logger failed');
    });
    await expect(service.compare(context)).resolves.toMatchObject({ status: 'MATCH' });
  });
});
