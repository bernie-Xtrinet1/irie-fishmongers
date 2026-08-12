import { Module } from '@nestjs/common';

import { CartRepository } from '../cart/repositories/cart.repository';
import { InventoryModule } from '../inventory/inventory.module';
import { CartReservationSyncStateRepository } from './repositories/cart-reservation-sync-state.repository';
import { CartReservationSyncRecoveryService } from './services/cart-reservation-sync-recovery.service';

// Phase 16A.0-DA, Unit DA.1A/DA.1B (see the DA.1 architecture review and
// the DA.1B claim-fencing review). Owns the CartReservationSyncState
// marker table - the durable record of desired Redis reservation state
// per (cartId, productId) pair - plus DA.1B's recovery-worker service for
// rows DA.1A's own synchronous convergence left unresolved.
//
// CartRepository is declared directly as this module's OWN provider
// (deliberate, documented duplication) rather than importing CartModule:
// CartModule already imports CartReservationSyncModule (for DA.1A's own
// marker writes), so importing CartModule back here would create a real
// cycle (CartModule -> CartReservationSyncModule -> CartModule). This is
// safe specifically because CartRepository is stateless - its only
// runtime dependency is the global PrismaService - so a second DI
// instance is not a second source of truth, just a second lightweight
// wrapper around the same Prisma client. CartService itself is
// deliberately NOT duplicated or otherwise reachable from here; DA.1B
// never invokes business logic, only CartRepository's read-only
// findItemByCartAndProduct. InventoryModule is imported normally (no
// cycle risk: InventoryModule deliberately imports nothing from the
// Cart/Product/Order side, so the dependency graph only ever points one
// way - see InventoryModule's own doc comment).
@Module({
  imports: [InventoryModule],
  providers: [CartReservationSyncStateRepository, CartRepository, CartReservationSyncRecoveryService],
  exports: [CartReservationSyncStateRepository, CartReservationSyncRecoveryService],
})
export class CartReservationSyncModule {}
