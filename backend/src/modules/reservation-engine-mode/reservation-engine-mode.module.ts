import { Module } from '@nestjs/common';

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
@Module({
  imports: [InventoryModule],
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
