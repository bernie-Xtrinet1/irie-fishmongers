import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module';
import { MirrorCompensationModule } from '../mirror-compensation/mirror-compensation.module';
import { ReservationEngineModeModule } from '../reservation-engine-mode/reservation-engine-mode.module';
import { CheckoutReservationFacade } from './services/checkout-reservation-facade.service';
import { RESERVATION_GATEWAY } from './types/reservation-gateway.types';

// Phase 16A.0-C, Unit C3 (see ADR-007 and the approved C3 implementation
// contract). As of Phase 16A.0-DA, Unit DA.3, this module is imported by
// CartModule - CartService/CartReservationConvergenceService now depend
// on RESERVATION_GATEWAY instead of InventoryReservationsService directly.
// Not imported by AppModule/CheckoutController/any activation surface -
// LEGACY remains the only effective runtime mode (nothing calls
// setMode()).
//
// Phase 16A.0-DA, Unit DA.4: MirrorCompensationModule is now imported so
// CheckoutReservationFacade can record MIRROR-mode mirror-write failures
// via CompensationService.recordMirrorDivergence (previously computed,
// logged, and discarded - see the DA.4 read-only report). No cycle:
// MirrorCompensationModule imports CartRepositoryModule (not CartModule)
// as of this same unit specifically to keep this edge acyclic - see
// MirrorCompensationModule's own doc comment.
//
// CheckoutReservationFacade is a provider but deliberately NOT exported -
// it is resolvable within this module (including via RESERVATION_GATEWAY's
// useExisting binding) but unreachable by any module that only imports
// CheckoutReservationModule. The supported external dependency boundary is
// the RESERVATION_GATEWAY token/ReservationGateway interface, never the
// concrete class.
@Module({
  imports: [InventoryModule, ReservationEngineModeModule, MirrorCompensationModule],
  providers: [
    CheckoutReservationFacade,
    { provide: RESERVATION_GATEWAY, useExisting: CheckoutReservationFacade },
  ],
  exports: [RESERVATION_GATEWAY],
})
export class CheckoutReservationModule {}
