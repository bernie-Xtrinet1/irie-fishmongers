import { Module } from '@nestjs/common';

import { CartRepository } from '../cart/repositories/cart.repository';
import { InventoryModule } from '../inventory/inventory.module';
import { ReservationEngineModeModule } from '../reservation-engine-mode/reservation-engine-mode.module';
import { ReservationRecoveryModule } from '../reservation-recovery/reservation-recovery.module';
import { CartReservationSyncStateRepository } from './repositories/cart-reservation-sync-state.repository';
import { CartReservationSyncBlockedRecheckService } from './services/cart-reservation-sync-blocked-recheck.service';
import { CartReservationSyncRecoveryService } from './services/cart-reservation-sync-recovery.service';

// Phase 16A.0-DA, Unit DA.1A/DA.1B (see the DA.1 architecture review and
// the DA.1B claim-fencing review), extended in Unit DA.4B (see the DA.4B
// frozen plan). Owns the CartReservationSyncState marker table - the
// durable record of desired reservation state per (cartId, productId)
// pair - plus the recovery-worker services for rows DA.1A's own
// synchronous convergence left unresolved.
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
// deliberately NOT duplicated or otherwise reachable from here; the
// recovery services never invoke business logic, only CartRepository's
// read-only findItemByCartAndProduct/findById.
//
// InventoryModule/ReservationEngineModeModule/ReservationRecoveryModule
// are imported normally - no cycle risk: none of the three imports
// anything from the Cart/Order side (see each module's own doc comment),
// so the dependency graph only ever points one way.
// CartReservationSyncBlockedRecheckService needs InventoryReservationsService
// directly (reconcileProductReservedTotal - not part of
// ReservationRecoveryTarget's contract) and ReservationEngineModeService
// directly (a plain getCurrentMode() read - a recheck never performs the
// locked terminal resolution, so it needs no lock-aware method).
// CartReservationSyncRecoveryService needs ReservationEngineModeService
// directly too, for verifyModeRevisionUnchanged - ReservationRecoveryModule
// alone would not re-export it (NestJS module encapsulation).
@Module({
  imports: [InventoryModule, ReservationEngineModeModule, ReservationRecoveryModule],
  providers: [
    CartReservationSyncStateRepository,
    CartRepository,
    CartReservationSyncBlockedRecheckService,
    CartReservationSyncRecoveryService,
  ],
  exports: [CartReservationSyncStateRepository, CartReservationSyncRecoveryService],
})
export class CartReservationSyncModule {}
