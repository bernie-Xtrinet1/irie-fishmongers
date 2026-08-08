import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InventoryController } from './controllers/inventory.controller';
import { InventoryEventsRepository } from './repositories/inventory-events.repository';
import { CheckoutLeaseStateService } from './services/checkout-lease-state.service';
import { CheckoutPendingReconciliationService } from './services/checkout-pending-reconciliation.service';
import { CheckoutReservationRecoveryService } from './services/checkout-reservation-recovery.service';
import { CheckoutReservationStateService } from './services/checkout-reservation-state.service';
import { InventoryReconciliationService } from './services/inventory-reconciliation.service';
import { InventoryReservationsService } from './services/inventory-reservations.service';

// Deliberately does NOT import ProductsModule, CartModule, or OrdersModule -
// all three import *this* module instead, so the dependency graph only ever
// points one way. See the Phase 7 plan's "Avoiding circular module
// dependencies" section.
//
// Phase 16A.0-C, Unit C0 (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md):
// CheckoutReservationStateService/CheckoutLeaseStateService/
// CheckoutReservationRecoveryService/CheckoutPendingReconciliationService
// existed as unregistered classes (constructed directly in their own spec
// files, never through Nest DI) until this change - pure wiring, no
// behavior change. Still not imported by CartModule/OrdersModule/any
// production caller; only newly reachable via InventoryModule's DI graph
// for a future consumer (CheckoutReservationFacade, Phase C Unit C3) that
// does not exist yet.
@Module({
  imports: [AuthModule],
  controllers: [InventoryController],
  providers: [
    InventoryReservationsService,
    InventoryReconciliationService,
    InventoryEventsRepository,
    CheckoutReservationStateService,
    CheckoutLeaseStateService,
    CheckoutReservationRecoveryService,
    CheckoutPendingReconciliationService,
  ],
  exports: [
    InventoryReservationsService,
    InventoryEventsRepository,
    CheckoutReservationStateService,
    CheckoutLeaseStateService,
    CheckoutReservationRecoveryService,
    CheckoutPendingReconciliationService,
  ],
})
export class InventoryModule {}
