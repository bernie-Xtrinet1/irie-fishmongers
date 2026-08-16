import { Module } from '@nestjs/common';

import { CartMutationBarrierModule } from '../cart-mutation-barrier/cart-mutation-barrier.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReservationEngineModeConfigRepository } from './repositories/reservation-engine-mode-config.repository';
import { ReservationAvailabilityService } from './services/reservation-availability.service';
import { ReservationEngineModeService } from './services/reservation-engine-mode.service';

// Phase 16A.0-C, Units C1 (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md,
// Decision 8) and C2 (mode-aware availability). Reached transitively via
// CheckoutReservationModule as of Phase 16A.0-DA, Unit DA.3 (CartModule ->
// CheckoutReservationModule -> this module). Not imported by AppModule,
// OrdersModule, or any activation surface - nothing calls setMode().
//
// CART_SCOPED activation-boundary gate: CartMutationBarrierModule is a
// confirmed leaf (no imports of its own) - importing it here, in addition
// to CartModule's own separate direct import, introduces no cycle and no
// duplicate instance (Nest resolves a module imported from multiple
// places to one shared singleton, exactly like InventoryModule elsewhere
// in this graph). ReservationEngineModeService needs
// CartMutationBarrierConfigRepository for a single plain read inside
// setMode's own locked transaction - never the barrier service's own
// lock-acquiring methods.
@Module({
  imports: [InventoryModule, CartMutationBarrierModule],
  providers: [
    ReservationEngineModeService,
    ReservationEngineModeConfigRepository,
    ReservationAvailabilityService,
  ],
  exports: [
    ReservationEngineModeService,
    ReservationEngineModeConfigRepository,
    ReservationAvailabilityService,
  ],
})
export class ReservationEngineModeModule {}
