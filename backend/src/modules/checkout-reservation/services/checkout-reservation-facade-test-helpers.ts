import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { ReservationAvailabilityService } from '../../reservation-engine-mode/services/reservation-availability.service';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CompensationService } from '../../mirror-compensation/services/compensation.service';
import { ReservationGateway } from '../types/reservation-gateway.types';
import { CheckoutReservationFacade } from './checkout-reservation-facade.service';

// Phase 16A.0-DA, Unit DA.3 (see the DA.3 frozen plan). Builds a REAL
// CheckoutReservationFacade pinned to LEGACY mode - never a mock of the
// ReservationGateway interface - so every test using it exercises the
// actual mode-routing code CartService now depends on, not a stand-in for
// it. modeService.getCurrentMode() is the only method the facade ever
// calls on it, so a minimal stub (never LEGACY-mode-only setMode/
// verifyRollbackSafe machinery) is sufficient and avoids requiring a real
// PrismaService/RedisService/ReservationEngineModeConfigRepository just to
// stand up a test fixture that will only ever observe LEGACY - matching
// this unit's own "LEGACY remains the only effective mode" constraint.
//
// Phase 16A.0-DA, Unit DA.4: CompensationService is a required constructor
// param as of this unit, but LEGACY mode never calls recordMirrorDivergence
// (only the MIRROR branch does) - an unimplemented stub is sufficient and
// avoids requiring a real CompensationRepository/PrismaService just for a
// fixture that will only ever observe LEGACY.
export function buildLegacyReservationGateway(
  inventoryReservations: InventoryReservationsService,
): ReservationGateway {
  const modeService = { getCurrentMode: () => Promise.resolve('LEGACY') } as unknown as ReservationEngineModeService;
  const availability = new ReservationAvailabilityService(modeService, inventoryReservations);
  const compensation = {} as CompensationService;
  return new CheckoutReservationFacade(modeService, inventoryReservations, availability, compensation);
}
