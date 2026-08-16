import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { RedisModule } from '../common/redis/redis.module';
import { validateEnv } from '../config/env.validation';
import { PrismaModule } from '../database/prisma.module';
import { CartMutationBarrierModule } from '../modules/cart-mutation-barrier/cart-mutation-barrier.module';
import { CartReservationSyncModule } from '../modules/cart-reservation-sync/cart-reservation-sync.module';
import { CartScopedBackfillModule } from '../modules/cart-scoped-backfill/cart-scoped-backfill.module';
import { MirrorCompensationModule } from '../modules/mirror-compensation/mirror-compensation.module';
import { ReservationEngineModeModule } from '../modules/reservation-engine-mode/reservation-engine-mode.module';

// CART_SCOPED activation-boundary gate (see the gate design review's final
// approved design). A dedicated, minimal bootstrap module for the
// activate-cart-scoped-mode/lift-cart-mutation-barrier CLI scripts only -
// deliberately NOT AppModule. Booting the full application graph for a
// rare, dangerous, admin-only operational script would be both unnecessary
// (most of AppModule is irrelevant to this task) and riskier (implicitly
// coupling this script's dependency surface to whatever AppModule happens
// to import, rather than making it fully explicit here). This module is
// never imported by AppModule and exposes no controller - "do not expose
// CART_SCOPED activation through a controller or scheduler" is satisfied
// structurally, not by convention alone.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Rehearsal finding (staging, 2026-08-16): InventoryModule imports
    // AuthModule (for reasons unrelated to this CLI), which provides
    // AuthService, which needs EventEmitter2 - a provider only ever
    // registered via EventEmitterModule.forRoot() in AppModule until now.
    // Without this, NestFactory.createApplicationContext throws
    // UnknownDependenciesException and the CLI cannot boot in ANY
    // environment. Mirrors AppModule's own registration exactly.
    EventEmitterModule.forRoot(),
    PrismaModule,
    RedisModule,
    CartMutationBarrierModule,
    CartReservationSyncModule,
    CartScopedBackfillModule,
    MirrorCompensationModule,
    ReservationEngineModeModule,
  ],
})
export class CutoverOrchestrationModule {}
