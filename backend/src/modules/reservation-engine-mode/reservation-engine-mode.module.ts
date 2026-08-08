import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module';
import { ReservationEngineModeConfigRepository } from './repositories/reservation-engine-mode-config.repository';
import { ReservationAvailabilityService } from './services/reservation-availability.service';
import { ReservationEngineModeService } from './services/reservation-engine-mode.service';

// Phase 16A.0-C, Units C1 (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md,
// Decision 8) and C2 (mode-aware availability). Additive and unwired - not
// imported by AppModule, CartModule, OrdersModule, or any other production
// module.
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
