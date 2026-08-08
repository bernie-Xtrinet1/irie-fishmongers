import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module';
import { ReservationEngineModeConfigRepository } from './repositories/reservation-engine-mode-config.repository';
import { ReservationEngineModeService } from './services/reservation-engine-mode.service';

// Phase 16A.0-C, Unit C1 (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md,
// Decision 8). Additive and unwired - not imported by AppModule,
// CartModule, OrdersModule, or any other production module.
@Module({
  imports: [InventoryModule],
  providers: [ReservationEngineModeService, ReservationEngineModeConfigRepository],
  exports: [ReservationEngineModeService, ReservationEngineModeConfigRepository],
})
export class ReservationEngineModeModule {}
