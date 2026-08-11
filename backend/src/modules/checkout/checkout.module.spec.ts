import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';

import { REDIS_CLIENT } from '../../common/redis/redis.constants';
import { RedisModule } from '../../common/redis/redis.module';
import { validateEnv } from '../../config/env.validation';
import { PrismaService } from '../../database/prisma.service';
import { PrismaModule } from '../../database/prisma.module';
import { OrdersService } from '../orders/services/orders.service';
import { CheckoutModule } from './checkout.module';
import { CheckoutCoordinatorService } from './services/checkout-coordinator.service';

// Phase 16A.0-D, Unit D.4. Proves CheckoutModule's real module graph -
// not AppModule, not manual `new` construction as D.3's integration helper
// does - resolves CheckoutCoordinatorService end-to-end, including across
// the OrdersModule module boundary this unit added (OrdersService was
// previously a provider-only, unexported class; this is the first consumer
// that needs it through Nest DI). If OrdersModule's export of OrdersService
// were ever removed, or if CheckoutModule's own import list were wrong,
// compile() below would fail with a "can't resolve dependencies" error -
// that failure mode is exactly what this test guards against.
//
// ConfigModule, PrismaModule, EventEmitterModule.forRoot(), and RedisModule
// are included only because this isolated test compiles outside AppModule,
// which normally supplies them as global application infrastructure - see
// prisma.module.ts (@Global) and redis.module.ts (@Global). ConfigModule is
// needed transitively (AuthModule -> TokenService -> ConfigService, pulled
// in via InventoryModule's/OrdersModule's/PaymentsModule's own AuthModule
// imports) - discovered directly by a failing compile() without it.
// CheckoutModule itself does not import or own any of these four.
//
// This test only proves module-boundary DI resolution, not database/Redis
// integration (that's D.3's job against real infrastructure), so both
// PrismaService and the raw REDIS_CLIENT are overridden with inert stubs
// scoped to this test root only - PrismaModule/PrismaService/RedisModule
// production code is untouched. Both stubs implement exactly the lifecycle
// method their real class uses in onModuleDestroy (jest.fn(), zero network
// I/O), so moduleRef.close() below can run cleanly instead of being skipped.
describe('CheckoutModule (DI boundary)', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('resolves CheckoutCoordinatorService through the real module graph', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        PrismaModule,
        EventEmitterModule.forRoot(),
        RedisModule,
        CheckoutModule,
      ],
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ disconnect: jest.fn() })
      .overrideProvider(PrismaService)
      .useValue({ $connect: jest.fn(), $disconnect: jest.fn(), onModuleDestroy: jest.fn() })
      .compile();

    const coordinator = moduleRef.get(CheckoutCoordinatorService);
    expect(coordinator).toBeDefined();
    expect(coordinator).toBeInstanceOf(CheckoutCoordinatorService);

    // OrdersService resolves purely because OrdersModule exports it and
    // CheckoutModule imports OrdersModule - CheckoutModule never registers
    // OrdersService as its own provider (see checkout.module.ts), so this
    // is the sole instance reachable in the graph, not a duplicate. Never
    // overridden - this is the real, DI-constructed OrdersService.
    const ordersServiceA = moduleRef.get(OrdersService);
    const ordersServiceB = moduleRef.get(OrdersService);
    expect(ordersServiceA).toBeDefined();
    expect(ordersServiceA).toBeInstanceOf(OrdersService);
    expect(ordersServiceA).toBe(ordersServiceB); // same singleton, not duplicated
  });
});
