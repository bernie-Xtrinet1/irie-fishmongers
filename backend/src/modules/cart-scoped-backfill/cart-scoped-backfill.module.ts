import { Module } from '@nestjs/common';

import { CartRepositoryModule } from '../cart/cart-repository.module';
import { CartReservationSyncModule } from '../cart-reservation-sync/cart-reservation-sync.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReservationRecoveryModule } from '../reservation-recovery/reservation-recovery.module';
import { CartScopedBackfillService } from './services/cart-scoped-backfill.service';
import { CartScopedOrphanReleaseService } from './services/cart-scoped-orphan-release.service';

// CART_SCOPED activation-boundary gate (see the gate design review's
// direct-backfill design). RedisService is available via RedisModule's own
// @Global() registration, needing no explicit import here (matching every
// other consumer of it in this codebase). CartRepositoryModule/
// CartReservationSyncModule/InventoryModule/ReservationRecoveryModule are
// all confirmed leaves w.r.t. this module - importing this module from the
// CLI orchestrator (the only intended consumer; see that script's own
// comment) introduces no cycle.
@Module({
  imports: [CartRepositoryModule, CartReservationSyncModule, InventoryModule, ReservationRecoveryModule],
  providers: [CartScopedBackfillService, CartScopedOrphanReleaseService],
  exports: [CartScopedBackfillService, CartScopedOrphanReleaseService],
})
export class CartScopedBackfillModule {}
