import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

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
