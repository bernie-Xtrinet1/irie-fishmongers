import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';

import { REDIS_CLIENT } from '../common/redis/redis.constants';
import { PrismaService } from '../database/prisma.service';
import { CartMutationBarrierService } from '../modules/cart-mutation-barrier/services/cart-mutation-barrier.service';
import { CartReservationSyncRecoveryService } from '../modules/cart-reservation-sync/services/cart-reservation-sync-recovery.service';
import { CartScopedBackfillService } from '../modules/cart-scoped-backfill/services/cart-scoped-backfill.service';
import { CartScopedOrphanReleaseService } from '../modules/cart-scoped-backfill/services/cart-scoped-orphan-release.service';
import { CompensationBatchService } from '../modules/mirror-compensation/services/compensation-batch.service';
import { ReservationEngineModeService } from '../modules/reservation-engine-mode/services/reservation-engine-mode.service';
import { CutoverOrchestrationModule } from './cutover-orchestration.module';

// CART_SCOPED activation-boundary gate - CLI boot regression guard (staging
// rehearsal finding, 2026-08-16). Proves the CLI's OWN bootstrap module can
// resolve its full dependency graph standalone - exactly what
// NestFactory.createApplicationContext(CutoverOrchestrationModule) does in
// activate-cart-scoped-mode.ts / lift-cart-mutation-barrier.ts - WITHOUT
// AppModule supplying any global infrastructure.
//
// The regression this guards: CutoverOrchestrationModule transitively imports
// InventoryModule -> AuthModule -> AuthService, and AuthService's constructor
// requires EventEmitter2. EventEmitter2 is provided only by
// EventEmitterModule.forRoot(), which was registered solely in AppModule until
// this module was fixed to register it itself. Without that registration
// compile() below throws UnknownDependenciesException (AuthService @ index 4:
// EventEmitter) - the exact error the rehearsal hit at
// NestFactory.createApplicationContext, before Step 1 of the cutover. This
// spec is DELIBERATELY imported as `[CutoverOrchestrationModule]` alone (never
// with EventEmitterModule added to the test harness): adding it here would
// mask the very regression under test by supplying the dependency the module
// must provide for itself.
//
// Only REDIS_CLIENT and PrismaService are overridden - inert stubs so this
// stays a pure DI-boundary compile test (no Postgres/Redis I/O), matching the
// established checkout.module.spec.ts precedent. Env is supplied by
// jest.setup.ts's dotenv load of backend/.env, which satisfies validateEnv.
describe('CutoverOrchestrationModule (standalone DI boot)', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('resolves its full graph without AppModule - including EventEmitter2 (the boot-regression dependency)', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [CutoverOrchestrationModule],
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ disconnect: jest.fn() })
      .overrideProvider(PrismaService)
      .useValue({ $connect: jest.fn(), $disconnect: jest.fn(), onModuleDestroy: jest.fn() })
      .compile();

    // The dependency whose absence broke the boot: if EventEmitterModule.forRoot()
    // is not registered by CutoverOrchestrationModule itself, compile() above
    // never reaches this line.
    expect(moduleRef.get(EventEmitter2)).toBeInstanceOf(EventEmitter2);

    // Every service the activation/lift CLI actually retrieves via app.get()
    // (see activate-cart-scoped-mode.ts) must resolve through the standalone
    // graph - a faithful proxy for "the CLI can boot and obtain everything it
    // needs".
    expect(moduleRef.get(CartMutationBarrierService)).toBeInstanceOf(CartMutationBarrierService);
    expect(moduleRef.get(CartReservationSyncRecoveryService)).toBeInstanceOf(CartReservationSyncRecoveryService);
    expect(moduleRef.get(CompensationBatchService)).toBeInstanceOf(CompensationBatchService);
    expect(moduleRef.get(CartScopedBackfillService)).toBeInstanceOf(CartScopedBackfillService);
    expect(moduleRef.get(CartScopedOrphanReleaseService)).toBeInstanceOf(CartScopedOrphanReleaseService);
    expect(moduleRef.get(ReservationEngineModeService)).toBeInstanceOf(ReservationEngineModeService);
  });
});
