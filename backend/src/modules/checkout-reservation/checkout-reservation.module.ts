import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module';
import { ReservationEngineModeModule } from '../reservation-engine-mode/reservation-engine-mode.module';
import { CheckoutReservationFacade } from './services/checkout-reservation-facade.service';
import { RESERVATION_GATEWAY } from './types/reservation-gateway.types';

// Phase 16A.0-C, Unit C3 (see ADR-007 and the approved C3 implementation
// contract). Additive and unwired - not imported by CartModule, AppModule,
// or any other production module.
//
// CheckoutReservationFacade is a provider but deliberately NOT exported -
// it is resolvable within this module (including via RESERVATION_GATEWAY's
// useExisting binding) but unreachable by any module that only imports
// CheckoutReservationModule. The supported external dependency boundary is
// the RESERVATION_GATEWAY token/ReservationGateway interface, never the
// concrete class.
@Module({
  imports: [InventoryModule, ReservationEngineModeModule],
  providers: [
    CheckoutReservationFacade,
    { provide: RESERVATION_GATEWAY, useExisting: CheckoutReservationFacade },
  ],
  exports: [RESERVATION_GATEWAY],
})
export class CheckoutReservationModule {}
