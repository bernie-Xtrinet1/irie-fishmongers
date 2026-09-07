import { Prisma } from '@prisma/client';
import { Redis } from 'ioredis';

import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { PriceLockRepository } from '../../price-lock/repositories/price-lock.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { ReservationEngineModeConfigRepository } from '../../reservation-engine-mode/repositories/reservation-engine-mode-config.repository';
import {
  productTotalKey,
  reservationKey,
  reservationHashKey,
  productSuspectKey,
} from '../../inventory/constants/inventory.constants';
import { connectRealRedis } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import {
  CompensationTestFixture,
  seedCartAndProduct,
  setUpCompensationFixture,
  tearDownCompensationFixture,
} from '../../mirror-compensation/repositories/compensation-repository-test-helpers';
import { CheckoutShadowReadService } from './checkout-shadow-read.service';
import { CheckoutShadowComparisonService } from './checkout-shadow-comparison.service';
import { CheckoutRolloutTelemetryService } from './checkout-rollout-telemetry.service';

// Uses the established UUID-scoped fixture/cleanup mechanism, never a table reset.
// Run only with disposable test Postgres and Redis configuration, like the
// existing reservation integration suites. No shared DB or Redis flush here.
describe('Checkout shadow real persistence non-mutation', () => {
  const prisma = new PrismaService();
  let redis: Redis;
  let fixture: CompensationTestFixture;
  let ids: Awaited<ReturnType<typeof seedCartAndProduct>>;
  let keys: string[];
  beforeAll(async () => {
    await prisma.$connect();
    redis = await connectRealRedis();
    fixture = await setUpCompensationFixture(prisma);
    ids = await seedCartAndProduct(fixture);
    await prisma.cart.update({ where: { id: ids.cartId }, data: { currency: 'JMD' } });
    await prisma.cartItem.create({
      data: {
        cartId: ids.cartId,
        productId: ids.productId,
        quantity: 2,
        lockedUnitPrice: new Prisma.Decimal(850),
        lockedCurrency: 'JMD',
        priceLockedAt: new Date(),
      },
    });
    keys = [
      reservationKey(ids.cartId, ids.productId),
      productTotalKey(ids.productId),
      reservationHashKey(ids.productId),
      productSuspectKey(ids.productId),
    ];
  });
  afterAll(async () => {
    if (keys) await redis.del(...keys);
    if (fixture) await tearDownCompensationFixture(fixture);
    if (redis) await redis.quit();
    await prisma.$disconnect();
  });

  async function snapshot() {
    return {
      cart: await prisma.cart.findUnique({ where: { id: ids.cartId }, include: { items: true } }),
      product: await prisma.product.findUnique({ where: { id: ids.productId } }),
      orders: await prisma.order.findMany({
        where: { customerId: ids.customerId },
        include: { payment: true },
      }),
      attempts: await prisma.checkoutAttempt.findMany({ where: { customerId: ids.customerId } }),
      modes: await prisma.reservationEngineModeConfig.findMany({ orderBy: { revision: 'asc' } }),
      participants: await prisma.checkoutRolloutParticipant.findMany({
        where: { customerId: ids.customerId },
      }),
      own: await redis.get(keys[0]!),
      total: await redis.get(keys[1]!),
      legacy: await redis.hgetall(keys[2]!),
      suspect: await redis.get(keys[3]!),
    };
  }

  it.each(['ACTIVE', 'EXPIRED', 'MALFORMED', 'SUSPECT'])(
    'leaves all state unchanged for %s with SQL writes forbidden',
    async (scenario) => {
      await redis.set(
        keys[0]!,
        scenario === 'MALFORMED'
          ? '{malformed'
          : JSON.stringify({
              version: 1,
              cartId: ids.cartId,
              customerId: ids.customerId,
              quantity: 2,
              status: 'ACTIVE',
              expiresAt: scenario === 'EXPIRED' ? 0 : Date.now() + 60000,
            }),
      );
      await redis.set(keys[1]!, '5');
      await redis.hset(
        keys[2]!,
        'other',
        JSON.stringify({ quantity: 3, expiresAt: Date.now() + 60000 }),
      );
      if (scenario === 'SUSPECT') await redis.set(keys[3]!, '1');
      const before = await snapshot();
      const forbiddenRedis = jest.fn();
      const readClient = new Proxy(redis, {
        get(target, property): unknown {
          if (property === 'get') return target.get.bind(target);
          if (property === 'hgetall') return target.hgetall.bind(target);
          forbiddenRedis(property);
          throw new Error('Redis mutation/capability forbidden');
        },
      });
      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const client = tx as PrismaService;
        const reader = new CheckoutShadowReadService(
          new CartRepository(client),
          new PriceLockRepository(client),
          new ProductsRepository(client),
          new ReservationEngineModeConfigRepository(client),
          new RedisService(readClient),
        );
        const telemetry = {
          recordShadowComparison: jest.fn(),
        } as unknown as CheckoutRolloutTelemetryService;
        return new CheckoutShadowComparisonService(reader, telemetry).compare({
          authenticatedCustomerId: ids.customerId,
          cartId: ids.cartId,
        });
      });
      expect(result.status).toBe(scenario === 'ACTIVE' ? 'MATCH' : 'UNAVAILABLE');
      expect(result.reasonCode).toBe(
        {
          ACTIVE: 'MATCH',
          EXPIRED: 'RESERVATION_EXPIRED',
          MALFORMED: 'RESERVATION_STATE_INVALID',
          SUSPECT: 'RESERVATION_SUSPECT',
        }[scenario],
      );
      expect(forbiddenRedis).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    },
  );
});
